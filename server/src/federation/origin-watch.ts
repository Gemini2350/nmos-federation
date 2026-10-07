import { log } from '../util/log.js';

/**
 * Watches the originals of sender copies for changes — through the registry, never by
 * polling the devices.
 *
 * One IS-04 Query API WebSocket subscription on `/senders` per registry that holds an
 * original. When an original's resource changes version, its copy is asked to re-read
 * the manifest. That relies on the device bumping its sender's version when its
 * transport file changes, which IS-05 expects of it; a device that does not is still
 * covered by Refresh.
 *
 * Every message is compared with the version the copy was built from (stored on its
 * channel), not with the previous message. The registry opens each connection with the
 * current state of everything, so a change made while the socket was down — or while
 * this software was not running at all — is noticed on the first message after.
 */

export interface WatchTarget {
  registryId: string;
  /** NMOS id of the original sender. */
  originId: string;
  /** Version of the original the copy was last built from; undefined = not known. */
  version?: string;
}

interface Deps {
  /** What to watch right now. Read on every sync. */
  targets: () => WatchTarget[];
  /** Opens a subscription on the registry's query API and returns its ws_href. */
  subscribe: (registryId: string) => Promise<string>;
  /** An original is at another version than its copy was built from. */
  onChange: (target: WatchTarget, version: string) => void;
  /** Reconnect delay; tests make it short. */
  retryMs?: number;
}

interface Grain {
  grain?: { data?: { path?: string; pre?: { id?: string; version?: string }; post?: { id?: string; version?: string } }[] };
}

interface Sub {
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  state: 'connecting' | 'open' | 'retrying';
  error: string | null;
}

export class OriginWatcher {
  private readonly subs = new Map<string, Sub>();

  constructor(private readonly deps: Deps) {}

  /** Opens what is needed, closes what is not. Cheap; call after every change. */
  sync(): void {
    const needed = new Set(this.deps.targets().map((t) => t.registryId));
    for (const [registryId, sub] of this.subs) {
      if (needed.has(registryId)) continue;
      this.close(sub);
      this.subs.delete(registryId);
    }
    for (const registryId of needed) {
      if (this.subs.has(registryId)) continue;
      const sub: Sub = { ws: null, timer: null, closed: false, state: 'connecting', error: null };
      this.subs.set(registryId, sub);
      void this.open(registryId, sub);
    }
  }

  stop(): void {
    for (const sub of this.subs.values()) this.close(sub);
    this.subs.clear();
  }

  /** Per registry: is the watch live — for the status page. */
  status(): { registryId: string; state: Sub['state']; error: string | null }[] {
    return [...this.subs].map(([registryId, s]) => ({ registryId, state: s.state, error: s.error }));
  }

  private close(sub: Sub): void {
    sub.closed = true;
    if (sub.timer) clearTimeout(sub.timer);
    sub.ws?.close();
  }

  private retry(registryId: string, sub: Sub, reason: string): void {
    if (sub.closed || sub.timer) return;
    sub.state = 'retrying';
    sub.error = reason;
    sub.timer = setTimeout(() => {
      sub.timer = null;
      void this.open(registryId, sub);
    }, this.deps.retryMs ?? 10_000);
    sub.timer.unref?.();
  }

  private async open(registryId: string, sub: Sub): Promise<void> {
    if (sub.closed) return;
    sub.state = 'connecting';
    let href: string;
    try {
      href = await this.deps.subscribe(registryId);
    } catch (e) {
      log.warn({ registry: registryId, err: String(e) }, 'origin watch: subscription failed, retrying');
      return this.retry(registryId, sub, (e as Error).message);
    }
    if (sub.closed) return;
    const ws = new WebSocket(href);
    sub.ws = ws;
    ws.onopen = () => {
      sub.state = 'open';
      sub.error = null;
      log.info({ registry: registryId }, 'origin watch: subscribed to senders');
    };
    ws.onmessage = (ev) => this.handle(registryId, sub, String(ev.data));
    ws.onerror = () => {
      /* onclose follows and retries */
    };
    ws.onclose = () => {
      if (sub.ws === ws) sub.ws = null;
      this.retry(registryId, sub, 'connection closed');
    };
  }

  private handle(registryId: string, sub: Sub, raw: string): void {
    let msg: Grain;
    try {
      msg = JSON.parse(raw) as Grain;
    } catch {
      return;
    }
    const watched = new Map(
      this.deps
        .targets()
        .filter((t) => t.registryId === registryId)
        .map((t) => [t.originId, t]),
    );
    for (const item of msg.grain?.data ?? []) {
      const id = item.post?.id;
      const version = item.post?.version;
      if (!id || !version) continue; // removed: the copy keeps running on what it has
      const target = watched.get(id);
      if (target && target.version !== version) this.deps.onChange(target, version);
    }
  }
}
