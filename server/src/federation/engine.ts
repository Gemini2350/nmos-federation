import type { AppConfig, DomainConfig } from '../config/schema.js';
import { domainById, legOrder, registriesOf } from '../config/schema.js';
import { RegistryClient, REGISTER_ORDER, type ResourceType } from '../nmos/registry-client.js';
import { QueryClient } from '../nmos/query-client.js';
import { discoverRegistries, hostSearchDomains } from '../nmos/discovery.js';
import { Is05Client } from '../nmos/is05-client.js';
import {
  MEDIA_TYPES,
  buildDevice,
  buildFlow,
  buildNode,
  buildReceiver,
  buildSender,
  buildSource,
  canonicalUrl,
  essenceFromSdp,
  nmosVersion,
  resolveInterface,
  uuidv5,
  type EssenceParams,
} from '../nmos/resources.js';
import { assignFabrics, essenceCount, parseSdp, rewriteSdp } from '../nmos/sdp.js';
import { programChannel, unprogramChannel, type SwitchDriver } from '../switch/driver.js';
import type { Channel, FederationDevice, VirtualReceiver } from '../types.js';
import type { MirrorEntry } from '../config/schema.js';
import { createHash } from 'node:crypto';
import { buildChannelPlan } from './channel.js';
import type { PoolManager } from './pools.js';
import type { ConnectionState, StateStore } from './state.js';
import { log } from '../util/log.js';

export interface EngineEvent {
  type: 'channel' | 'registry' | 'switch';
  [key: string]: unknown;
}

export interface EngineDeps {
  /** A provider, not a snapshot: saving settings replaces the config object, and
   *  both engine and node API must see the new one afterwards. */
  config: () => AppConfig;
  state: StateStore;
  pools: PoolManager;
  drivers: Record<string, SwitchDriver>;
}

interface Resource {
  type: ResourceType;
  data: { id: string };
}

/**
 * Orchestrator: owns the registry clients, builds the per-domain resource tree and
 * brings channels up and down.
 *
 * Core idea for everything registry-related: there is exactly one function that
 * establishes a registry's desired state (`syncRegistry`). Initial registration,
 * re-registration after a heartbeat 404, publishing a new sender, unregistering on
 * teardown and reconciliation are all the same code path.
 */
export class Engine {
  readonly registries = new Map<string, RegistryClient>();
  private readonly queries = new Map<string, QueryClient>();
  private readonly is05 = new Map<string, Is05Client>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** Node API port actually bound per domain — may differ from the configured one
   *  when two domains share an IP. The hrefs must reflect that. */
  private readonly domainPorts = new Map<string, number>();
  /** id -> the content hash and the version stamped for it, see stamp(). */
  private readonly versions = new Map<string, { hash: string; version: string }>();

  constructor(private deps: EngineDeps) {}

  private get cfg(): AppConfig {
    return this.deps.config();
  }

  /** For the node API and REST: always the current version. */
  get config(): AppConfig {
    return this.cfg;
  }

  /** Pools depend on the domain configurations and must be rebuilt after a
   *  settings change. */
  setPools(pools: PoolManager): void {
    this.deps.pools = pools;
  }

  setDrivers(drivers: Record<string, SwitchDriver>): void {
    this.deps.drivers = drivers;
  }

  private get seed(): string {
    return this.deps.state.current.seed;
  }

  // -- IDs -----------------------------------------------------------------
  nodeId(domainId: string): string {
    return uuidv5(this.seed, `node:${domainId}`);
  }
  deviceId(devId: string, domainId: string): string {
    return uuidv5(this.nodeId(domainId), `device:${devId}`);
  }
  receiverNmosId(vrxId: string, domainId: string): string {
    return uuidv5(this.nodeId(domainId), `receiver:${vrxId}`);
  }
  senderNmosId(vrxId: string, domainId: string): string {
    return uuidv5(this.nodeId(domainId), `sender:${vrxId}`);
  }
  sourceNmosId(vrxId: string, domainId: string): string {
    return uuidv5(this.nodeId(domainId), `source:${vrxId}`);
  }
  flowNmosId(vrxId: string, domainId: string): string {
    return uuidv5(this.nodeId(domainId), `flow:${vrxId}`);
  }

  setDomainPort(domainId: string, port: number): void {
    this.domainPorts.set(domainId, port);
  }

  private portOf(domainId: string): number {
    return this.domainPorts.get(domainId) ?? this.cfg.nmosPort;
  }

  // -- Events --------------------------------------------------------------
  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: EngineEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* ein kaputter Listener darf die Engine nicht anhalten */
      }
    }
  }

  // -- Resource tree -------------------------------------------------------
  private connectionBase(domain: DomainConfig): string {
    // Canonical form — a strict registry rejects a control href that spells out the
    // default port.
    return canonicalUrl('http', domain.iface.address, this.portOf(domain.id), '/x-nmos/connection/v1.1');
  }

  private nodeResource(domain: DomainConfig) {
    const port = this.portOf(domain.id);
    // The OS interface that actually carries this address, for its real MAC — IS-04
    // requires an EUI-48 in interfaces[].port_id.
    const iface = resolveInterface(domain.iface.address, domain.iface.name);
    // Stamped here rather than at the call sites: the registration plan builds the node
    // directly, and an unstamped one carries a fresh version on every build — which is
    // exactly the pointless re-POST this is meant to stop.
    return this.stamp(
      buildNode(
      {
        id: this.nodeId(domain.id),
        href: canonicalUrl('http', domain.iface.address, port, '/'),
        address: domain.iface.address,
        port,
        interfaceName: domain.iface.name,
        mac: iface.mac,
      },
        `NMOS Federation — ${domain.label}`,
        { refclk: null },
      ),
    );
  }

  /**
   * Whether a device's domains still exist. A rename or a removal leaves devices
   * pointing at nothing; they must be skipped rather than throw, or one stale reference
   * takes the whole registration pass — and with it the startup — down with it.
   */
  isAttached(device: FederationDevice): boolean {
    const ids = new Set(this.cfg.domains.map((d) => d.id));
    return ids.has(device.sourceDomain) && ids.has(device.targetDomain);
  }

  /**
   * Gives a resource a version that only changes when its content does.
   *
   * The builders stamp the current time by default, so every rebuild produced a new
   * version and the whole tree was re-POSTed on every reconcile — a registry seeing our
   * resources "update" every 30 seconds for no reason. A registry also rejects a re-POST
   * that carries the same version with different content, so the two have to move
   * together.
   */
  private stamp<T extends { id: string; version: string }>(res: T): T {
    const { version: _ignored, ...content } = res;
    const hash = createHash('sha1').update(JSON.stringify(content)).digest('hex');
    const prev = this.versions.get(res.id);
    if (prev?.hash === hash) return { ...res, version: prev.version };
    const version = nmosVersion();
    this.versions.set(res.id, { hash, version });
    return { ...res, version };
  }

  receiversOf(device: FederationDevice): VirtualReceiver[] {
    return this.cfg.receivers.filter((r) => r.deviceId === device.id);
  }

  /** Only active channels carry a published sender. */
  private activeChannels(): Channel[] {
    return this.deps.state.current.channels.filter((c) => c.state === 'active');
  }

  private essenceOf(channel: Channel): EssenceParams | null {
    if (!channel.originSdp) return null;
    try {
      return essenceFromSdp(channel.originSdp);
    } catch (e) {
      log.warn({ channel: channel.id, err: String(e) }, 'cannot derive essence');
      return null;
    }
  }

  /** Every resource of a domain — exactly what the node API serves there. */
  domainResources(domainId: string) {
    const domain = domainById(this.cfg, domainId);
    const devices: ReturnType<typeof buildDevice>[] = [];
    const receivers: ReturnType<typeof buildReceiver>[] = [];
    const senders: ReturnType<typeof buildSender>[] = [];
    const sources: ReturnType<typeof buildSource>[] = [];
    const flows: ReturnType<typeof buildFlow>[] = [];
    const active = this.activeChannels();

    for (const device of this.cfg.devices) {
      if (!this.isAttached(device)) continue;
      const vrxList = this.receiversOf(device);

      if (device.sourceDomain === domainId) {
        const devId = this.deviceId(device.id, domainId);
        for (const vrx of vrxList) {
          const conn = this.deps.state.connection(vrx.id).active;
          const caps = MEDIA_TYPES[vrx.format];
          receivers.push(
            this.stamp(buildReceiver(
              this.receiverNmosId(vrx.id, domainId),
              devId,
              vrx.label,
              caps.format,
              caps.mediaTypes,
              [domain.iface.name],
              { sender_id: conn.sender_id, active: conn.master_enable },
            )),
          );
        }
        devices.push(
          this.stamp(buildDevice(
            devId,
            this.nodeId(domainId),
            device.label,
            this.connectionBase(domain),
            [],
            vrxList.map((v) => this.receiverNmosId(v.id, domainId)),
          )),
        );
      }

      if (device.targetDomain === domainId) {
        const mirrorId = this.deviceId(`${device.id}:mirror`, domainId);
        const mine = active.filter((c) => c.deviceId === device.id);
        for (const channel of mine) {
          const essence = this.essenceOf(channel);
          if (!essence) continue;
          const vrxId = channel.receiverId;
          const label =
            this.cfg.receivers.find((r) => r.id === vrxId)?.label ??
            this.mirrorOf(vrxId)?.label ??
            this.mirrorOf(vrxId)?.originLabel ??
            essence.label ??
            vrxId;
          const sourceId = this.sourceNmosId(vrxId, domainId);
          const flowId = this.flowNmosId(vrxId, domainId);
          const senderId = this.senderNmosId(vrxId, domainId);
          sources.push(this.stamp(buildSource(sourceId, mirrorId, label, essence)));
          flows.push(this.stamp(buildFlow(flowId, sourceId, mirrorId, label, essence)));
          senders.push(
            this.stamp(buildSender(
              senderId,
              flowId,
              mirrorId,
              label,
              `${this.connectionBase(domain)}/single/senders/${senderId}/transportfile`,
              [domain.iface.name],
            )),
          );
        }
        devices.push(
          this.stamp(buildDevice(
            mirrorId,
            this.nodeId(domainId),
            device.mirrorLabel || `${device.label} ▸ ${device.sourceDomain}`,
            this.connectionBase(domain),
            mine.map((c) => this.senderNmosId(c.receiverId, domainId)),
            [],
          )),
        );
      }
    }

    return { self: this.nodeResource(domain), devices, receivers, senders, sources, flows };
  }

  /** Which registries this device serves on the target side. */
  private targetRegistryIds(device: FederationDevice): string[] {
    const all = registriesOf(this.cfg, device.targetDomain).map((r) => r.id);
    if (!device.targetRegistries.length) return all;
    return device.targetRegistries.filter((id) => all.includes(id));
  }

  /**
   * Desired state per registry. Node and devices go to every registry that holds
   * anything of ours; senders only to their device's target registries.
   */
  registrationPlan(): Map<string, Resource[]> {
    const plan = new Map<string, Resource[]>();
    const add = (registryId: string, res: Resource) => {
      const list = plan.get(registryId) ?? [];
      if (!list.some((r) => r.type === res.type && r.data.id === res.data.id)) list.push(res);
      plan.set(registryId, list);
    };

    // The node of a domain belongs in every enabled registry of that domain, whether or
    // not a federation device exists yet. Without this an installation with no devices
    // registers nothing at all, its heartbeat 404s every five seconds forever, and the
    // status cannot tell "registry unreachable" from "we never put anything there".
    for (const domain of this.cfg.domains.filter((d) => d.enabled)) {
      const self = this.nodeResource(domain);
      for (const reg of registriesOf(this.cfg, domain.id)) {
        add(reg.id, { type: 'node', data: self });
      }
    }

    for (const device of this.cfg.devices) {
      if (!this.isAttached(device)) {
        log.warn(
          { device: device.id, label: device.label, source: device.sourceDomain, target: device.targetDomain },
          'device is detached from its domains — skipped until they exist again',
        );
        continue;
      }
      const srcRegs = registriesOf(this.cfg, device.sourceDomain).map((r) => r.id);
      const tgtRegs = this.targetRegistryIds(device);

      const srcRes = this.domainResources(device.sourceDomain);
      const srcDevId = this.deviceId(device.id, device.sourceDomain);
      for (const registryId of srcRegs) {
        add(registryId, { type: 'node', data: srcRes.self });
        const dev = srcRes.devices.find((d) => d.id === srcDevId);
        if (dev) add(registryId, { type: 'device', data: dev });
        for (const vrx of this.receiversOf(device)) {
          const rx = srcRes.receivers.find((r) => r.id === this.receiverNmosId(vrx.id, device.sourceDomain));
          if (rx) add(registryId, { type: 'receiver', data: rx });
        }
      }

      const tgtRes = this.domainResources(device.targetDomain);
      const mirrorId = this.deviceId(`${device.id}:mirror`, device.targetDomain);
      for (const registryId of tgtRegs) {
        add(registryId, { type: 'node', data: tgtRes.self });
        const dev = tgtRes.devices.find((d) => d.id === mirrorId);
        if (dev) add(registryId, { type: 'device', data: dev });
        for (const channel of this.activeChannels().filter((c) => c.deviceId === device.id)) {
          const vrxId = channel.receiverId;
          const src = tgtRes.sources.find((s) => s.id === this.sourceNmosId(vrxId, device.targetDomain));
          const flow = tgtRes.flows.find((f) => f.id === this.flowNmosId(vrxId, device.targetDomain));
          const sender = tgtRes.senders.find((s) => s.id === this.senderNmosId(vrxId, device.targetDomain));
          if (src) add(registryId, { type: 'source', data: src });
          if (flow) add(registryId, { type: 'flow', data: flow });
          if (sender) add(registryId, { type: 'sender', data: sender });
        }
      }
    }
    return plan;
  }

  /** Establishes a registry's desired state. Errors are reported, not thrown. */
  async syncRegistry(client: RegistryClient): Promise<void> {
    const desired = this.registrationPlan().get(client.id) ?? [];
    const desiredKeys = new Set(desired.map((r) => `${r.type}:${r.data.id}`));

    // First remove what should no longer be there — children before parents, and
    // the sender first: nobody should connect to a stream we are about to tear down.
    for (const type of [...REGISTER_ORDER].reverse()) {
      for (const key of [...client.registered.keys()]) {
        const [t, id] = key.split(':') as [ResourceType, string];
        if (t === type && !desiredKeys.has(key)) {
          await client.unregister(t, id).catch((e) => log.warn({ registry: client.id, key, err: String(e) }, 'unregister failed'));
        }
      }
    }

    // Then create/update, parents before children.
    for (const type of REGISTER_ORDER) {
      for (const res of desired.filter((r) => r.type === type)) {
        try {
          await client.register(res.type, res.data);
        } catch (e) {
          log.warn({ registry: client.id, type: res.type, id: res.data.id, err: String(e) }, 'register failed');
        }
      }
    }
    this.emit({ type: 'registry', registry: client.id, status: client.status() });
  }

  /**
   * Removes resources that are still in a registry but no longer wanted.
   *
   * `RegistryClient.registered` is in-memory only, so after a restart the software has
   * no record of what it previously put into a registry and `syncRegistry` cannot
   * unregister it — which is why resources from an earlier run used to stay there
   * forever. This finds them the only way that works across a restart: ask the query
   * API for everything belonging to one of our nodes, and delete whatever the current
   * plan does not contain.
   *
   * Only resources under OUR node ids are ever touched. Those ids are derived from the
   * persisted seed, so they survive a restart; if the state file itself is deleted the
   * old ids are unknowable here and the registry's own garbage collection takes care of
   * them once the heartbeat stops.
   */
  async cleanupOrphans(registryIds?: string[]): Promise<{ registry: string; removed: string[] }[]> {
    const ourNodes = new Set(this.cfg.domains.map((d) => this.nodeId(d.id)));
    const plan = this.registrationPlan();
    const results: { registry: string; removed: string[] }[] = [];

    for (const id of registryIds ?? [...this.registries.keys()]) {
      const client = this.registries.get(id);
      const query = this.queries.get(id);
      if (!client || !query) continue;
      const desired = new Set((plan.get(id) ?? []).map((r) => `${r.type}:${r.data.id}`));
      const removed: string[] = [];

      // Scanning is the expensive half — six collections, each paginated — and the
      // collections are independent, so they are fetched at once. Deleting still happens
      // children before parents, so a registry never sees a dangling reference.
      const scans = await Promise.all(
        REGISTER_ORDER.map(async (type) => {
          try {
            return [type, (await query.getAll<{ id: string; node_id?: string }>(`${type}s`)).items] as const;
          } catch (e) {
            log.debug({ registry: id, type, err: String(e) }, 'orphan scan skipped');
            return [type, [] as { id: string; node_id?: string }[]] as const;
          }
        }),
      );
      const byType = new Map(scans);

      for (const type of [...REGISTER_ORDER].reverse()) {
        for (const item of byType.get(type) ?? []) {
          const mine = type === 'node' ? ourNodes.has(item.id) : !!item.node_id && ourNodes.has(item.node_id);
          if (!mine) continue; // someone else's resource — hands off
          const key = `${type}:${item.id}`;
          if (desired.has(key)) continue;
          await client.unregister(type, item.id).catch((e) => log.warn({ registry: id, key, err: String(e) }, 'orphan removal failed'));
          removed.push(key);
        }
      }
      if (removed.length) log.info({ registry: id, removed }, 'removed resources left over from an earlier run');
      results.push({ registry: id, removed });
    }
    return results;
  }

  /**
   * Removes everything we have in every registry, node included.
   *
   * Needed before the state is wiped: the node ids derive from the persisted seed, so a
   * new seed makes the old node unrecognisable — not ours any more, not cleanable, and
   * left in the registry until its heartbeat lapses. Unregistering has to happen while
   * the ids are still known.
   */
  async unregisterEverything(): Promise<number> {
    let removed = 0;
    for (const client of this.registries.values()) {
      for (const type of [...REGISTER_ORDER].reverse()) {
        for (const key of [...client.registered.keys()]) {
          const [t, id] = key.split(':') as [ResourceType, string];
          if (t !== type) continue;
          await client.unregister(t, id).catch((e) => log.warn({ key, err: String(e) }, 'unregister failed'));
          removed++;
        }
      }
    }
    if (removed) log.info({ removed }, 'unregistered everything');
    return removed;
  }

  async syncRegistries(registryIds?: string[]): Promise<void> {
    const ids = registryIds ?? [...this.registries.keys()];
    for (const id of ids) {
      const client = this.registries.get(id);
      if (client) await this.syncRegistry(client);
    }
  }

  // -- Lifecycle -----------------------------------------------------------
  private buildRegistryClients(): void {
    for (const client of this.registries.values()) client.stopHeartbeat();
    this.registries.clear();
    this.queries.clear();
    this.is05.clear();
    for (const reg of this.cfg.registries.filter((r) => r.enabled)) {
      const client = new RegistryClient(reg, (c) => {
        this.syncRegistry(c).catch(() => {});
      });
      this.registries.set(reg.id, client);
      // The query client borrows the registry client's resolver, so a DNS-SD registry
      // can be browsed at the address discovery found for it.
      const query = new QueryClient(reg, () => client.resolve());
      this.queries.set(reg.id, query);
      this.is05.set(reg.id, new Is05Client(query));
    }
  }

  /** Query API of a registry — for browsing existing resources. */
  queryClient(registryId: string): QueryClient | null {
    return this.queries.get(registryId) ?? null;
  }

  /** Our key for a sender copy's channel; receiver proxies key on their vRX id. */
  static mirrorKey(mirrorId: string): string {
    return `mirror-${mirrorId}`;
  }

  mirrorOf(key: string): MirrorEntry | undefined {
    return this.cfg.mirrors.find((m) => Engine.mirrorKey(m.id) === key);
  }

  /**
   * After a settings change: rebuild the clients and establish the desired state.
   *
   * `cleanup` is off by default and deliberately so. Scanning every collection of every
   * registry costs seconds against a registry that caps pages, and a settings save is
   * the most frequent operation there is — it used to make saving take eight seconds.
   * Removing something is what can orphan a resource, so those paths ask for it.
   */
  async restartRegistries(cleanup = false): Promise<void> {
    this.buildRegistryClients();
    await this.syncRegistries();
    if (cleanup) await this.cleanupOrphans().catch((e) => log.warn({ err: String(e) }, 'orphan cleanup failed'));
    for (const client of this.registries.values()) {
      client.startHeartbeat(this.nodeId(client.cfg.domainId));
    }
  }

  async start(): Promise<void> {
    this.buildRegistryClients();

    // Restore pool reservations from the state before anything new arrives.
    for (const channel of this.deps.state.current.channels) {
      if (channel.allocation) {
        try {
          this.deps.pools.reserve(channel.allocation);
        } catch (e) {
          log.error({ channel: channel.id, err: String(e) }, 'pool recovery failed');
          channel.state = 'failed';
          channel.error = `pool recovery: ${(e as Error).message}`;
        }
      }
    }

    await this.syncRegistries();
    // Anything a previous run left behind is only findable through the query API.
    await this.cleanupOrphans().catch((e) => log.warn({ err: String(e) }, 'orphan cleanup failed'));
    for (const client of this.registries.values()) {
      client.startHeartbeat(this.nodeId(client.cfg.domainId));
    }
    this.reconcileTimer = setInterval(() => void this.reconcile(), 30_000);
    this.reconcileTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const client of this.registries.values()) client.stopHeartbeat();
  }

  /**
   * IS-05 activation of a virtual receiver — the trigger for the whole chain.
   */
  async activate(vrxId: string, conn: ConnectionState): Promise<Channel> {
    const vrx = this.cfg.receivers.find((r) => r.id === vrxId);
    if (!vrx) throw new Error(`unknown virtual receiver ${vrxId}`);
    const device = this.cfg.devices.find((d) => d.id === vrx.deviceId);
    if (!device) throw new Error(`receiver ${vrxId} is not attached to a device`);
    if (!this.isAttached(device))
      throw new Error(`device "${device.label}" points at a domain that does not exist (${device.sourceDomain} → ${device.targetDomain})`);
    const sdp = conn.transport_file.data;
    if (!sdp) throw new Error('activation without a transport_file');
    return this.runChannel({
      key: vrxId,
      device,
      sdp,
      originSenderId: conn.sender_id,
      ...(vrx.proxyFor ? { proxy: vrx.proxyFor } : {}),
    });
  }

  /**
   * Copies an existing sender from one registry into another. Same machinery as an
   * IS-05 activation — the only difference is where the origin SDP comes from: the
   * sender's own manifest instead of a controller's PATCH.
   */
  async copySender(mirrorId: string): Promise<Channel> {
    const mirror = this.cfg.mirrors.find((m) => m.id === mirrorId && m.kind === 'sender');
    if (!mirror) throw new Error(`unknown sender copy ${mirrorId}`);
    const device = this.cfg.devices.find((d) => d.id === mirror.deviceId);
    if (!device) throw new Error(`sender copy ${mirrorId} is not attached to a device`);
    if (!this.isAttached(device))
      throw new Error(`device "${device.label}" points at a domain that does not exist (${device.sourceDomain} → ${device.targetDomain})`);
    const query = this.queries.get(mirror.registryId);
    if (!query) throw new Error(`registry ${mirror.registryId} is not enabled`);

    const sender = await query.sender(mirror.originId);
    const sdp = await query.transportFile(sender);
    log.info({ mirrorId, origin: sender.label, registry: mirror.registryId }, 'copying sender');

    return this.runChannel({
      key: Engine.mirrorKey(mirrorId),
      device,
      sdp,
      originSenderId: sender.id,
      mirrorId,
    });
  }

  /**
   * The shared path: parse, allocate, program the switch, rewrite, publish — and for a
   * proxy receiver, drive the original receiver afterwards.
   */
  private async runChannel(opts: {
    key: string;
    device: FederationDevice;
    sdp: string;
    originSenderId: string | null;
    mirrorId?: string;
    proxy?: { registryId: string; receiverId: string; deviceId: string; mirrorId: string };
  }): Promise<Channel> {
    const { key, device, sdp } = opts;

    await this.deactivate(key); // switching over = tear the old federation down cleanly

    const channel: Channel = {
      id: `ch-${key}`,
      receiverId: key,
      deviceId: device.id,
      ...(opts.mirrorId ? { mirrorId: opts.mirrorId } : {}),
      sourceDomain: device.sourceDomain,
      targetDomain: device.targetDomain,
      state: 'allocating',
      originSdp: sdp,
      originSenderId: opts.originSenderId,
      legs: [],
      allocation: null,
      senderSdp: null,
      publishedIn: [],
      error: null,
      updatedAt: new Date().toISOString(),
    };

    const source = domainById(this.cfg, device.sourceDomain);
    const target = domainById(this.cfg, device.targetDomain);
    let programmed = false;

    try {
      const parsed = parseSdp(sdp);
      // A video+audio SDP is not a redundant pair. Treating its second m= line as the
      // other fabric would NAT an audio group as if it were the video's second path and
      // publish a sender describing only the first essence.
      const essences = essenceCount(parsed);
      if (essences > 1) {
        throw new Error(`SDP describes ${essences} essences — only a single essence, optionally ST 2022-7 redundant, can be federated`);
      }
      channel.legs = assignFabrics(parsed, legOrder(source));
      if (!channel.legs.length) throw new Error('SDP without a usable multicast group');
      essenceFromSdp(parsed); // fail early, before touching the switch

      const useNat = this.cfg.nat.enabled && device.nat;
      if (useNat) {
        channel.allocation = this.deps.pools.allocate(device.targetDomain);
        channel.state = 'programming';
        const plan = buildChannelPlan(channel, this.cfg);
        await programChannel(this.deps.drivers, plan);
        programmed = true;

        const byMediaIndex = new Map(
          channel.legs.map((leg, i) => [
            i,
            {
              group: channel.allocation!.groups[leg.fabric],
              source: channel.allocation!.sources?.[leg.fabric] ?? null,
            },
          ]),
        );
        channel.senderSdp = rewriteSdp(sdp, { byMediaIndex });
      } else {
        // NAT off: the SDP is copied verbatim, the stream flows unchanged.
        channel.senderSdp = sdp;
      }

      channel.state = 'publishing';
      channel.updatedAt = new Date().toISOString();
      this.deps.state.upsertChannel(channel);

      channel.state = 'active';
      channel.publishedIn = this.targetRegistryIds(device);
      channel.updatedAt = new Date().toISOString();
      this.deps.state.upsertChannel(channel);
      await this.deps.state.save();
      await this.syncRegistries(channel.publishedIn);

      // A proxy receiver only becomes useful here: the original receiver in the
      // target domain is pointed at the sender we just published.
      if (opts.proxy) {
        const is05 = this.is05.get(opts.proxy.registryId);
        const senderId = this.senderNmosId(key, device.targetDomain);
        channel.remoteReceiver = {
          registryId: opts.proxy.registryId,
          receiverId: opts.proxy.receiverId,
          connected: false,
          error: null,
        };
        if (!is05) {
          channel.remoteReceiver.error = `registry ${opts.proxy.registryId} is not enabled`;
        } else {
          try {
            await is05.connect(opts.proxy.receiverId, opts.proxy.deviceId, senderId, channel.senderSdp!);
            channel.remoteReceiver.connected = true;
          } catch (e) {
            // The stream exists and is published; only the remote receiver did not
            // take it. That is worth reporting, not worth tearing everything down.
            channel.remoteReceiver.error = (e as Error).message;
            log.warn({ channel: channel.id, err: channel.remoteReceiver.error }, 'remote receiver not connected');
          }
        }
        this.deps.state.upsertChannel(channel);
        await this.deps.state.save();
      }

      log.info(
        {
          channel: channel.id,
          from: device.sourceDomain,
          to: device.targetDomain,
          groups: channel.allocation?.groups,
          natGroupId: channel.allocation?.natGroupId,
          registries: channel.publishedIn,
          ...(channel.remoteReceiver ? { remoteReceiver: channel.remoteReceiver.connected } : {}),
        },
        'channel active',
      );
      this.emit({ type: 'channel', channel });
      return channel;
    } catch (e) {
      channel.state = 'failed';
      channel.error = (e as Error).message;
      channel.updatedAt = new Date().toISOString();
      if (programmed && channel.allocation) {
        await unprogramChannel(this.deps.drivers, buildChannelPlan(channel, this.cfg)).catch(() => {});
      }
      if (channel.allocation) {
        this.deps.pools.release(channel.allocation);
        channel.allocation = null;
      }
      this.deps.state.upsertChannel(channel);
      await this.deps.state.save();
      log.error({ channel: channel.id, err: channel.error }, 'channel failed');
      this.emit({ type: 'channel', channel });
      throw e;
    }
  }

  /**
   * Teardown. The order is mandatory: unregister the sender first, then clear the
   * switch, then release the pool.
   */
  async deactivate(vrxId: string): Promise<void> {
    const channel = this.deps.state.channelFor(vrxId);
    if (!channel) return;

    // A proxied receiver is released before our sender disappears — otherwise it sits
    // subscribed to a stream that is about to stop.
    if (channel.remoteReceiver?.connected) {
      const is05 = this.is05.get(channel.remoteReceiver.registryId);
      const proxy = this.cfg.receivers.find((r) => r.id === channel.receiverId)?.proxyFor;
      if (is05 && proxy) {
        await is05
          .disconnect(channel.remoteReceiver.receiverId, proxy.deviceId)
          .catch((e) => log.warn({ channel: channel.id, err: String(e) }, 'remote receiver not released'));
      }
    }

    const registries = channel.publishedIn.length ? channel.publishedIn : undefined;
    channel.state = 'withdrawing';
    channel.updatedAt = new Date().toISOString();
    this.deps.state.upsertChannel(channel);
    await this.syncRegistries(registries);

    if (channel.allocation) {
      channel.state = 'unprogramming';
      this.deps.state.upsertChannel(channel);
      try {
        await unprogramChannel(this.deps.drivers, buildChannelPlan(channel, this.cfg));
      } catch (e) {
        log.warn({ channel: channel.id, err: String(e) }, 'switch teardown incomplete');
      }
      channel.state = 'releasing';
      this.deps.pools.release(channel.allocation);
      channel.allocation = null;
    }

    this.deps.state.removeChannel(channel.id);
    await this.deps.state.save();
    log.info({ channel: channel.id }, 'channel torn down');
    this.emit({ type: 'channel', channel: { ...channel, state: 'idle' } });
  }

  /** Desired/actual reconciliation: catch registries up, verify switch rules. */
  async reconcile(): Promise<void> {
    await this.syncRegistries();

    // An enabled sender copy with no channel at all has never run, or its channel was
    // lost. Bring it up. A channel in `failed` is left alone — retrying it every
    // interval would just hammer an unreachable registry; that is the Retry button.
    for (const mirror of this.cfg.mirrors) {
      if (mirror.kind !== 'sender' || !mirror.enabled) continue;
      if (this.deps.state.channelFor(Engine.mirrorKey(mirror.id))) continue;
      await this.copySender(mirror.id).catch((e) =>
        log.warn({ mirror: mirror.id, origin: mirror.originLabel, err: String(e) }, 'sender copy failed'),
      );
    }

    for (const [fabric, driver] of Object.entries(this.deps.drivers)) {
      let state;
      try {
        state = await driver.readState();
      } catch (e) {
        this.emit({ type: 'switch', fabric, reachable: false, error: String(e) });
        continue;
      }
      const present = new Set(state.natGroupIds);
      for (const channel of this.activeChannels()) {
        if (!channel.allocation) continue;
        if (!channel.legs.some((l) => l.fabric === fabric)) continue;
        if (!present.has(channel.allocation.natGroupId)) {
          log.warn({ channel: channel.id, fabric, natGroupId: channel.allocation.natGroupId }, 'NAT rule missing, reprogramming');
          const plan = buildChannelPlan(channel, this.cfg);
          const fabricPlan = plan.fabrics.find((f) => f.fabric === fabric);
          if (fabricPlan) await driver.program(fabricPlan, channel.id).catch((e) => log.warn({ err: String(e) }, 'reprogramming failed'));
        }
      }
    }
  }

  // -- Information for the GUI ---------------------------------------------
  /** A virtual receiver's active IS-05 state — for the retry button. */
  connectionOf(vrxId: string): ConnectionState | null {
    return this.deps.state.current.connections[vrxId]?.active ?? null;
  }

  /** On-demand reachability test for one registry — the Test button in the settings. */
  async probeRegistry(id: string) {
    const client = this.registries.get(id);
    if (!client) return null;
    const result = await client.probe();
    this.emit({ type: 'registry', registry: id, status: client.status() });
    return result;
  }

  /**
   * Status of every configured registry. Entries that have no client yet — disabled,
   * or added since the last restart — are reported as such instead of being dropped,
   * so the GUI never silently hides a registry.
   */
  registryStatus() {
    return this.cfg.registries.map((reg) => {
      const client = this.registries.get(reg.id);
      if (client) return client.status();
      return {
        id: reg.id,
        label: reg.label,
        domainId: reg.domainId,
        mode: reg.mode,
        version: reg.version,
        url: null,
        reachable: false,
        state: reg.enabled ? ('unknown' as const) : ('disabled' as const),
        error: reg.enabled ? 'no client yet' : null,
        resources: { total: 0, node: 0, device: 0, source: 0, flow: 0, sender: 0, receiver: 0 },
        heartbeat: { lastOkAt: null, ageSeconds: null, failures: 0 },
      };
    });
  }

  /**
   * Runs DNS-SD on demand and reports what was found *and* what was queried — a
   * discovery failure is only actionable if you can see the names that were tried and
   * which search domain they came from.
   */
  async discover(opts: { domain?: string; version?: string } = {}) {
    const searchDomains = await hostSearchDomains();
    const result = await discoverRegistries({
      ...(opts.domain ? { domain: opts.domain } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    });
    return { ...result, searchDomains, usedDomain: opts.domain || null };
  }

  /** Drops cached DNS-SD addresses so the next contact resolves again. */
  rediscover(): void {
    for (const client of this.registries.values()) {
      if (client.cfg.mode === 'dnssd') client.forgetAddress();
    }
  }

  async probeSwitch(fabric: string) {
    const driver = this.deps.drivers[fabric];
    if (!driver) return null;
    return driver.probe();
  }

  channels(): Channel[] {
    return this.deps.state.current.channels;
  }

  async status() {
    const switches: Record<string, unknown> = {};
    for (const [fabric, driver] of Object.entries(this.deps.drivers)) {
      switches[fabric] = await driver.probe();
    }
    return {
      nat: { enabled: this.cfg.nat.enabled, driver: this.cfg.nat.driver },
      switches,
      registries: this.registryStatus(),
      pools: this.deps.pools.status(),
      domains: this.cfg.domains.map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        nodeId: this.nodeId(d.id),
        registries: registriesOf(this.cfg, d.id).map((r) => r.id),
      })),
      channels: this.channels().length,
      version: nmosVersion(),
    };
  }
}
