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
  fabricSubnets: Fabric2<string | null>;
  switchInterface: Fabric2<string>;
  pool: Pool;
  ptpRefclk: string | null;
  enabled: boolean;
}

export interface Registry {
  id: string;
  label: string;
  domainId: string;
  mode: 'dnssd' | 'manual';
  /** IP or hostname, for mode=manual. */
  ip?: string;
  /** Port of the registration API; nmos-cpp with a single http_port uses 8010. */
  port?: number;
  tls?: boolean;
  /** DNS-SD search domain, for mode=dnssd. */
  domain?: string;
  version: 'v1.3' | 'v1.2';
  enabled: boolean;
}

export const DEFAULT_REGISTRY_PORT = 8010;

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
  error: string | null;
  updatedAt: string;
}

export interface Status {
  nat: { enabled: boolean; driver: string };
  switches: Record<string, { reachable: boolean; version?: string; error?: string }>;
  registries: { id: string; label: string; domainId: string; url: string | null; reachable: boolean; error: string | null; resources: number }[];
  pools: Record<string, { free: number; total: number; used: number[] }>;
  domains: { id: string; label: string; kind: string; nodeId: string; registries: string[] }[];
  channels: number;
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
}

export const api = {
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
  probeSwitch: (fabric: 'red' | 'blue') => req<{ reachable: boolean; version?: string; error?: string }>(`/switch/${fabric}/probe`, { method: 'POST' }),
  reconcile: () => req<{ ok: boolean }>('/reconcile', { method: 'POST' }),
  events: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`),
};
