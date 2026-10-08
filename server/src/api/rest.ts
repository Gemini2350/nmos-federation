import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../config/store.js';
import type { Engine } from '../federation/engine.js';
import type { AppConfig } from '../config/schema.js';
import type { FederationDevice, VirtualReceiver } from '../types.js';
import { randomUUID } from 'node:crypto';
import type { MirrorEntry } from '../config/schema.js';
import type { Bridge } from '../types.js';
import { listInterfaces } from '../nmos/resources.js';
import { nextId, otherDomain, proxyLabel } from '../config/schema.js';
import { GROUPHINT } from '../federation/grouping.js';
import { PASSTHROUGH, passableControls } from '../federation/passthrough.js';
import type { StateStore } from '../federation/state.js';
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
 *   GET/POST /api/bridges, PUT/DELETE /api/bridges/:id   a bridge is an NMOS node
 *   GET/POST /api/devices, PUT/DELETE /api/devices/:id   a device hangs on a bridge
 *   POST     /api/devices/:id/receivers        create virtual receivers (count, name pattern)
 *   DELETE   /api/receivers/:id
 *   GET      /api/registries                   per-registry status
 *   POST     /api/registries/:id/probe          reachability test for one registry
 *   POST     /api/switch/:fabric/probe         connectivity test
 *   GET      /api/interfaces                    this host's IPv4 addresses, to pick from
 *   GET      /api/discovery                     run DNS-SD now, with what was queried
 *   POST     /api/discovery/refresh             drop cached DNS-SD addresses
 *   GET      /api/registries/:id/browse         list a registry's senders and receivers
 *   GET/POST /api/mirrors                      registry-to-registry copies
 *   DELETE   /api/mirrors/:id                  remove a copy and tear it down
 *   POST     /api/mirrors/:id/refresh          re-read the origin and rebuild
 *   POST     /api/cleanup                       remove registry resources left over from an earlier run
 *   POST     /api/reset                         factory reset: unregister everything, wipe config and state
 *   POST     /api/reconcile                    run desired/actual reconciliation now
 *   WS       /api/events                       channel and status changes
 */
/**
 * Every changing request runs alone. Each write handler copies the configuration,
 * changes the copy and saves it; two side by side each saved their own copy, so one
 * change was silently lost — or both collided on the temp file and one failed with 400.
 * Tabbing through name fields sends exactly that: a PUT per field, back to back.
 *
 * A queue rather than per-handler care, because the window is not only the save: a
 * handler awaits switch teardowns and registry syncs before it saves, and anything
 * that lands in between works on a stale copy. Reads are not queued.
 */
/**
 * What a copy keeps of its original besides the stream: its group hint and the label of
 * its device, which disambiguates group names that repeat across devices. Read once
 * when the copy is made; `null` records "the original has none" so it is not asked
 * again.
 */
async function readOrigin(
  engine: Engine,
  mirror: MirrorEntry,
): Promise<Pick<MirrorEntry, 'originGroupHint' | 'originDeviceLabel' | 'originControls' | 'originSourceId'>> {
  const query = engine.queryClient(mirror.registryId);
  if (!query) throw new Error(`registry ${mirror.registryId} is not enabled`);
  const [resource, device] = await Promise.all([
    mirror.kind === 'sender' ? query.sender(mirror.originId) : query.receiver(mirror.originId),
    query.device(mirror.originDeviceId).catch(() => null),
  ]);
  // IS-08 names a sender's output by its source, so a sender copy needs that id too.
  const flowId = mirror.kind === 'sender' ? (resource as { flow_id?: string | null }).flow_id : null;
  const flow = flowId ? await query.flow(flowId).catch(() => null) : null;
  return {
    originGroupHint: resource.tags?.[GROUPHINT]?.[0] ?? null,
    originDeviceLabel: device?.label ?? null,
    originControls: device ? passableControls(device.controls) : null,
    ...(mirror.kind === 'sender' ? { originSourceId: flow?.source_id ?? null } : {}),
  };
}

function serializeWrites(app: FastifyInstance): void {
  let tail: Promise<void> = Promise.resolve();
  const releases = new WeakMap<object, () => void>();
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !req.url.startsWith('/api/')) return;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const before = tail;
    tail = before.then(() => mine);
    releases.set(req, release);
    await before;
  });
  const done = async (req: object) => {
    releases.get(req)?.();
    releases.delete(req);
  };
  app.addHook('onResponse', done);
  // A client that gives up must not hold the queue for everyone after it.
  app.addHook('onRequestAbort', done);
}

export function registerRestApi(
  app: FastifyInstance,
  store: ConfigStore,
  engine: Engine,
  state: StateStore,
  onConfigChange: () => Promise<void>,
): void {
  serializeWrites(app);
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

  // ---- Bridges -----------------------------------------------------------
  app.get('/api/bridges', async () => {
    const domainIds = new Set(store.current.domains.map((d) => d.id));
    const registryIds = new Set(store.current.registries.map((r) => r.id));
    return store.current.bridges.map((b) => ({
      ...b,
      nodeId: engine.nodeId(b.id),
      devices: store.current.devices.filter((d) => d.bridgeId === b.id).length,
      // A renamed or removed domain leaves the bridge pointing at nothing. Say so rather
      // than letting it look configured while registering nothing.
      detached: b.domains.some((d) => !domainIds.has(d)),
      missing: {
        domains: b.domains.filter((d) => !domainIds.has(d)),
        registries: b.registries.filter((r) => !registryIds.has(r)),
      },
    }));
  });

  app.post<{ Body: Partial<Bridge> }>('/api/bridges', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const bridge: Bridge = {
      id: nextId(cfg.bridges.map((b) => b.id)),
      label: req.body.label ?? 'NMOS Federation',
      domains: [req.body.domains?.[0] ?? '', req.body.domains?.[1] ?? ''],
      registries: req.body.registries ?? [],
      nat: req.body.nat ?? true,
      grouping: req.body.grouping ?? true,
      enabled: req.body.enabled ?? true,
    };
    cfg.bridges.push(bridge);
    try {
      await store.save(cfg);
      await onConfigChange();
      return bridge;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<Bridge> }>('/api/bridges/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const i = cfg.bridges.findIndex((b) => b.id === req.params.id);
    if (i < 0) return reply.code(404).send({ error: 'unknown bridge' });
    const before = cfg.bridges[i]!;
    const after: Bridge = { ...before, ...req.body, id: req.params.id };
    cfg.bridges[i] = after;

    // Domains, registries and NAT shape every channel on this bridge, so a change to
    // them invalidates all of them. Rebuild rather than leave channels behind that no
    // longer match their configuration.
    const rebuild =
      before.nat !== after.nat ||
      JSON.stringify(before.domains) !== JSON.stringify(after.domains) ||
      JSON.stringify(before.registries) !== JSON.stringify(after.registries);

    const deviceIds = new Set(cfg.devices.filter((d) => d.bridgeId === after.id).map((d) => d.id));
    const affected = rebuild ? engine.channels().filter((c) => deviceIds.has(c.deviceId)).map((c) => c.receiverId) : [];
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

  app.delete<{ Params: { id: string } }>('/api/bridges/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    if (!cfg.bridges.some((b) => b.id === req.params.id)) return reply.code(404).send({ error: 'unknown bridge' });
    const devices = cfg.devices.filter((d) => d.bridgeId === req.params.id);
    const victims = cfg.receivers.filter((r) => devices.some((d) => d.id === r.deviceId));
    for (const vrx of victims) await engine.deactivate(vrx.id);
    for (const m of cfg.mirrors.filter((m) => devices.some((d) => d.id === m.deviceId))) {
      await engine.deactivate(`mirror-${m.id}`);
    }

    const deviceIds = new Set(devices.map((d) => d.id));
    cfg.bridges = cfg.bridges.filter((b) => b.id !== req.params.id);
    cfg.devices = cfg.devices.filter((d) => d.bridgeId !== req.params.id);
    cfg.receivers = cfg.receivers.filter((r) => !deviceIds.has(r.deviceId));
    cfg.mirrors = cfg.mirrors.filter((m) => !deviceIds.has(m.deviceId));
    try {
      await store.save(cfg);
      await onConfigChange();
      await engine.cleanupOrphans().catch(() => []);
      return { ok: true, removedDevices: devices.length, removedReceivers: victims.length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Devices -----------------------------------------------------------
  app.get('/api/devices', async () => {
    const bridges = new Map(store.current.bridges.map((b) => [b.id, b]));
    const channels = engine.channels();
    return store.current.devices.map((d) => {
      const grouping = bridges.get(d.bridgeId)?.grouping !== false;
      const hints = grouping ? engine.groupHintsOf(d) : new Map();
      return {
      ...d,
      // A proxy carries its original's name, so the GUI can show where it came from
      // after it has been renamed.
      receivers: engine.receiversOf(d).map((vrx) => {
        const mirror = vrx.proxyFor && store.current.mirrors.find((m) => m.id === vrx.proxyFor!.mirrorId);
        return {
          ...vrx,
          origin: mirror ? { label: mirror.originLabel, registryId: mirror.registryId } : null,
          groupHint: hints.get(vrx.id) ?? null,
        };
      }),
      // Sender copies have no virtual receiver, so they would not show up under the
      // device at all — yet they are ports on it like any other.
      senderCopies: store.current.mirrors
        .filter((m) => m.kind === 'sender' && m.deviceId === d.id)
        .map((m) => {
          const dir = engine.mirrorDirection(m);
          const channel = channels.find((c) => c.receiverId === `mirror-${m.id}`);
          return {
            id: m.id,
            name: m.label || m.originLabel,
            originLabel: m.originLabel,
            registryId: m.registryId,
            from: dir?.origin ?? null,
            to: dir?.other ?? null,
            state: channel?.state ?? null,
            error: channel?.error ?? null,
            group: m.group ?? null,
            role: m.role ?? null,
            groupHint: hints.get(`mirror-${m.id}`) ?? null,
          };
        }),
      bridge: bridges.get(d.bridgeId) ?? null,
      detached: !engine.isAttached(d),
      passthrough: (() => {
        const pt = engine.passthroughOf(d);
        return pt
          ? { from: pt.originDeviceLabel ?? pt.originDeviceId, domainId: pt.domainId, apis: pt.controls.map((c) => PASSTHROUGH[c.type]!.label) }
          : null;
      })(),
      };
    });
  });

  app.post<{ Body: Partial<FederationDevice> }>('/api/devices', async (req, reply) => {
    const cfg = structuredClone(store.current);
    if (!req.body.bridgeId || !cfg.bridges.some((b) => b.id === req.body.bridgeId)) {
      return reply.code(400).send({ error: 'a device needs a bridge' });
    }
    const device: FederationDevice = {
      id: randomUUID(),
      label: req.body.label ?? 'Device',
      bridgeId: req.body.bridgeId,
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
    // Only the label and the bridge it hangs on; everything that shapes a channel lives
    // on the bridge.
    cfg.devices[i] = { ...cfg.devices[i]!, ...req.body, id: req.params.id };
    try {
      await store.save(cfg);
      await onConfigChange();
      return cfg.devices[i];
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const victims = cfg.receivers.filter((r) => r.deviceId === req.params.id);
    for (const vrx of victims) await engine.deactivate(vrx.id);
    for (const m of cfg.mirrors.filter((m) => m.deviceId === req.params.id)) {
      await engine.deactivate(`mirror-${m.id}`);
    }
    cfg.devices = cfg.devices.filter((d) => d.id !== req.params.id);
    cfg.receivers = cfg.receivers.filter((r) => r.deviceId !== req.params.id);
    cfg.mirrors = cfg.mirrors.filter((m) => m.deviceId !== req.params.id);
    try {
      await store.save(cfg);
      await onConfigChange();
      return { ok: true, removedReceivers: victims.length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Virtual receivers -------------------------------------------------
  app.post<{ Params: { id: string }; Body: { count?: number; pattern?: string; format?: VirtualReceiver['format']; side?: string } }>(
    '/api/devices/:id/receivers',
    async (req, reply) => {
      const cfg = structuredClone(store.current);
      const device = cfg.devices.find((d) => d.id === req.params.id);
      if (!device) return reply.code(404).send({ error: 'unknown device' });
      const count = Math.max(1, Math.min(256, req.body?.count ?? 1));
      const pattern = req.body?.pattern ?? `${device.label} {n}`;
      const format = req.body?.format ?? 'video';
      // The side decides the direction: offered there, its stream flows to the other one.
      const bridge = cfg.bridges.find((b) => b.id === device.bridgeId);
      if (!bridge) return reply.code(400).send({ error: 'the device hangs on no bridge' });
      const side = req.body?.side ?? bridge.domains[0];
      if (!bridge.domains.includes(side)) {
        return reply.code(400).send({ error: `domain ${side} is not one of bridge "${bridge.label}"'s two` });
      }
      const existing = cfg.receivers.filter((r) => r.deviceId === device.id).length;
      const created: VirtualReceiver[] = [];
      for (let n = 1; n <= count; n++) {
        const vrx: VirtualReceiver = {
          id: randomUUID(),
          label: pattern.replace('{n}', String(existing + n)),
          deviceId: device.id,
          format,
          enabled: true,
          side,
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

  // Renaming only. Format and device shape what a receiver is; changing those is a
  // remove and add.
  app.put<{ Params: { id: string }; Body: { label?: string; group?: string; role?: string } }>('/api/receivers/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const vrx = cfg.receivers.find((r) => r.id === req.params.id);
    if (!vrx) return reply.code(404).send({ error: 'unknown receiver' });
    if (req.body.label !== undefined) {
      const label = req.body.label.trim();
      if (!label) return reply.code(400).send({ error: 'a receiver needs a name' });
      vrx.label = label;
    }
    // Natural group; empty clears it — a proxy then falls back to its original's.
    if (req.body.group !== undefined) {
      const group = req.body.group.trim();
      if (group.includes(':')) return reply.code(400).send({ error: 'a group name cannot contain ":" — it separates group and role' });
      if (group) vrx.group = group;
      else delete vrx.group;
    }
    if (req.body.role !== undefined) {
      const role = req.body.role.trim();
      if (role.includes(':')) return reply.code(400).send({ error: 'a role cannot contain ":" — it separates group and role' });
      if (role) vrx.role = role;
      else delete vrx.role;
    }
    try {
      await store.save(cfg);
      await onConfigChange();
      return vrx;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/receivers/:id', async (req, reply) => {
    await engine.deactivate(req.params.id);
    const cfg = structuredClone(store.current);
    // A proxy is half of a copy. Leaving its copy entry behind kept the original marked
    // "proxied" on the Copy page and listed a copy that no longer had a receiver.
    const mirrorId = cfg.receivers.find((r) => r.id === req.params.id)?.proxyFor?.mirrorId;
    if (mirrorId) cfg.mirrors = cfg.mirrors.filter((m) => m.id !== mirrorId);
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

  // With network_mode: host these are the host's own interfaces — which is exactly what
  // a domain's address has to be, so the settings page offers them instead of free text.
  app.get('/api/interfaces', async () => listInterfaces());

  // ---- Discovery ----------------------------------------------------------
  app.get<{ Querystring: { domain?: string; version?: string } }>('/api/discovery', async (req) =>
    engine.discover({
      ...(req.query.domain ? { domain: req.query.domain } : {}),
      ...(req.query.version ? { version: req.query.version } : {}),
    }),
  );

  app.post('/api/discovery/refresh', async () => {
    engine.rediscover();
    await engine.syncRegistries();
    return { ok: true };
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
      // Paged, not a single GET: a registry that caps a page would otherwise hand us a
      // silently truncated list. The paging stats go to the GUI so a hard cap is visible.
      const empty = { items: [], pages: 0, truncated: false, limit: null };
      const [senderPage, receiverPage, devicePage, flowPage, nodePage] = await Promise.all([
        query.getAll<Awaited<ReturnType<typeof query.senders>>[number]>('senders'),
        query.getAll<Awaited<ReturnType<typeof query.receivers>>[number]>('receivers'),
        query.getAll<Awaited<ReturnType<typeof query.devices>>[number]>('devices'),
        query.getAll<Awaited<ReturnType<typeof query.flows>>[number]>('flows').catch(() => empty),
        // Only for grouping by node in the GUI; a registry that fails it still browses.
        query.getAll<{ id: string; label?: string; hostname?: string; description?: string }>('nodes').catch(() => empty),
      ]);
      const senders = senderPage.items;
      const receivers = receiverPage.items;
      const devices = devicePage.items;
      const flows = flowPage.items;
      const deviceById = new Map(devices.map((d) => [d.id, d]));
      const flowById = new Map(flows.map((f) => [f.id, f]));
      // A node's label is optional in practice (nmos-cpp nodes often carry an empty one);
      // fall back to what identifies it to a human, then to the id.
      const nodeLabel = new Map(
        (nodePage.items as { id: string; label?: string; hostname?: string; description?: string }[]).map((n) => [
          n.id,
          n.label?.trim() || n.hostname?.trim() || n.description?.trim() || n.id,
        ]),
      );
      const ourNodes = new Set(store.current.bridges.map((b) => engine.nodeId(b.id)));
      const copied = new Set(store.current.mirrors.map((m) => `${m.registryId}:${m.originId}`));

      const annotate = (r: { id: string; device_id: string }) => {
        const device = deviceById.get(r.device_id);
        return {
          deviceLabel: device?.label ?? r.device_id,
          nodeId: device?.node_id ?? null,
          nodeLabel: device ? (nodeLabel.get(device.node_id) ?? device.node_id) : null,
          ours: device ? ourNodes.has(device.node_id) : false,
          copied: copied.has(`${req.params.id}:${r.id}`),
          controllable: !!device?.controls?.some((c) => c.type.startsWith('urn:x-nmos:control:sr-ctrl/')),
        };
      };

      return {
        paging: {
          limit: senderPage.limit,
          pages: senderPage.pages + receiverPage.pages + devicePage.pages + flowPage.pages + nodePage.pages,
          truncated: senderPage.truncated || receiverPage.truncated || devicePage.truncated || flowPage.truncated || nodePage.truncated,
        },
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

  /** Is each origin registry's change feed live — sender copies follow their originals through it. */
  app.get('/api/mirrors/watch', async () => engine.watchStatus());

  app.get('/api/mirrors', async () => {
    const channels = engine.channels();
    return store.current.mirrors.map((m) => {
      const key = m.kind === 'sender' ? `mirror-${m.id}` : (store.current.receivers.find((r) => r.proxyFor?.mirrorId === m.id)?.id ?? '');
      const channel = channels.find((c) => c.receiverId === key) ?? null;
      const device = store.current.devices.find((d) => d.id === m.deviceId) ?? null;
      const shared = engine.mirrorRegistries(m);
      const dir = engine.mirrorDirection(m);
      return {
        ...m,
        // The name the copy carries in the registries. A proxy's lives on its receiver,
        // which can also be renamed on the Bridges page.
        name:
          m.kind === 'receiver'
            ? (store.current.receivers.find((r) => r.id === key)?.label ?? m.label ?? proxyLabel(m.originLabel))
            : m.label || m.originLabel,
        registries: shared.chosen,
        registryChoices: shared.choices,
        proxyReceiverId: m.kind === 'receiver' ? key || null : null,
        device: device
          ? (() => {
              const bridge = store.current.bridges.find((b) => b.id === device.bridgeId);
              return {
                id: device.id,
                label: device.label,
                bridge: bridge?.label ?? null,
                // Which way this copy runs: a sender copy from its origin to the other
                // side; a proxy's stream from the other side to the original receiver.
                from: dir ? (m.kind === 'sender' ? dir.origin : dir.other) : null,
                to: dir ? (m.kind === 'sender' ? dir.other : dir.origin) : null,
                nat: bridge?.nat ?? false,
              };
            })()
          : null,
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
    // A copy runs away from the domain it is copied from, so that domain has to be one
    // end of the device's bridge; the other end is where the copy appears.
    const bridge = cfg.bridges.find((x) => x.id === device.bridgeId);
    const origin = cfg.registries.find((r) => r.id === b.registryId)?.domainId;
    const other = bridge && origin ? otherDomain(bridge, origin) : undefined;
    if (!bridge || !other) {
      return reply.code(400).send({ error: `that registry is in neither domain of the device's bridge` });
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
    // Its grouping comes along. A registry that cannot answer right now does not stop the
    // copy; the startup pass fills it in later.
    Object.assign(mirror, await readOrigin(engine, mirror).catch(() => ({})));
    cfg.mirrors.push(mirror);

    // A receiver copy needs a proxy receiver to exist as an ordering point. A sender
    // copy needs nothing extra — its channel is created right away.
    if (mirror.kind === 'receiver') {
      const vrxId = randomUUID();
      cfg.receivers.push({
        id: vrxId,
        label: mirror.label || proxyLabel(mirror.originLabel),
        deviceId: device.id,
        format: b.format ?? 'video',
        enabled: true,
        side: other,
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

  // Name and where it is shared. Neither touches the stream: a renamed or re-shared
  // sender copy keeps its NAT and multicast groups, only its registrations move.
  app.put<{ Params: { id: string }; Body: { label?: string; registries?: string[]; group?: string; role?: string } }>('/api/mirrors/:id', async (req, reply) => {
    const cfg = structuredClone(store.current);
    const mirror = cfg.mirrors.find((m) => m.id === req.params.id);
    if (!mirror) return reply.code(404).send({ error: 'unknown copy' });
    const b = req.body ?? {};

    if (b.label !== undefined) {
      const label = b.label.trim();
      if (!label) return reply.code(400).send({ error: 'a copy needs a name' });
      mirror.label = label;
      if (mirror.kind === 'receiver') {
        const proxy = cfg.receivers.find((r) => r.proxyFor?.mirrorId === mirror.id);
        if (proxy) proxy.label = label;
      }
    }
    if (b.group !== undefined) {
      const group = b.group.trim();
      if (group.includes(':')) return reply.code(400).send({ error: 'a group name cannot contain ":" — it separates group and role' });
      // A proxy's group lives on its receiver, like its name.
      const target: { group?: string } =
        mirror.kind === 'receiver' ? (cfg.receivers.find((r) => r.proxyFor?.mirrorId === mirror.id) ?? mirror) : mirror;
      if (group) target.group = group;
      else delete target.group;
    }
    if (b.role !== undefined) {
      const role = b.role.trim();
      if (role.includes(':')) return reply.code(400).send({ error: 'a role cannot contain ":" — it separates group and role' });
      const target: { role?: string } =
        mirror.kind === 'receiver' ? (cfg.receivers.find((r) => r.proxyFor?.mirrorId === mirror.id) ?? mirror) : mirror;
      if (role) target.role = role;
      else delete target.role;
    }
    if (b.registries !== undefined) {
      const { choices } = engine.mirrorRegistries(mirror);
      const unknown = b.registries.filter((id) => !choices.includes(id));
      if (unknown.length) {
        return reply.code(400).send({ error: `not a registry of that domain: ${unknown.join(', ')}` });
      }
      if (!b.registries.length) return reply.code(400).send({ error: 'a copy has to be shared in at least one registry' });
      mirror.registries = b.registries;
    }

    try {
      await store.save(cfg);
      await engine.applyMirrorChange(mirror.id);
      return mirror;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Reads the original's group hint for every copy that has none recorded yet — copies
   * made before grouping existed, or while their registry was unreachable. Runs once
   * after startup through the write queue.
   */
  app.post('/api/mirrors/origins', async () => {
    const cfg = structuredClone(store.current);
    let updated = 0;
    const failed: string[] = [];
    for (const mirror of cfg.mirrors.filter((m) => m.originGroupHint === undefined || m.originControls === undefined)) {
      try {
        Object.assign(mirror, await readOrigin(engine, mirror));
        updated++;
      } catch (e) {
        failed.push(`${mirror.originLabel}: ${(e as Error).message}`);
      }
    }
    if (updated) {
      await store.save(cfg);
      await engine.syncRegistries();
    }
    return { updated, failed };
  });

  app.post<{ Params: { id: string } }>('/api/mirrors/:id/refresh', async (req, reply) => {
    const mirror = store.current.mirrors.find((m) => m.id === req.params.id);
    if (!mirror) return reply.code(404).send({ error: 'unknown copy' });
    if (mirror.kind !== 'sender') {
      return reply.code(409).send({ error: 'a receiver proxy follows its own connection — nothing to refresh' });
    }
    try {
      // In place where possible: the copy keeps its addresses.
      return await engine.followOrigin(mirror.id);
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

  app.post('/api/cleanup', async () => ({ registries: await engine.cleanupOrphans() }));

  /**
   * Factory reset. Deliberately explicit: it tears down every channel, removes
   * everything this installation put into the registries, and then wipes configuration
   * and state. Without `confirm` it only reports what it would do.
   */
  app.post<{ Body: { confirm?: boolean } }>('/api/reset', async (req) => {
    const current = store.current;
    const plan = {
      channels: engine.channels().length,
      devices: current.devices.length,
      receivers: current.receivers.length,
      mirrors: current.mirrors.length,
      domains: current.domains.length,
      registries: current.registries.length,
    };
    if (!req.body?.confirm) return { confirmed: false, wouldRemove: plan };

    // Order matters: tear the channels down first so the switch is cleared and the
    // senders are unregistered, then empty the resource tree and let the sync remove
    // what is left, then scan for anything an earlier run abandoned — all while the
    // registries are still configured. Only then wipe.
    for (const vrx of current.receivers) await engine.deactivate(vrx.id);
    for (const m of current.mirrors) await engine.deactivate(`mirror-${m.id}`);

    const emptied = structuredClone(current);
    emptied.devices = [];
    emptied.receivers = [];
    emptied.mirrors = [];
    await store.save(emptied).catch(() => undefined);
    await onConfigChange();
    const removed = await engine.cleanupOrphans().catch(() => []);

    // The nodes go last but still before the state is wiped: their ids derive from the
    // seed, and a new seed would leave them in the registries as resources nobody can
    // identify any more.
    const unregistered = await engine.unregisterEverything().catch(() => 0);

    await state.reset();
    await store.reset();
    await onConfigChange();
    log.warn({ ...plan, unregistered }, 'factory reset completed');
    return { confirmed: true, removed, unregistered, wasRemoved: plan };
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
