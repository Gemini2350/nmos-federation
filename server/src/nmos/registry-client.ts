import { promises as dns } from 'node:dns';
import { registryUrl, type RegistryConfig } from '../config/schema.js';
import { log } from '../util/log.js';

export type ResourceType = 'node' | 'device' | 'source' | 'flow' | 'sender' | 'receiver';

/** Order in which IS-04 accepts resources — parents before children. */
export const REGISTER_ORDER: ResourceType[] = ['node', 'device', 'source', 'flow', 'sender', 'receiver'];

/** What the GUI shows per registry. */
export interface RegistryStatus {
  id: string;
  label: string;
  domainId: string;
  mode: 'dnssd' | 'manual';
  version: string;
  /** Resolved base URL, null while it has never been resolved. */
  url: string | null;
  reachable: boolean;
  /**
   * ok        — reachable and the heartbeat is current
   * degraded  — reachable, but the heartbeat is overdue or has failed
   * down      — last contact attempt failed
   * unknown   — nothing tried yet
   */
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  error: string | null;
  resources: { total: number } & Record<ResourceType, number>;
  heartbeat: { lastOkAt: string | null; ageSeconds: number | null; failures: number };
}

export class RegistryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const TIMEOUT_MS = 5000;

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = TIMEOUT_MS, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Keep this short: it ends up in a table cell next to the address, so repeating
    // the full URL and the runtime's wording adds nothing.
    const err = e as Error;
    const reason =
      err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)
        ? `timeout after ${Math.round(timeoutMs / 1000)} s`
        : (err.cause as { code?: string } | undefined)?.code ?? err.message;
    throw new RegistryError(reason);
  }
}

/**
 * IS-04 registration client — one instance per registry.
 *
 * Non-negotiable behaviour:
 *  - heartbeat every 5 s on /health/nodes/<id>
 *  - heartbeat 404 -> the registry restarted -> re-register everything, in the
 *    order node, device, source, flow, sender/receiver
 *  - a registry that is down must never take a channel with it: errors are
 *    reported, not thrown, and the reconciler catches up on what is missing
 */
export class RegistryClient {
  private base: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nodeId: string | null = null;
  reachable = false;
  lastError: string | null = null;
  private lastHeartbeatOk: number | null = null;
  private heartbeatFailures = 0;
  private heartbeatIntervalMs = 5000;
  /** What this registry knows about, as far as we can tell. */
  readonly registered = new Set<string>();

  constructor(
    readonly cfg: RegistryConfig,
    /** Called when the registry needs everything again (heartbeat 404 / restart). */
    private readonly onNeedsReregister: (client: RegistryClient) => void,
  ) {}

  get id(): string {
    return this.cfg.id;
  }

  /** Base URL of the registration API, without a trailing slash. */
  async resolve(): Promise<string> {
    if (this.base) return this.base;
    if (this.cfg.mode === 'manual') {
      const url = registryUrl(this.cfg);
      if (!url) throw new RegistryError(`registry ${this.cfg.id}: no IP configured`);
      this.base = url;
      return this.base;
    }
    this.base = await this.discover();
    return this.base;
  }

  /**
   * Unicast DNS-SD: _nmos-register._tcp in the host's search domain. mDNS is left
   * out on purpose — it does not help across domain boundaries, and internally
   * unicast DNS-SD or a manual URL is enough in practice.
   */
  private async discover(): Promise<string> {
    const searchDomain = this.cfg.domain?.replace(/^\.|\.$/g, '') ?? '';
    const names = searchDomain
      ? [`_nmos-register._tcp.${searchDomain}`]
      : ['_nmos-register._tcp', '_nmos-register._tcp.local'];
    for (const name of names) {
      try {
        const srv = await dns.resolveSrv(name.replace(/\.$/, ''));
        const best = srv.sort((a, b) => a.priority - b.priority)[0];
        if (best) {
          const url = `http://${best.name.replace(/\.$/, '')}:${best.port}`;
          log.info({ registry: this.cfg.id, url, via: name }, 'registry found via DNS-SD');
          return url;
        }
      } catch {
        /* next candidate */
      }
    }
    throw new RegistryError(`registry ${this.cfg.id}: DNS-SD found nothing — configure a URL`);
  }

  private apiBase(base: string): string {
    return `${base}/x-nmos/registration/${this.cfg.version}`;
  }

  async register(type: ResourceType, data: { id: string }): Promise<void> {
    const base = await this.resolve();
    const res = await request(`${this.apiBase(base)}/resource`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, data }),
    });
    if (res.status !== 200 && res.status !== 201) {
      this.reachable = false;
      this.lastError = `register ${type}: HTTP ${res.status}`;
      throw new RegistryError(this.lastError, res.status);
    }
    this.reachable = true;
    this.lastError = null;
    this.registered.add(`${type}:${data.id}`);
    if (type === 'node') this.nodeId = data.id;
    log.debug({ registry: this.cfg.id, type, id: data.id, status: res.status }, 'registered');
  }

  async unregister(type: ResourceType, id: string): Promise<void> {
    const base = await this.resolve();
    const res = await request(`${this.apiBase(base)}/resource/${type}s/${id}`, { method: 'DELETE' });
    // 404 means it is already gone. Same outcome for us.
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      this.lastError = `unregister ${type}: HTTP ${res.status}`;
      throw new RegistryError(this.lastError, res.status);
    }
    this.registered.delete(`${type}:${id}`);
    log.debug({ registry: this.cfg.id, type, id, status: res.status }, 'unregistered');
  }

  knows(type: ResourceType, id: string): boolean {
    return this.registered.has(`${type}:${id}`);
  }

  async heartbeat(): Promise<void> {
    if (!this.nodeId) return;
    const base = await this.resolve();
    const res = await request(`${this.apiBase(base)}/health/nodes/${this.nodeId}`, { method: 'POST' });
    if (res.status === 200) {
      this.reachable = true;
      this.lastError = null;
      this.lastHeartbeatOk = Date.now();
      this.heartbeatFailures = 0;
      return;
    }
    if (res.status === 404) {
      // The registry no longer knows us — typical after a registry restart.
      log.warn({ registry: this.cfg.id }, 'heartbeat 404, re-registering');
      this.registered.clear();
      this.onNeedsReregister(this);
      return;
    }
    this.reachable = false;
    this.heartbeatFailures++;
    this.lastError = `heartbeat: HTTP ${res.status}`;
  }

  startHeartbeat(nodeId: string, intervalMs = 5000): void {
    this.nodeId = nodeId;
    this.stopHeartbeat();
    this.heartbeatIntervalMs = intervalMs;
    this.timer = setInterval(() => {
      this.heartbeat().catch((e) => {
        this.reachable = false;
        this.heartbeatFailures++;
        this.lastError = (e as Error).message;
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Orphan cleanup needs the query API — the registration API cannot list. Without
   * a query URL all we have is our own bookkeeping, which can be incomplete after
   * a crash.
   */
  async cleanupOrphans(nodeId: string, keep: Set<string>, queryUrl?: string): Promise<number> {
    if (!queryUrl) return 0;
    let removed = 0;
    for (const type of ['receiver', 'sender', 'flow', 'source', 'device'] as ResourceType[]) {
      try {
        const res = await request(`${queryUrl.replace(/\/+$/, '')}/x-nmos/query/${this.cfg.version}/${type}s`);
        if (!res.ok) continue;
        const list = (await res.json()) as { id: string; node_id?: string; device_id?: string }[];
        for (const item of list) {
          const mine = item.node_id === nodeId || keep.has(`${type}:${item.id}`);
          if (item.node_id === nodeId && !keep.has(`${type}:${item.id}`)) {
            await this.unregister(type, item.id).catch(() => {});
            removed++;
          } else if (!mine) {
            /* someone else's resource, hands off */
          }
        }
      } catch {
        /* query API unreachable — no cleanup, but no abort either */
      }
    }
    if (removed) log.info({ registry: this.cfg.id, removed }, 'removed orphaned resources');
    return removed;
  }

  /**
   * Checks reachability without changing anything: resolve the address and ask the
   * registration API for its base resource list.
   */
  async probe(): Promise<{ reachable: boolean; url: string | null; error?: string; status?: number }> {
    let base: string;
    try {
      base = await this.resolve();
    } catch (e) {
      this.reachable = false;
      this.lastError = (e as Error).message;
      return { reachable: false, url: null, error: this.lastError };
    }
    try {
      const res = await request(`${this.apiBase(base)}/`);
      const ok = res.status >= 200 && res.status < 400;
      this.reachable = ok;
      this.lastError = ok ? null : `HTTP ${res.status}`;
      return { reachable: ok, url: base, status: res.status, ...(ok ? {} : { error: this.lastError! }) };
    } catch (e) {
      this.reachable = false;
      this.lastError = (e as Error).message;
      return { reachable: false, url: base, error: this.lastError };
    }
  }

  private countResources(): { total: number } & Record<ResourceType, number> {
    const counts = { total: 0, node: 0, device: 0, source: 0, flow: 0, sender: 0, receiver: 0 };
    for (const key of this.registered) {
      const type = key.split(':')[0] as ResourceType;
      if (type in counts) counts[type]++;
      counts.total++;
    }
    return counts;
  }

  status(): RegistryStatus {
    const ageSeconds = this.lastHeartbeatOk === null ? null : Math.round((Date.now() - this.lastHeartbeatOk) / 1000);
    // A heartbeat runs every 5 s; give it three intervals before calling it overdue.
    const overdue = ageSeconds !== null && ageSeconds * 1000 > this.heartbeatIntervalMs * 3;
    const tried = this.reachable || this.lastError !== null || this.lastHeartbeatOk !== null;

    let state: RegistryStatus['state'];
    if (!tried) state = 'unknown';
    else if (!this.reachable) state = 'down';
    else if (overdue || this.heartbeatFailures > 0) state = 'degraded';
    else state = 'ok';

    return {
      id: this.cfg.id,
      label: this.cfg.label,
      domainId: this.cfg.domainId,
      mode: this.cfg.mode,
      version: this.cfg.version,
      url: this.base,
      reachable: this.reachable,
      state,
      error: this.lastError,
      resources: this.countResources(),
      heartbeat: {
        lastOkAt: this.lastHeartbeatOk === null ? null : new Date(this.lastHeartbeatOk).toISOString(),
        ageSeconds,
        failures: this.heartbeatFailures,
      },
    };
  }
}
