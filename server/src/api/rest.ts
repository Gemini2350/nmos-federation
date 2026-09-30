import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../config/store.js';
import type { Engine } from '../federation/engine.js';
import type { AppConfig } from '../config/schema.js';
import type { FederationDevice, VirtualReceiver } from '../types.js';
import { randomUUID } from 'node:crypto';
import { log } from '../util/log.js';

/**
 * REST + WebSocket for the GUI. Everything under /api, live events on /api/events.
 *
 *   GET/PUT  /api/config                       settings (domains, registries, NAT)
 *   POST     /api/config/validate              check without saving
 *   GET      /api/status                       registry/switch reachability, pool usage per domain
 *   GET      /api/channels                     channel table incl. pool addresses and errors
 *   POST     /api/channels/:receiverId/retry   rebuild a failed channel
 *   DELETE   /api/channels/:receiverId         tear down this receiver's federation
 *   GET/POST /api/devices, PUT/DELETE /api/devices/:id
 *   POST     /api/devices/:id/receivers        create virtual receivers (count, name pattern)
 *   DELETE   /api/receivers/:id
 *   POST     /api/switch/:fabric/probe         connectivity test
 *   POST     /api/reconcile                    run desired/actual reconciliation now
 *   WS       /api/events                       channel and status changes
 */
export function registerRestApi(app: FastifyInstance, store: ConfigStore, engine: Engine, onConfigChange: () => Promise<void>): void {
  app.get('/api/status', async () => engine.status());
  app.get('/api/config', async () => store.current);
  app.get('/api/channels', async () => engine.channels());

  app.post<{ Body: AppConfig }>('/api/config/validate', async (req) => ({ issues: store.validate(req.body) }));

  app.put<{ Body: AppConfig }>('/api/config', async (req, reply) => {
    try {
      const issues = await store.save(req.body);
      await onConfigChange();
      return { ok: true, issues };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // ---- Devices -----------------------------------------------------------
  app.get('/api/devices', async () =>
    store.current.devices.map((d) => ({ ...d, receivers: engine.receiversOf(d) })),
  );

  app.post<{ Body: Partial<FederationDevice> }>('/api/devices', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const device: FederationDevice = {
      id: req.body.id ?? randomUUID(),
      label: req.body.label ?? 'Federation Device',
      sourceDomain: req.body.sourceDomain ?? '',
      targetDomain: req.body.targetDomain ?? '',
      targetRegistries: req.body.targetRegistries ?? [],
      nat: req.body.nat ?? true,
      ...(req.body.mirrorLabel ? { mirrorLabel: req.body.mirrorLabel } : {}),
      receiverIds: [],
    };
    cfg.devices.push(device);
    try {
      await store.save(cfg);
      await onConfigChange();
      return device;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<FederationDevice> }>('/api/devices/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const i = cfg.devices.findIndex((d) => d.id === req.params.id);
    if (i < 0) return reply.code(404).send({ error: 'unknown device' });
    const before = cfg.devices[i]!;
    const after: FederationDevice = { ...before, ...req.body, id: req.params.id };
    cfg.devices[i] = after;

    // Changing NAT, the target domain or the target registries invalidates every
    // channel of this device: its multicast addresses, switch rules and published
    // sender were all derived from the old setting. Rebuild them instead of leaving
    // a channel behind that no longer matches its configuration.
    const rebuild =
      before.nat !== after.nat ||
      before.targetDomain !== after.targetDomain ||
      JSON.stringify(before.targetRegistries) !== JSON.stringify(after.targetRegistries);

    const affected = rebuild
      ? engine.channels().filter((c) => c.deviceId === after.id).map((c) => c.receiverId)
      : [];
    const connections = new Map(affected.map((rx) => [rx, engine.connectionOf(rx)]));
    for (const rx of affected) await engine.deactivate(rx);

    try {
      await store.save(cfg);
      await onConfigChange();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const failed: { receiverId: string; error: string }[] = [];
    for (const rx of affected) {
      const conn = connections.get(rx);
      if (!conn?.transport_file.data) continue;
      try {
        await engine.activate(rx, conn);
      } catch (e) {
        failed.push({ receiverId: rx, error: (e as Error).message });
      }
    }
    return { ...after, rebuilt: affected.length, failed };
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const victims = cfg.receivers.filter((r) => r.deviceId === req.params.id);
    for (const vrx of victims) await engine.deactivate(vrx.id);
    cfg.devices = cfg.devices.filter((d) => d.id !== req.params.id);
    cfg.receivers = cfg.receivers.filter((r) => r.deviceId !== req.params.id);
    try {
      await store.save(cfg);
      await onConfigChange();
      return { ok: true, removedReceivers: victims.length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Virtual receivers -------------------------------------------------
  app.post<{ Params: { id: string }; Body: { count?: number; pattern?: string; format?: VirtualReceiver['format'] } }>(
    '/api/devices/:id/receivers',
    async (req, reply) => {
      const cfg = structuredClone(store.current);
      const device = cfg.devices.find((d) => d.id === req.params.id);
      if (!device) return reply.code(404).send({ error: 'unknown device' });
      const count = Math.max(1, Math.min(256, req.body?.count ?? 1));
      const pattern = req.body?.pattern ?? `${device.label} {n}`;
      const format = req.body?.format ?? 'video';
      const existing = cfg.receivers.filter((r) => r.deviceId === device.id).length;
      const created: VirtualReceiver[] = [];
      for (let n = 1; n <= count; n++) {
        const vrx: VirtualReceiver = {
          id: randomUUID(),
          label: pattern.replace('{n}', String(existing + n)),
          deviceId: device.id,
          format,
          enabled: true,
        };
        cfg.receivers.push(vrx);
        device.receiverIds.push(vrx.id);
        created.push(vrx);
      }
      try {
        await store.save(cfg);
        await onConfigChange();
        return created;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/receivers/:id', async (req, reply) => {
    await engine.deactivate(req.params.id);
    const cfg = structuredClone(store.current);
    cfg.receivers = cfg.receivers.filter((r) => r.id !== req.params.id);
    for (const d of cfg.devices) d.receiverIds = d.receiverIds.filter((id) => id !== req.params.id);
    try {
      await store.save(cfg);
      await onConfigChange();
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Channels ----------------------------------------------------------
  app.delete<{ Params: { receiverId: string } }>('/api/channels/:receiverId', async (req) => {
    await engine.deactivate(req.params.receiverId);
    return { ok: true };
  });

  app.post<{ Params: { receiverId: string } }>('/api/channels/:receiverId/retry', async (req, reply) => {
    const conn = engine.connectionOf(req.params.receiverId);
    if (!conn?.transport_file.data) return reply.code(409).send({ error: 'no active SDP — make a connection first' });
    try {
      return await engine.activate(req.params.receiverId, conn);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // ---- Operations --------------------------------------------------------
  app.post<{ Params: { fabric: string } }>('/api/switch/:fabric/probe', async (req, reply) => {
    const result = await engine.probeSwitch(req.params.fabric);
    if (!result) return reply.code(404).send({ error: `no such fabric: ${req.params.fabric}` });
    return result;
  });

  app.post('/api/reconcile', async () => {
    await engine.reconcile();
    return { ok: true };
  });

  // ---- Live events -------------------------------------------------------
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (payload: unknown) => {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* connection gone */
      }
    };
    send({ type: 'hello', channels: engine.channels() });
    const off = engine.on((e) => send(e));
    socket.on('close', off);
    log.debug({}, 'GUI websocket connected');
  });
}
