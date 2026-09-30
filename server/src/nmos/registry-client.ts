import { promises as dns } from 'node:dns';
import type { RegistryConfig } from '../config/schema.js';
import { log } from '../util/log.js';

export type ResourceType = 'node' | 'device' | 'source' | 'flow' | 'sender' | 'receiver';

/** Reihenfolge, in der IS-04 Ressourcen akzeptiert — Eltern vor Kindern. */
export const REGISTER_ORDER: ResourceType[] = ['node', 'device', 'source', 'flow', 'sender', 'receiver'];

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
    throw new RegistryError(`${url}: ${(e as Error).message}`);
  }
}

/**
 * IS-04 Registration Client — eine Instanz je Registry.
 *
 * Verhalten, das nicht verhandelbar ist:
 *  - Heartbeat alle 5 s auf /health/nodes/<id>
 *  - Heartbeat 404 -> Registry wurde neu gestartet -> alles neu registrieren,
 *    in der Reihenfolge node, device, source, flow, sender/receiver
 *  - eine ausgefallene Registry darf keinen Channel kippen: Fehler werden gemeldet,
 *    nicht geworfen, und der Reconciler zieht Fehlendes nach
 */
export class RegistryClient {
  private base: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nodeId: string | null = null;
  reachable = false;
  lastError: string | null = null;
  /** Was diese Registry nach unserem Kenntnisstand kennt. */
  readonly registered = new Set<string>();

  constructor(
    readonly cfg: RegistryConfig,
    /** wird gerufen, wenn die Registry alles neu braucht (Heartbeat 404 / Neustart). */
    private readonly onNeedsReregister: (client: RegistryClient) => void,
  ) {}

  get id(): string {
    return this.cfg.id;
  }

  /** Basis-URL der Registration API, ohne abschließenden Slash. */
  async resolve(): Promise<string> {
    if (this.base) return this.base;
    if (this.cfg.mode === 'manual') {
      if (!this.cfg.url) throw new RegistryError(`Registry ${this.cfg.id}: keine URL konfiguriert`);
      this.base = this.cfg.url.replace(/\/+$/, '');
      return this.base;
    }
    this.base = await this.discover();
    return this.base;
  }

  /**
   * Unicast-DNS-SD: _nmos-register._tcp im Suchdomain des Hosts. mDNS bleibt
   * absichtlich außen vor — über Domänengrenzen hilft es nicht, und intern reicht
   * in der Praxis Unicast-DNS-SD oder die manuelle URL.
   */
  private async discover(): Promise<string> {
    const domains = [...new Set((dns.getServers().length ? ['local'] : []).concat(['']))];
    const searchDomain = this.cfg.url ?? '';
    const names = [`_nmos-register._tcp${searchDomain ? '.' + searchDomain : ''}`, ...domains.map((d) => `_nmos-register._tcp.${d}`)];
    for (const name of names) {
      try {
        const srv = await dns.resolveSrv(name.replace(/\.$/, ''));
        const best = srv.sort((a, b) => a.priority - b.priority)[0];
        if (best) {
          const url = `http://${best.name.replace(/\.$/, '')}:${best.port}`;
          log.info({ registry: this.cfg.id, url, via: name }, 'Registry über DNS-SD gefunden');
          return url;
        }
      } catch {
        /* nächster Kandidat */
      }
    }
    throw new RegistryError(`Registry ${this.cfg.id}: DNS-SD hat nichts gefunden — URL konfigurieren`);
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
      this.lastError = `register ${type} ${data.id}: HTTP ${res.status}`;
      throw new RegistryError(this.lastError, res.status);
    }
    this.reachable = true;
    this.lastError = null;
    this.registered.add(`${type}:${data.id}`);
    if (type === 'node') this.nodeId = data.id;
    log.debug({ registry: this.cfg.id, type, id: data.id, status: res.status }, 'registriert');
  }

  async unregister(type: ResourceType, id: string): Promise<void> {
    const base = await this.resolve();
    const res = await request(`${this.apiBase(base)}/resource/${type}s/${id}`, { method: 'DELETE' });
    // 404 heißt: ist schon weg. Für uns dasselbe Ergebnis.
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      this.lastError = `unregister ${type} ${id}: HTTP ${res.status}`;
      throw new RegistryError(this.lastError, res.status);
    }
    this.registered.delete(`${type}:${id}`);
    log.debug({ registry: this.cfg.id, type, id, status: res.status }, 'abgemeldet');
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
      return;
    }
    if (res.status === 404) {
      // Registry kennt uns nicht mehr — typisch nach Registry-Neustart.
      log.warn({ registry: this.cfg.id }, 'Heartbeat 404, registriere neu');
      this.registered.clear();
      this.onNeedsReregister(this);
      return;
    }
    this.reachable = false;
    this.lastError = `heartbeat: HTTP ${res.status}`;
  }

  startHeartbeat(nodeId: string, intervalMs = 5000): void {
    this.nodeId = nodeId;
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      this.heartbeat().catch((e) => {
        this.reachable = false;
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
   * Orphan-Cleanup braucht die Query API — über die Registration API lässt sich
   * nicht auflisten. Ohne Query-URL bleibt nur die eigene Buchführung, die nach
   * einem Absturz lückenhaft sein kann.
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
            /* fremde Ressource, Finger weg */
          }
        }
      } catch {
        /* Query API nicht erreichbar — kein Cleanup, aber auch kein Abbruch */
      }
    }
    if (removed) log.info({ registry: this.cfg.id, removed }, 'verwaiste Ressourcen entfernt');
    return removed;
  }

  status() {
    return {
      id: this.cfg.id,
      label: this.cfg.label,
      domainId: this.cfg.domainId,
      url: this.base,
      reachable: this.reachable,
      error: this.lastError,
      resources: this.registered.size,
    };
  }
}
