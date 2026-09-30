import type { AppConfig, DomainConfig } from '../config/schema.js';
import { domainById, registriesOf } from '../config/schema.js';
import { RegistryClient, REGISTER_ORDER, type ResourceType } from '../nmos/registry-client.js';
import {
  MEDIA_TYPES,
  buildDevice,
  buildFlow,
  buildNode,
  buildReceiver,
  buildSender,
  buildSource,
  essenceFromSdp,
  nmosVersion,
  uuidv5,
  type EssenceParams,
} from '../nmos/resources.js';
import { assignFabrics, parseSdp, rewriteSdp } from '../nmos/sdp.js';
import { programChannel, unprogramChannel, type SwitchDriver } from '../switch/driver.js';
import type { Channel, FederationDevice, VirtualReceiver } from '../types.js';
import { buildChannelPlan } from './channel.js';
import type { PoolManager } from './pools.js';
import type { ConnectionState, StateStore } from './state.js';
import { log } from '../util/log.js';

export interface EngineEvent {
  type: 'channel' | 'registry' | 'switch';
  [key: string]: unknown;
}

export interface EngineDeps {
  /** Provider, kein Snapshot: ein Settings-Speichern ersetzt das Config-Objekt,
   *  und Engine wie Node-API müssen danach die neue Fassung sehen. */
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
 * Orchestrator: hält die Registry-Clients, baut den Ressourcenbaum je Domäne und
 * führt Channels auf und ab.
 *
 * Kernidee für alles Registry-bezogene: es gibt genau eine Funktion, die den
 * Soll-Zustand einer Registry herstellt (`syncRegistry`). Erstregistrierung,
 * Neu-Registrierung nach Heartbeat-404, Veröffentlichen eines neuen Senders,
 * Abmelden beim Abbau und Reconciliation sind derselbe Codepfad.
 */
export class Engine {
  readonly registries = new Map<string, RegistryClient>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** Tatsächlich gebundener Node-API-Port je Domäne — kann vom Wunschport abweichen,
   *  wenn zwei Domänen auf derselben IP liegen. hrefs müssen das widerspiegeln. */
  private readonly domainPorts = new Map<string, number>();

  constructor(private deps: EngineDeps) {}

  private get cfg(): AppConfig {
    return this.deps.config();
  }

  /** Für Node-API und REST: immer die aktuelle Fassung. */
  get config(): AppConfig {
    return this.cfg;
  }

  /** Pools hängen an den Domänen-Konfigurationen und müssen nach einer
   *  Settings-Änderung neu gebaut werden. */
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

  // -- Ressourcenbaum ------------------------------------------------------
  private connectionBase(domain: DomainConfig): string {
    return `http://${domain.iface.address}:${this.portOf(domain.id)}/x-nmos/connection/v1.1`;
  }

  private nodeResource(domain: DomainConfig) {
    return buildNode(
      {
        id: this.nodeId(domain.id),
        href: `http://${domain.iface.address}:${this.portOf(domain.id)}/`,
        address: domain.iface.address,
        port: this.portOf(domain.id),
        interfaceName: domain.iface.name,
      },
      `NMOS Federation — ${domain.label}`,
      { refclk: domain.ptpRefclk },
    );
  }

  receiversOf(device: FederationDevice): VirtualReceiver[] {
    return this.cfg.receivers.filter((r) => r.deviceId === device.id);
  }

  /** Nur aktive Channels tragen einen veröffentlichten Sender. */
  private activeChannels(): Channel[] {
    return this.deps.state.current.channels.filter((c) => c.state === 'active');
  }

  private essenceOf(channel: Channel): EssenceParams | null {
    if (!channel.originSdp) return null;
    try {
      return essenceFromSdp(channel.originSdp);
    } catch (e) {
      log.warn({ channel: channel.id, err: String(e) }, 'Essence nicht ableitbar');
      return null;
    }
  }

  /** Alle Ressourcen einer Domäne — genau das, was die Node API dort ausliefert. */
  domainResources(domainId: string) {
    const domain = domainById(this.cfg, domainId);
    const devices: ReturnType<typeof buildDevice>[] = [];
    const receivers: ReturnType<typeof buildReceiver>[] = [];
    const senders: ReturnType<typeof buildSender>[] = [];
    const sources: ReturnType<typeof buildSource>[] = [];
    const flows: ReturnType<typeof buildFlow>[] = [];
    const active = this.activeChannels();

    for (const device of this.cfg.devices) {
      const vrxList = this.receiversOf(device);

      if (device.sourceDomain === domainId) {
        const devId = this.deviceId(device.id, domainId);
        for (const vrx of vrxList) {
          const conn = this.deps.state.connection(vrx.id).active;
          const caps = MEDIA_TYPES[vrx.format];
          receivers.push(
            buildReceiver(
              this.receiverNmosId(vrx.id, domainId),
              devId,
              vrx.label,
              caps.format,
              caps.mediaTypes,
              [domain.iface.name],
              { sender_id: conn.sender_id, active: conn.master_enable },
            ),
          );
        }
        devices.push(
          buildDevice(
            devId,
            this.nodeId(domainId),
            device.label,
            this.connectionBase(domain),
            [],
            vrxList.map((v) => this.receiverNmosId(v.id, domainId)),
          ),
        );
      }

      if (device.targetDomain === domainId) {
        const mirrorId = this.deviceId(`${device.id}:mirror`, domainId);
        const mine = active.filter((c) => c.deviceId === device.id);
        for (const channel of mine) {
          const essence = this.essenceOf(channel);
          if (!essence) continue;
          const vrxId = channel.receiverId;
          const label = essence.label ?? this.cfg.receivers.find((r) => r.id === vrxId)?.label ?? vrxId;
          const sourceId = this.sourceNmosId(vrxId, domainId);
          const flowId = this.flowNmosId(vrxId, domainId);
          const senderId = this.senderNmosId(vrxId, domainId);
          sources.push(buildSource(sourceId, mirrorId, label, essence));
          flows.push(buildFlow(flowId, sourceId, mirrorId, label, essence));
          senders.push(
            buildSender(
              senderId,
              flowId,
              mirrorId,
              label,
              `${this.connectionBase(domain)}/single/senders/${senderId}/transportfile`,
              [domain.iface.name],
            ),
          );
        }
        devices.push(
          buildDevice(
            mirrorId,
            this.nodeId(domainId),
            device.mirrorLabel || `${device.label} ▸ ${device.sourceDomain}`,
            this.connectionBase(domain),
            mine.map((c) => this.senderNmosId(c.receiverId, domainId)),
            [],
          ),
        );
      }
    }

    return { self: this.nodeResource(domain), devices, receivers, senders, sources, flows };
  }

  /** Welche Registries dieses Device auf der Zielseite bedient. */
  private targetRegistryIds(device: FederationDevice): string[] {
    const all = registriesOf(this.cfg, device.targetDomain).map((r) => r.id);
    if (!device.targetRegistries.length) return all;
    return device.targetRegistries.filter((id) => all.includes(id));
  }

  /**
   * Soll-Zustand je Registry. Node und Devices gehen an jede Registry, in der
   * überhaupt etwas von uns steht; Sender nur an die Ziel-Registries ihres Devices.
   */
  registrationPlan(): Map<string, Resource[]> {
    const plan = new Map<string, Resource[]>();
    const add = (registryId: string, res: Resource) => {
      const list = plan.get(registryId) ?? [];
      if (!list.some((r) => r.type === res.type && r.data.id === res.data.id)) list.push(res);
      plan.set(registryId, list);
    };

    for (const device of this.cfg.devices) {
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

  /** Stellt den Soll-Zustand einer Registry her. Fehler werden gemeldet, nicht geworfen. */
  async syncRegistry(client: RegistryClient): Promise<void> {
    const desired = this.registrationPlan().get(client.id) ?? [];
    const desiredKeys = new Set(desired.map((r) => `${r.type}:${r.data.id}`));

    // Erst weg, was nicht mehr sein soll — Kinder vor Eltern, und der Sender
    // zuerst: niemand soll auf einen Strom schalten, den wir gleich abräumen.
    for (const type of [...REGISTER_ORDER].reverse()) {
      for (const key of [...client.registered]) {
        const [t, id] = key.split(':') as [ResourceType, string];
        if (t === type && !desiredKeys.has(key)) {
          await client.unregister(t, id).catch((e) => log.warn({ registry: client.id, key, err: String(e) }, 'Abmelden fehlgeschlagen'));
        }
      }
    }

    // Dann anlegen/aktualisieren, Eltern vor Kindern.
    for (const type of REGISTER_ORDER) {
      for (const res of desired.filter((r) => r.type === type)) {
        try {
          await client.register(res.type, res.data);
        } catch (e) {
          log.warn({ registry: client.id, type: res.type, id: res.data.id, err: String(e) }, 'Registrieren fehlgeschlagen');
        }
      }
    }
    this.emit({ type: 'registry', registry: client.id, status: client.status() });
  }

  async syncRegistries(registryIds?: string[]): Promise<void> {
    const ids = registryIds ?? [...this.registries.keys()];
    for (const id of ids) {
      const client = this.registries.get(id);
      if (client) await this.syncRegistry(client);
    }
  }

  // -- Lebenszyklus --------------------------------------------------------
  private buildRegistryClients(): void {
    for (const client of this.registries.values()) client.stopHeartbeat();
    this.registries.clear();
    for (const reg of this.cfg.registries.filter((r) => r.enabled)) {
      const client = new RegistryClient(reg, (c) => {
        this.syncRegistry(c).catch(() => {});
      });
      this.registries.set(reg.id, client);
    }
  }

  /** Nach einer Settings-Änderung: Clients neu aufbauen, Soll-Zustand herstellen. */
  async restartRegistries(): Promise<void> {
    this.buildRegistryClients();
    await this.syncRegistries();
    for (const client of this.registries.values()) {
      client.startHeartbeat(this.nodeId(client.cfg.domainId));
    }
  }

  async start(): Promise<void> {
    this.buildRegistryClients();

    // Pool-Reservierungen aus dem State wiederherstellen, bevor irgendwas Neues kommt.
    for (const channel of this.deps.state.current.channels) {
      if (channel.allocation) {
        try {
          this.deps.pools.reserve(channel.allocation);
        } catch (e) {
          log.error({ channel: channel.id, err: String(e) }, 'Pool-Recovery fehlgeschlagen');
          channel.state = 'failed';
          channel.error = `Pool-Recovery: ${(e as Error).message}`;
        }
      }
    }

    await this.syncRegistries();
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
   * IS-05-Aktivierung eines virtuellen Receivers — der Auslöser der ganzen Kette.
   */
  async activate(vrxId: string, conn: ConnectionState): Promise<Channel> {
    const vrx = this.cfg.receivers.find((r) => r.id === vrxId);
    if (!vrx) throw new Error(`unbekannter virtueller Receiver ${vrxId}`);
    const device = this.cfg.devices.find((d) => d.id === vrx.deviceId);
    if (!device) throw new Error(`Receiver ${vrxId} hängt an keinem Device`);
    const sdp = conn.transport_file.data;
    if (!sdp) throw new Error('Aktivierung ohne transport_file');

    await this.deactivate(vrxId); // Umschalten = alte Federation sauber abbauen

    const channel: Channel = {
      id: `ch-${vrxId}`,
      receiverId: vrxId,
      deviceId: device.id,
      sourceDomain: device.sourceDomain,
      targetDomain: device.targetDomain,
      state: 'allocating',
      originSdp: sdp,
      originSenderId: conn.sender_id,
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
      channel.legs = assignFabrics(parsed, source.fabricSubnets);
      if (!channel.legs.length) throw new Error('SDP ohne verwertbare Multicast-Gruppe');
      essenceFromSdp(parsed); // früh scheitern, bevor der Switch angefasst wird

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
        channel.senderSdp = rewriteSdp(sdp, {
          byMediaIndex,
          ...(target.ptpRefclk ? { tsRefclk: target.ptpRefclk } : {}),
        });
      } else {
        // NAT aus: SDP wird 1:1 kopiert, der Strom fließt unverändert.
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

      log.info(
        {
          channel: channel.id,
          from: device.sourceDomain,
          to: device.targetDomain,
          groups: channel.allocation?.groups,
          natGroupId: channel.allocation?.natGroupId,
          registries: channel.publishedIn,
        },
        'Channel aktiv',
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
      log.error({ channel: channel.id, err: channel.error }, 'Channel fehlgeschlagen');
      this.emit({ type: 'channel', channel });
      throw e;
    }
  }

  /**
   * Abbau. Reihenfolge ist Pflicht: erst den Sender abmelden, dann den Switch
   * abräumen, dann den Pool freigeben.
   */
  async deactivate(vrxId: string): Promise<void> {
    const channel = this.deps.state.channelFor(vrxId);
    if (!channel) return;

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
        log.warn({ channel: channel.id, err: String(e) }, 'Switch-Abbau unvollständig');
      }
      channel.state = 'releasing';
      this.deps.pools.release(channel.allocation);
      channel.allocation = null;
    }

    this.deps.state.removeChannel(channel.id);
    await this.deps.state.save();
    log.info({ channel: channel.id }, 'Channel abgebaut');
    this.emit({ type: 'channel', channel: { ...channel, state: 'idle' } });
  }

  /** Soll/Ist-Abgleich: Registries nachziehen, Switch-Regeln prüfen. */
  async reconcile(): Promise<void> {
    await this.syncRegistries();

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
          log.warn({ channel: channel.id, fabric, natGroupId: channel.allocation.natGroupId }, 'NAT-Regel fehlt, programmiere nach');
          const plan = buildChannelPlan(channel, this.cfg);
          const fabricPlan = plan.fabrics.find((f) => f.fabric === fabric);
          if (fabricPlan) await driver.program(fabricPlan, channel.id).catch((e) => log.warn({ err: String(e) }, 'Nachprogrammieren fehlgeschlagen'));
        }
      }
    }
  }

  // -- Auskunft fürs GUI ---------------------------------------------------
  /** Aktiver IS-05-Zustand eines virtuellen Receivers — für den Retry-Knopf. */
  connectionOf(vrxId: string): ConnectionState | null {
    return this.deps.state.current.connections[vrxId]?.active ?? null;
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
      registries: [...this.registries.values()].map((c) => c.status()),
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
