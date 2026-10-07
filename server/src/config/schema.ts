import type { Bridge, Fabric, FederationDevice, VirtualReceiver } from '../types.js';
import type { PoolConfig } from '../federation/pool.js';
import type { AristaConfig } from '../switch/arista-eapi.js';

/**
 * A domain is a network with its own registry view: its own interface, its own
 * federation pool, its own L3 interface on both switches. Exactly one domain is
 * `internal`, plus any number of external ones.
 *
 * Several partner registries in the same network = one domain with several
 * registries. Partners in separate networks = several domains.
 */
export interface DomainConfig {
  /**
   * Opaque key. Bridges refer to it through domains, receivers through side, registries
   * through domainId — so it must never change once anything points at it. New entries
   * get the next free number; it is not shown in the GUI and carries no meaning.
   * Older configurations with names like "internal" keep working: it is just a string.
   */
  id: string;
  label: string;
  kind: 'internal' | 'external';
  /** Reachability of the node API from this domain + interface_bindings. */
  iface: { name: string; address: string };
  /**
   * Which fabric the FIRST `m=` line of an SDP belongs to. The rest follows from it.
   *
   * Deliberately not detected from source subnets: the configuration already states
   * where each domain hangs on each switch, so the mapping is a property of the plant,
   * not something to infer from an address — and inferring it wrongly silently NATs a
   * stream onto the wrong fabric.
   */
  firstLeg: Fabric;
  /** This domain's L3 interface per switch: ingress when source, egress when target. */
  switchInterface: Record<Fabric, string>;
  /** Pool for senders created **in** this domain. */
  pool: PoolConfig;
  enabled: boolean;
}

export interface RegistryConfig {
  /** Opaque key, see DomainConfig.id. Bridges and copies refer to it through registries. */
  id: string;
  label: string;
  /** Domain this registry is reached through. */
  domainId: string;
  mode: 'dnssd' | 'manual';
  /** IP or hostname, for mode=manual. */
  ip?: string;
  /** Port of the registration API. Defaults to 80; nmos-cpp configured with a
   *  single `http_port` typically listens on 8010. */
  port?: number;
  /** Port of the query API, if it differs from the registration port. nmos-cpp only
   *  shares one port when configured with a single `http_port`. */
  queryPort?: number;
  /** https instead of http. */
  tls?: boolean;
  /** Legacy: a full base URL. Migrated to ip/port/tls on load. */
  url?: string;
  version: 'v1.3' | 'v1.2';
  enabled: boolean;
}

export const DEFAULT_REGISTRY_PORT = 80;

/** Base URL of a manually configured registry, assembled from ip, port and tls. */
export function registryUrl(cfg: RegistryConfig): string | null {
  if (!cfg.ip) return null;
  const scheme = cfg.tls ? 'https' : 'http';
  const port = cfg.port ?? DEFAULT_REGISTRY_PORT;
  const host = cfg.ip.includes(':') ? `[${cfg.ip}]` : cfg.ip; // IPv6 literal
  const isDefaultPort = (cfg.tls && port === 443) || (!cfg.tls && port === 80);
  return isDefaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

/**
 * The smallest positive integer not already in use, as a string. Numbers rather than
 * names because the id is a key: a name invites editing it, and editing it detaches
 * everything that refers to it.
 */
export function nextId(existing: string[]): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

/**
 * Fills in missing ids, so an API client does not have to invent them and the GUI never
 * has to show the field. Entries that already carry an id keep it untouched.
 */
/**
 * Older configurations put the direction, the target registries and the NAT flag on each
 * device. Those belong to the bridge now, so devices sharing them are grouped into one —
 * normally a single bridge per pair of domains, which is exactly what the node is meant
 * to represent.
 */
function migrateDevicesToBridges(cfg: AppConfig): void {
  const legacy = cfg.devices.filter((d) => !d.bridgeId);
  if (!legacy.length) return;

  const byShape = new Map<string, Bridge>();
  for (const dev of legacy) {
    const old = dev as unknown as {
      sourceDomain?: string;
      targetDomain?: string;
      targetRegistries?: string[];
      nat?: boolean;
    };
    const registries = [...(old.targetRegistries ?? [])].sort();
    const shape = `${old.sourceDomain}|${old.targetDomain}|${old.nat}|${registries.join(',')}`;
    let bridge = byShape.get(shape);
    if (!bridge) {
      const src = cfg.domains.find((d) => d.id === old.sourceDomain)?.label ?? old.sourceDomain ?? '?';
      const tgt = cfg.domains.find((d) => d.id === old.targetDomain)?.label ?? old.targetDomain ?? '?';
      bridge = {
        id: nextId(cfg.bridges.map((b) => b.id)),
        label: `${src} → ${tgt}`,
        domains: [old.sourceDomain ?? '', old.targetDomain ?? ''],
        registries: old.targetRegistries ?? [],
        nat: old.nat ?? true,
        enabled: true,
      };
      cfg.bridges.push(bridge);
      byShape.set(shape, bridge);
    }
    dev.bridgeId = bridge.id;
    for (const key of ['sourceDomain', 'targetDomain', 'targetRegistries', 'nat']) {
      delete (dev as unknown as Record<string, unknown>)[key];
    }
  }
}

/**
 * Bridges used to carry a direction (source → target, target registries only). The
 * direction now belongs to each port, so a directed bridge becomes an undirected one:
 * its domains in the old order, its target registry choice kept as it was — that list
 * only names registries of the old target domain, which per-domain semantics leave
 * the old source side at "all", exactly as before. Every receiver on it keeps the
 * side it always had: the old source.
 */
function migrateDirectedBridges(cfg: AppConfig): void {
  for (const b of cfg.bridges) {
    const old = b as unknown as { sourceDomain?: string; targetDomain?: string; targetRegistries?: string[] };
    if (old.sourceDomain === undefined && old.targetDomain === undefined) continue;
    const source = old.sourceDomain ?? '';
    b.domains = [source, old.targetDomain ?? ''];
    b.registries ??= old.targetRegistries ?? [];
    const devices = new Set(cfg.devices.filter((d) => d.bridgeId === b.id).map((d) => d.id));
    for (const r of cfg.receivers ?? []) if (devices.has(r.deviceId) && !r.side) r.side = source;
    delete old.sourceDomain;
    delete old.targetDomain;
    delete old.targetRegistries;
  }
}

/** The domain of a bridge that is not `domainId`; undefined when it is not one of them. */
export function otherDomain(bridge: Bridge, domainId: string): string | undefined {
  if (bridge.domains[0] === domainId) return bridge.domains[1];
  if (bridge.domains[1] === domainId) return bridge.domains[0];
  return undefined;
}

export function normalizeConfig(cfg: AppConfig): AppConfig {
  cfg.bridges ??= [];
  migrateDevicesToBridges(cfg);
  migrateDirectedBridges(cfg);
  for (const b of cfg.bridges) {
    if (!Array.isArray(b.domains) || b.domains.length !== 2) b.domains = [b.domains?.[0] ?? '', b.domains?.[1] ?? ''];
    b.registries ??= [];
  }
  for (const r of cfg.receivers ?? []) {
    const device = cfg.devices.find((d) => d.id === r.deviceId);
    const bridge = device && cfg.bridges.find((b) => b.id === device.bridgeId);
    if (bridge && (!r.side || !bridge.domains.includes(r.side))) r.side = bridge.domains[0];
  }
  delete (cfg as unknown as Record<string, unknown>)['nodeLabel'];
  // Proxies named by the old scheme, "<origin> (proxy)", get the new one. One the
  // operator renamed is left alone: only the exact generated form is touched.
  for (const r of cfg.receivers ?? []) {
    const origin = r.proxyFor && cfg.mirrors?.find((m) => m.id === r.proxyFor!.mirrorId)?.originLabel;
    if (origin && r.label === `${origin} (proxy)`) r.label = proxyLabel(origin);
  }
  for (const b of cfg.bridges) {
    if (!b.label?.trim()) b.label = DEFAULT_BRIDGE_LABEL;
    if (!b.id) b.id = nextId(cfg.bridges.map((x) => x.id));
  }
  for (const d of cfg.domains) {
    // Added later; an older file simply has no leg order yet.
    if (d.firstLeg !== 'red' && d.firstLeg !== 'blue') d.firstLeg = 'red';
    // Fields that no longer exist. Leaving them makes the file look like it still
    // configures something it does not.
    delete (d as unknown as Record<string, unknown>)['fabricSubnets'];
    delete (d as unknown as Record<string, unknown>)['ptpRefclk'];
  }
  for (const r of cfg.registries) delete (r as unknown as Record<string, unknown>)['domain'];
  return normalizeIds(cfg);
}

export function normalizeIds(cfg: AppConfig): AppConfig {
  for (const d of cfg.domains) {
    if (!d.id) d.id = nextId(cfg.domains.map((x) => x.id));
  }
  for (const r of cfg.registries) {
    if (!r.id) r.id = nextId(cfg.registries.map((x) => x.id));
  }
  return cfg;
}

/** Leg order of a domain: the first `m=` line, then the other fabric. */
export function legOrder(domain: DomainConfig): Fabric[] {
  return domain.firstLeg === 'blue' ? ['blue', 'red'] : ['red', 'blue'];
}

/**
 * Accepts a configuration that still carries a full `url` and turns it into
 * ip/port/tls, so an existing config.json keeps working after the upgrade.
 */
export function migrateRegistry(cfg: RegistryConfig): RegistryConfig {
  if (!cfg.url || cfg.ip) {
    const { url: _drop, ...rest } = cfg;
    return cfg.ip ? (rest as RegistryConfig) : cfg;
  }
  try {
    const parsed = new URL(cfg.url);
    const tls = parsed.protocol === 'https:';
    const { url: _drop, ...rest } = cfg;
    return {
      ...rest,
      ip: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : tls ? 443 : 80,
      tls,
    } as RegistryConfig;
  } catch {
    return cfg; // unparseable — validation will complain about the missing ip
  }
}

export interface NatConfig {
  enabled: boolean;
  /** Credentials per fabric. The L3 interfaces live on the domains. */
  switches: Record<Fabric, AristaConfig>;
  /** Range EOS NAT group numbers are taken from — applies per switch. */
  groupIdRange: [number, number];
  /** mock = touch no hardware, just log. */
  driver: 'arista-eapi' | 'mock';
}

/**
 * A direct copy of an existing resource from one registry into another — the second
 * operating mode next to federation. There is no connection event to wait for: the
 * copy is created on request.
 *
 * Both kinds hang off a federation device, which supplies the direction, the target
 * registries and the NAT setting. That keeps a copy and a federation channel the same
 * thing internally.
 *
 *  - `sender`:   the original lives in the device's SOURCE domain, the copy appears in
 *                its TARGET domain. The origin SDP comes from the sender's manifest.
 *  - `receiver`: the original lives in the device's TARGET domain, and a proxy
 *                receiver appears in its SOURCE domain. Connecting a stream to the
 *                proxy drives the original receiver over IS-05.
 */
export interface MirrorEntry {
  id: string;
  kind: 'sender' | 'receiver';
  /** Federation device the copy belongs to. */
  deviceId: string;
  /** Registry the original was read from. */
  registryId: string;
  /** The original resource's NMOS id. */
  originId: string;
  /** The original's device id — needed to find its connection API. */
  originDeviceId: string;
  /** Label at the time of copying, for display when the origin is unreachable. */
  originLabel: string;
  /** Overrides the label of the copy; empty = the origin's label. */
  label?: string;
  /**
   * Where this copy is shared — always the other domain than the one it was copied
   * from: a sender copy is published there, a receiver proxy offered there. Default
   * (empty): the bridge's registries in that domain.
   */
  registries?: string[];
  enabled: boolean;
  /** Natural group set by the operator for a sender copy (a proxy keeps it on its receiver). */
  group?: string;
  /**
   * The original's group hint (BCP-002-01) and its device's label, read when the copy
   * was made. `undefined` = not read yet, `null` = the original has none.
   */
  originGroupHint?: string | null;
  originDeviceLabel?: string | null;
}

export interface AppConfig {
  /** REST + WebSocket + GUI, bound to 0.0.0.0. */
  port: number;
  /** NMOS Node/Connection API. One listener per domain on that domain's IP —
   *  which is what makes the same port usable several times. */
  nmosPort: number;
  domains: DomainConfig[];
  registries: RegistryConfig[];
  nat: NatConfig;
  /** Each one is an NMOS node; everything else hangs off them. */
  bridges: Bridge[];
  devices: FederationDevice[];
  receivers: VirtualReceiver[];
  /** Direct registry-to-registry copies. */
  mirrors: MirrorEntry[];
}

const emptyPool = (base: string): PoolConfig => ({ base, pairs: 64, sourceNat: null });

export const DEFAULT_BRIDGE_LABEL = 'NMOS Federation';

/**
 * Name of a receiver proxy. "Proxy" goes in front: origin labels typically end in a
 * number ("Monitor 3"), and a controller sorting or scanning a list reads that number
 * last — "Monitor 3 (proxy)" buried it.
 */
export const proxyLabel = (originLabel: string): string => `Proxy ${originLabel}`;

export const DEFAULT_CONFIG: AppConfig = {
  port: 8080,
  nmosPort: 8081,
  domains: [
    {
      id: '1',
      label: 'Internal system',
      kind: 'internal',
      iface: { name: 'eth0', address: '127.0.0.1' },
      firstLeg: 'red',
      switchInterface: { red: '', blue: '' },
      pool: emptyPool('239.201.0.0'),
      enabled: true,
    },
  ],
  registries: [
    // Disabled on purpose. A freshly started or just-reset container must not announce
    // itself into whatever registry it happens to discover — the operator enables it
    // once the domain's address is right.
    { id: '1', label: 'Internal registry', domainId: '1', mode: 'dnssd', version: 'v1.3', enabled: false },
  ],
  nat: {
    enabled: false,
    driver: 'mock',
    groupIdRange: [100, 999],
    switches: {
      red: { host: '', user: '', password: '', tls: true, join: 'igmpStatic' },
      blue: { host: '', user: '', password: '', tls: true, join: 'igmpStatic' },
    },
  },
  bridges: [],
  devices: [],
  receivers: [],
  mirrors: [],
};

export function bridgeOf(cfg: AppConfig, device: FederationDevice): Bridge | undefined {
  return cfg.bridges.find((b) => b.id === device.bridgeId);
}

export function domainById(cfg: AppConfig, id: string): DomainConfig {
  const d = cfg.domains.find((x) => x.id === id);
  if (!d) throw new Error(`no domain ${id} configured`);
  return d;
}

/** A domain's registries — several per domain is the normal case. */
export function registriesOf(cfg: AppConfig, domainId: string): RegistryConfig[] {
  return cfg.registries.filter((r) => r.domainId === domainId && r.enabled);
}
