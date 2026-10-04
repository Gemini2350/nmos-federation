import type { Fabric, FederationDevice, VirtualReceiver } from '../types.js';
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
  /** DNS-SD search domain, for mode=dnssd. Empty = the host's own search domain. */
  domain?: string;
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
  enabled: boolean;
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
  devices: FederationDevice[];
  receivers: VirtualReceiver[];
  /** Direct registry-to-registry copies. */
  mirrors: MirrorEntry[];
}

const emptyPool = (base: string): PoolConfig => ({ base, pairs: 64, sourceNat: null });

export const DEFAULT_CONFIG: AppConfig = {
  port: 8080,
  nmosPort: 8081,
  domains: [
    {
      id: 'internal',
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
    { id: 'internal', label: 'Internal registry', domainId: 'internal', mode: 'dnssd', version: 'v1.3', enabled: true },
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
  devices: [],
  receivers: [],
  mirrors: [],
};

export function domainById(cfg: AppConfig, id: string): DomainConfig {
  const d = cfg.domains.find((x) => x.id === id);
  if (!d) throw new Error(`no domain ${id} configured`);
  return d;
}

/** A domain's registries — several per domain is the normal case. */
export function registriesOf(cfg: AppConfig, domainId: string): RegistryConfig[] {
  return cfg.registries.filter((r) => r.domainId === domainId && r.enabled);
}
