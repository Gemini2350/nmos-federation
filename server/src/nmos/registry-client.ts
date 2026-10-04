import { registryUrl, type RegistryConfig } from '../config/schema.js';
import { discoverRegistries, type DiscoveredRegistry } from './discovery.js';
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
  /** How many candidates the last DNS-SD run returned; null for a manual registry. */
  discovered?: number | null;
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
  /** Every node of ours this registry holds — one per bridge whose domain it serves. */
  private nodeIds: string[] = [];
  reachable = false;
  lastError: string | null = null;
  private lastHeartbeatOk: number | null = null;
  /** Candidates from the last discovery run, for the status display. */
  lastDiscovery: DiscoveredRegistry[] = [];
  private heartbeatFailures = 0;
  private heartbeatIntervalMs = 5000;
  /** What this registry knows about, keyed "type:id" -> the version we last sent. */
  readonly registered = new Map<string, string>();

  constructor(
    readonly cfg: RegistryConfig,
    /** Called when the registry needs everything again (heartbeat 404 / restart). */
    private readonly onNeedsReregister: (client: RegistryClient) => void,
  ) {}

  get id(): string {
    return this.cfg.id;
  }

  /** Forces the next resolve() to look again — a DNS-SD result is not permanent. */
  forgetAddress(): void {
    this.base = null;
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
   * DNS-SD. The search domains come from the host's resolv.conf — under
   * `network_mode: host` those are the ones DHCP handed out, which is the answer in
   * every real deployment, so there is nothing to configure. Both unicast and mDNS are
   * tried; see nmos/discovery.ts for why that needs two different mechanisms.
   */
  private async discover(): Promise<string> {
    const result = await discoverRegistries({ version: this.cfg.version });
    this.lastDiscovery = result.found;
    const best = result.found[0];
    if (best) {
      log.info(
        { registry: this.cfg.id, url: best.url, instance: best.instance, via: best.via, pri: best.priority },
        'registry found via DNS-SD',
      );
      return best.url;
    }
    // Make the failure diagnosable: say what was queried, not just that nothing came back.
    const detail = [result.notes.join('; '), result.tried.length ? `queried: ${result.tried.join(', ')}` : '']
      .filter(Boolean)
      .join(' — ');
    throw new RegistryError(`DNS-SD found no registry${detail ? ` (${detail})` : ''}`);
  }

  private apiBase(base: string): string {
    return `${base}/x-nmos/registration/${this.cfg.version}`;
  }

  async register(type: ResourceType, data: { id: string; version?: string }): Promise<boolean> {
    const key = `${type}:${data.id}`;
    // Nothing to say if the registry already holds this exact version. Re-POSTing an
    // unchanged resource every reconcile is pure churn — and it only looked necessary
    // because every build used to stamp a fresh version.
    if (data.version && this.registered.get(key) === data.version) return false;
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
    this.registered.set(key, data.version ?? '');
    if (type === 'node' && !this.nodeIds.includes(data.id)) this.nodeIds.push(data.id);
    log.debug({ registry: this.cfg.id, type, id: data.id, status: res.status }, 'registered');
    return true;
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

  /** One POST per node we have here — a registry can hold several, one per bridge. */
  async heartbeat(): Promise<void> {
    if (!this.nodeIds.length) return;
    const base = await this.resolve();
    let anyMissing = false;
    let ok = true;
    for (const nodeId of this.nodeIds) {
      const res = await request(`${this.apiBase(base)}/health/nodes/${nodeId}`, { method: 'POST' });
      if (res.status === 404) anyMissing = true;
      else if (res.status !== 200) {
        ok = false;
        this.lastError = `heartbeat: HTTP ${res.status}`;
      }
    }
    if (ok && !anyMissing) {
      this.reachable = true;
      this.lastError = null;
      this.lastHeartbeatOk = Date.now();
      this.heartbeatFailures = 0;
      return;
    }
    if (anyMissing) {
      // The registry answered, it just does not know this node — typically after a
      // registry restart. That is still successful contact: recording it as nothing at
      // all is what made the status sit on "not contacted yet" while the registry was
      // perfectly fine.
      log.warn({ registry: this.cfg.id }, 'heartbeat 404, re-registering');
      this.reachable = true;
      this.heartbeatFailures++;
      this.lastError = 'node unknown to the registry — re-registering';
      this.registered.clear();
      this.nodeIds = [];
      this.onNeedsReregister(this);
      return;
    }
    this.reachable = false;
    this.heartbeatFailures++;
  }

  startHeartbeat(nodeIds: string[], intervalMs = 5000): void {
    this.nodeIds = [...new Set([...this.nodeIds, ...nodeIds])];
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
    for (const key of this.registered.keys()) {
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
      discovered: this.cfg.mode === 'dnssd' ? this.lastDiscovery.length : null,
      heartbeat: {
        lastOkAt: this.lastHeartbeatOk === null ? null : new Date(this.lastHeartbeatOk).toISOString(),
        ageSeconds,
        failures: this.heartbeatFailures,
      },
    };
  }
}
