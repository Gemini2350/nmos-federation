/** Thin client for the backend. Endpoints: see server/src/api/rest.ts. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Fabric2<T> {
  red: T;
  blue: T;
}

export interface Pool {
  base: string;
  pairs: number;
  sourceNat: Fabric2<string> | null;
}

export interface Domain {
  id: string;
  label: string;
  kind: 'internal' | 'external';
  iface: { name: string; address: string };
  firstLeg: 'red' | 'blue';
  switchInterface: Fabric2<string>;
  pool: Pool;
  enabled: boolean;
}

export interface Registry {
  id: string;
  label: string;
  domainId: string;
  mode: 'dnssd' | 'manual';
  /** IP or hostname, for mode=manual. */
  ip?: string;
  /** Port of the registration API. Defaults to 80; nmos-cpp with a single
   *  http_port typically listens on 8010. */
  port?: number;
  tls?: boolean;
  version: 'v1.3' | 'v1.2';
  enabled: boolean;
}

export const DEFAULT_REGISTRY_PORT = 80;

/** Mirrors the backend: the URL is derived, never typed in by hand. */
export function registryUrl(r: Registry): string | null {
  if (r.mode === 'dnssd') return null;
  if (!r.ip) return null;
  const scheme = r.tls ? 'https' : 'http';
  const port = r.port ?? DEFAULT_REGISTRY_PORT;
  const host = r.ip.includes(':') ? `[${r.ip}]` : r.ip;
  const isDefaultPort = (r.tls && port === 443) || (!r.tls && port === 80);
  return isDefaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

export interface Switch {
  host: string;
  user: string;
  password: string;
  tls: boolean;
  join: 'igmpStatic' | 'pim' | 'none';
}

export interface Device {
  id: string;
  label: string;
  sourceDomain: string;
  targetDomain: string;
  targetRegistries: string[];
  nat: boolean;
  mirrorLabel?: string;
  receiverIds: string[];
  receivers?: VirtualReceiver[];
  /** True when a domain it points at no longer exists — it registers nothing. */
  detached?: boolean;
  missing?: { sourceDomain: string | null; targetDomain: string | null; registries: string[] };
}

export interface VirtualReceiver {
  id: string;
  label: string;
  deviceId: string;
  format: 'video' | 'audio' | 'data';
  enabled: boolean;
}

export interface Config {
  port: number;
  nmosPort: number;
  domains: Domain[];
  registries: Registry[];
  nat: { enabled: boolean; driver: 'arista-eapi' | 'mock'; groupIdRange: [number, number]; switches: Fabric2<Switch> };
  devices: Device[];
  receivers: VirtualReceiver[];
}

export interface BrowseSender {
  id: string;
  label: string;
  device_id: string;
  deviceLabel: string;
  nodeId: string | null;
  manifest_href: string | null;
  transport: string;
  /** Belongs to one of our own nodes — copying a copy is rarely what you want. */
  ours: boolean;
  copied: boolean;
  controllable: boolean;
  flow: { media_type: string; frame_width?: number; frame_height?: number; grain_rate?: { numerator: number; denominator?: number } } | null;
}

export interface BrowseReceiver {
  id: string;
  label: string;
  device_id: string;
  deviceLabel: string;
  nodeId: string | null;
  format: string;
  transport: string;
  caps?: { media_types?: string[] };
  subscription?: { sender_id: string | null; active: boolean };
  ours: boolean;
  copied: boolean;
  /** Advertises an sr-ctrl control, so it can be driven over IS-05. */
  controllable: boolean;
}

export interface Discovered {
  instance: string;
  url: string;
  /** Host as announced in SRV — may be an unresolvable .local name. */
  host: string;
  address: string | null;
  /** Where the address came from; an instance-name guess is shown as such. */
  addressSource: 'a-record' | 'instance-name' | null;
  port: number;
  proto: 'http' | 'https';
  versions: string[];
  priority: number;
  via: 'unicast' | 'mdns';
  serviceType: string;
  domain: string;
}

export interface DiscoveryResult {
  found: Discovered[];
  /** Every name that was queried — what makes a failure diagnosable. */
  tried: string[];
  notes: string[];
  /** Search domains the host has, i.e. what DHCP handed out. */
  searchDomains: string[];
  usedDomain: string | null;
}

export interface Mirror {
  id: string;
  kind: 'sender' | 'receiver';
  deviceId: string;
  registryId: string;
  originId: string;
  originDeviceId: string;
  originLabel: string;
  label?: string;
  enabled: boolean;
  proxyReceiverId: string | null;
  device: { id: string; label: string; sourceDomain: string; targetDomain: string; nat: boolean } | null;
  channel: Channel | null;
}

export interface Channel {
  id: string;
  receiverId: string;
  deviceId: string;
  sourceDomain: string;
  targetDomain: string;
  state: string;
  originSenderId: string | null;
  legs: { fabric: 'red' | 'blue'; group: string; source: string | null; port: number }[];
  allocation: { index: number; groups: Fabric2<string>; sources: Fabric2<string> | null; natGroupId: number } | null;
  senderSdp: string | null;
  publishedIn: string[];
  mirrorId?: string;
  remoteReceiver?: { registryId: string; receiverId: string; connected: boolean; error: string | null };
  error: string | null;
  updatedAt: string;
}

export type RegistryState = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';

export interface RegistryStatus {
  id: string;
  label: string;
  domainId: string;
  mode: 'dnssd' | 'manual';
  version: string;
  /** Resolved base URL, null while it has never been resolved. */
  url: string | null;
  reachable: boolean;
  state: RegistryState;
  error: string | null;
  resources: { total: number; node: number; device: number; source: number; flow: number; sender: number; receiver: number };
  heartbeat: { lastOkAt: string | null; ageSeconds: number | null; failures: number };
}

export interface Status {
  nat: { enabled: boolean; driver: string };
  switches: Record<string, { reachable: boolean; version?: string; error?: string }>;
  registries: RegistryStatus[];
  pools: Record<string, { free: number; total: number; used: number[] }>;
  domains: {
    id: string;
    label: string;
    kind: string;
    nodeId: string;
    address: string;
    /** null when no listener could be started for this domain. */
    nodeApiPort: number | null;
    /** Why the node API is not being served, when it is not. */
    nodeApiError: string | null;
    registries: string[];
  }[];
  channels: number;
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
}

export interface HostInterface {
  name: string;
  address: string;
  cidr: string | null;
  mac: string | null;
  internal: boolean;
}

export const api = {
  interfaces: () => req<HostInterface[]>('/interfaces'),
  status: () => req<Status>('/status'),
  config: () => req<Config>('/config'),
  saveConfig: (cfg: Config) => req<{ ok: boolean; issues: Issue[] }>('/config', { method: 'PUT', body: JSON.stringify(cfg) }),
  validateConfig: (cfg: Config) => req<{ issues: Issue[] }>('/config/validate', { method: 'POST', body: JSON.stringify(cfg) }),
  devices: () => req<Device[]>('/devices'),
  createDevice: (d: Partial<Device>) => req<Device>('/devices', { method: 'POST', body: JSON.stringify(d) }),
  updateDevice: (id: string, d: Partial<Device>) =>
    req<Device & { rebuilt?: number; failed?: { receiverId: string; error: string }[] }>(`/devices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(d),
    }),
  deleteDevice: (id: string) => req<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
  addReceivers: (deviceId: string, body: { count: number; pattern: string; format: VirtualReceiver['format'] }) =>
    req<VirtualReceiver[]>(`/devices/${deviceId}/receivers`, { method: 'POST', body: JSON.stringify(body) }),
  deleteReceiver: (id: string) => req<{ ok: boolean }>(`/receivers/${id}`, { method: 'DELETE' }),
  channels: () => req<Channel[]>('/channels'),
  dropChannel: (receiverId: string) => req<{ ok: boolean }>(`/channels/${receiverId}`, { method: 'DELETE' }),
  retryChannel: (receiverId: string) => req<Channel>(`/channels/${receiverId}/retry`, { method: 'POST' }),
  registries: () => req<RegistryStatus[]>('/registries'),
  probeRegistry: (id: string) =>
    req<{ reachable: boolean; url: string | null; error?: string; status?: number }>(`/registries/${id}/probe`, { method: 'POST' }),
  probeSwitch: (fabric: 'red' | 'blue') => req<{ reachable: boolean; version?: string; error?: string }>(`/switch/${fabric}/probe`, { method: 'POST' }),
  reconcile: () => req<{ ok: boolean }>('/reconcile', { method: 'POST' }),
  cleanup: () => req<{ registries: { registry: string; removed: string[] }[] }>('/cleanup', { method: 'POST' }),
  reset: (confirm: boolean) =>
    req<{
      confirmed: boolean;
      wouldRemove?: Record<string, number>;
      wasRemoved?: Record<string, number>;
      removed?: { registry: string; removed: string[] }[];
    }>('/reset', { method: 'POST', body: JSON.stringify({ confirm }) }),
  discover: () => req<DiscoveryResult>('/discovery'),
  refreshDiscovery: () => req<{ ok: boolean }>('/discovery/refresh', { method: 'POST' }),
  browse: (registryId: string) =>
    req<{ paging: { limit: number | null; pages: number; truncated: boolean }; senders: BrowseSender[]; receivers: BrowseReceiver[] }>(
      `/registries/${registryId}/browse`,
    ),
  mirrors: () => req<Mirror[]>('/mirrors'),
  createMirror: (body: {
    kind: 'sender' | 'receiver';
    deviceId: string;
    registryId: string;
    originId: string;
    originDeviceId: string;
    originLabel: string;
    format?: 'video' | 'audio' | 'data';
  }) => req<Mirror>('/mirrors', { method: 'POST', body: JSON.stringify(body) }),
  refreshMirror: (id: string) => req<Channel>(`/mirrors/${id}/refresh`, { method: 'POST' }),
  deleteMirror: (id: string) => req<{ ok: boolean }>(`/mirrors/${id}`, { method: 'DELETE' }),
  events: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`),
};
