import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../config/store.js';
import type { Engine } from '../federation/engine.js';
import type { AppConfig } from '../config/schema.js';
import type { FederationDevice, VirtualReceiver } from '../types.js';
import { randomUUID } from 'node:crypto';
import type { MirrorEntry } from '../config/schema.js';
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
 *   GET      /api/registries                   per-registry status
 *   POST     /api/registries/:id/probe          reachability test for one registry
 *   POST     /api/switch/:fabric/probe         connectivity test
 *   GET      /api/registries/:id/browse         list a registry's senders and receivers
 *   GET/POST /api/mirrors                      registry-to-registry copies
 *   DELETE   /api/mirrors/:id                  remove a copy and tear it down
 *   POST     /api/mirrors/:id/refresh          re-read the origin and rebuild
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
  app.get('/api/registries', async () => engine.registryStatus());

  app.post<{ Params: { id: string } }>('/api/registries/:id/probe', async (req, reply) => {
    const result = await engine.probeRegistry(req.params.id);
    if (!result) return reply.code(404).send({ error: `no registry ${req.params.id}, or it is disabled` });
    return result;
  });

  app.post<{ Params: { fabric: string } }>('/api/switch/:fabric/probe', async (req, reply) => {
    const result = await engine.probeSwitch(req.params.fabric);
    if (!result) return reply.code(404).send({ error: `no such fabric: ${req.params.fabric}` });
    return result;
  });

  // ---- Registry browsing and copies --------------------------------------
  /**
   * Lists what a registry holds, annotated with whether we already copied it.
   * Resources that belong to one of our own nodes are marked so the GUI can keep the
   * operator from copying a copy.
   */
  app.get<{ Params: { id: string } }>('/api/registries/:id/browse', async (req, reply) => {
    const query = engine.queryClient(req.params.id);
    if (!query) return reply.code(404).send({ error: `no registry ${req.params.id}, or it is disabled` });
    try {
      const [senders, receivers, devices, flows] = await Promise.all([
        query.senders(),
        query.receivers(),
        query.devices(),
        query.flows().catch(() => []),
      ]);
      const deviceById = new Map(devices.map((d) => [d.id, d]));
      const flowById = new Map(flows.map((f) => [f.id, f]));
      const ourNodes = new Set(store.current.domains.map((d) => engine.nodeId(d.id)));
      const copied = new Set(store.current.mirrors.map((m) => `${m.registryId}:${m.originId}`));

      const annotate = (r: { id: string; device_id: string }) => {
        const device = deviceById.get(r.device_id);
        return {
          deviceLabel: device?.label ?? r.device_id,
          nodeId: device?.node_id ?? null,
          ours: device ? ourNodes.has(device.node_id) : false,
          copied: copied.has(`${req.params.id}:${r.id}`),
          controllable: !!device?.controls?.some((c) => c.type.startsWith('urn:x-nmos:control:sr-ctrl/')),
        };
      };

      return {
        senders: senders.map((s) => ({
          ...s,
          ...annotate(s),
          flow: s.flow_id ? (flowById.get(s.flow_id) ?? null) : null,
        })),
        receivers: receivers.map((r) => ({ ...r, ...annotate(r) })),
      };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/mirrors', async () => {
    const channels = engine.channels();
    return store.current.mirrors.map((m) => {
      const key = m.kind === 'sender' ? `mirror-${m.id}` : (store.current.receivers.find((r) => r.proxyFor?.mirrorId === m.id)?.id ?? '');
      const channel = channels.find((c) => c.receiverId === key) ?? null;
      const device = store.current.devices.find((d) => d.id === m.deviceId) ?? null;
      return {
        ...m,
        proxyReceiverId: m.kind === 'receiver' ? key || null : null,
        device: device ? { id: device.id, label: device.label, sourceDomain: device.sourceDomain, targetDomain: device.targetDomain, nat: device.nat } : null,
        channel,
      };
    });
  });

  app.post<{ Body: Partial<MirrorEntry> & { format?: 'video' | 'audio' | 'data' } }>('/api/mirrors', async (req, reply) => {
    const b = req.body ?? {};
    if (b.kind !== 'sender' && b.kind !== 'receiver') return reply.code(400).send({ error: 'kind must be sender or receiver' });
    if (!b.deviceId || !b.registryId || !b.originId || !b.originDeviceId) {
      return reply.code(400).send({ error: 'deviceId, registryId, originId and originDeviceId are required' });
    }
    const cfg = structuredClone(store.current);
    const device = cfg.devices.find((d) => d.id === b.deviceId);
    if (!device) return reply.code(404).send({ error: 'unknown device' });
    if (cfg.mirrors.some((m) => m.registryId === b.registryId && m.originId === b.originId)) {
      return reply.code(409).send({ error: 'this resource is already copied' });
    }

    const mirror: MirrorEntry = {
      id: randomUUID(),
      kind: b.kind,
      deviceId: device.id,
      registryId: b.registryId,
      originId: b.originId,
      originDeviceId: b.originDeviceId,
      originLabel: b.originLabel ?? b.originId,
      ...(b.label ? { label: b.label } : {}),
      enabled: b.enabled ?? true,
    };
    cfg.mirrors.push(mirror);

    // A receiver copy needs a proxy receiver to exist as an ordering point. A sender
    // copy needs nothing extra — its channel is created right away.
    if (mirror.kind === 'receiver') {
      const vrxId = randomUUID();
      cfg.receivers.push({
        id: vrxId,
        label: mirror.label || `${mirror.originLabel} (proxy)`,
        deviceId: device.id,
        format: b.format ?? 'video',
        enabled: true,
        proxyFor: {
          registryId: mirror.registryId,
          receiverId: mirror.originId,
          deviceId: mirror.originDeviceId,
          mirrorId: mirror.id,
        },
      });
      device.receiverIds.push(vrxId);
    }

    try {
      await store.save(cfg);
      await onConfigChange();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    if (mirror.kind === 'sender' && mirror.enabled) {
      try {
        const channel = await engine.copySender(mirror.id);
        return { ...mirror, channel };
      } catch (e) {
        return reply.code(502).send({ ...mirror, error: (e as Error).message });
      }
    }
    return mirror;
  });

  app.post<{ Params: { id: string } }>('/api/mirrors/:id/refresh', async (req, reply) => {
    const mirror = store.current.mirrors.find((m) => m.id === req.params.id);
    if (!mirror) return reply.code(404).send({ error: 'unknown copy' });
    if (mirror.kind !== 'sender') {
      return reply.code(409).send({ error: 'a receiver proxy follows its own connection — nothing to refresh' });
    }
    try {
      return await engine.copySender(mirror.id);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/mirrors/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const mirror = cfg.mirrors.find((m) => m.id === req.params.id);
    if (!mirror) return reply.code(404).send({ error: 'unknown copy' });

    // Tear the channel down before the configuration forgets about it, otherwise the
    // pool reservation and the switch rules are orphaned.
    if (mirror.kind === 'sender') {
      await engine.deactivate(`mirror-${mirror.id}`);
    } else {
      const proxy = cfg.receivers.find((r) => r.proxyFor?.mirrorId === mirror.id);
      if (proxy) {
        await engine.deactivate(proxy.id);
        cfg.receivers = cfg.receivers.filter((r) => r.id !== proxy.id);
        for (const d of cfg.devices) d.receiverIds = d.receiverIds.filter((id) => id !== proxy.id);
      }
    }
    cfg.mirrors = cfg.mirrors.filter((m) => m.id !== req.params.id);

    try {
      await store.save(cfg);
      await onConfigChange();
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
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
