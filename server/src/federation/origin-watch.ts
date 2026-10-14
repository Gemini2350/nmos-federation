import { log } from '../util/log.js';

/**
 * Watches the originals of copies for changes — through the registry, never by polling
 * the devices.
 *
 * IS-04 Query API WebSocket subscriptions, per registry that holds an original: one on
 * `/senders` (originals of sender copies) and one on `/receivers` (originals of receiver
 * proxies). The registry pushes every change; nothing is asked for on a timer.
 *
 *  - A sender at another version than its copy was built from (stored on the channel):
 *    the copy re-reads the manifest (`onChange`). That relies on the device bumping its
 *    sender's version when its transport file changes, which IS-05 expects of it.
 *  - Any watched original changing version — caps, label, switched on or off: the
 *    re-binding pass runs (`onModified`), which takes over what changed.
 *  - Removed (`onGone`), or something appearing where an original is missing
 *    (`onBack`): the re-binding pass finds out whether it is back, perhaps under new ids.
 *
 * The registry opens each connection with the current state of everything. Senders are
 * compared with the version their copy was built from, so a change made while the
 * socket — or this software — was down is noticed on the first message. Receivers have
 * no stored version; the first sighting is the baseline, kept across reconnects, and the
 * pass that runs at startup covers the time this software was not running.
 */

export type WatchKind = 'sender' | 'receiver';

export interface WatchTarget {
  registryId: string;
  kind: WatchKind;
  /** NMOS id of the original. */
  originId: string;
  /** For a sender: the version its copy was last built from; undefined = not known. */
  version?: string;
  /** The original is currently gone from its registry (and its copy offline). */
  missing?: boolean;
}

interface Deps {
  /** What to watch right now. Read on every sync and every message. */
  targets: () => WatchTarget[];
  /** Opens a subscription on a registry's query API and returns its ws_href. */
  subscribe: (registryId: string, kind: WatchKind) => Promise<string>;
  /** A sender is at another version than its copy was built from. */
  onChange: (target: WatchTarget, version: string) => void;
  /** A watched original changed version — whatever changed in it. */
  onModified?: (target: WatchTarget) => void;
  /** An original left its registry — possibly to come back under new ids. */
  onGone?: (target: WatchTarget) => void;
  /**
   * Something appeared in a registry where an original of that kind is missing — maybe
   * it is back, under its old id or a new one. Deciding which is the re-binding pass's.
   */
  onBack?: (registryId: string) => void;
  /** Reconnect delay; tests make it short. */
  retryMs?: number;
}

interface Grain {
  grain?: { data?: { path?: string; pre?: { id?: string; version?: string }; post?: { id?: string; version?: string } }[] };
}

interface Sub {
  registryId: string;
  kind: WatchKind;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  state: 'connecting' | 'open' | 'retrying';
  error: string | null;
  /** Last version seen per id — survives reconnects; the baseline for "modified". */
  seen: Map<string, string>;
}

const key = (registryId: string, kind: WatchKind) => `${registryId}|${kind}`;

export class OriginWatcher {
  private readonly subs = new Map<string, Sub>();

  constructor(private readonly deps: Deps) {}

  /** Opens what is needed, closes what is not. Cheap; call after every change. */
  sync(): void {
    const needed = new Map(this.deps.targets().map((t) => [key(t.registryId, t.kind), t] as const));
    for (const [k, sub] of this.subs) {
      if (needed.has(k)) continue;
      this.close(sub);
      this.subs.delete(k);
    }
    for (const [k, t] of needed) {
      if (this.subs.has(k)) continue;
      const sub: Sub = { registryId: t.registryId, kind: t.kind, ws: null, timer: null, closed: false, state: 'connecting', error: null, seen: new Map() };
      this.subs.set(k, sub);
      void this.open(sub);
    }
  }

  stop(): void {
    for (const sub of this.subs.values()) this.close(sub);
    this.subs.clear();
  }

  /** Per registry and kind: is the feed live — for the status line. */
  status(): { registryId: string; kind: WatchKind; state: Sub['state']; error: string | null }[] {
    return [...this.subs.values()].map((s) => ({ registryId: s.registryId, kind: s.kind, state: s.state, error: s.error }));
  }

  private close(sub: Sub): void {
    sub.closed = true;
    if (sub.timer) clearTimeout(sub.timer);
    sub.ws?.close();
  }

  private retry(sub: Sub, reason: string): void {
    if (sub.closed || sub.timer) return;
    sub.state = 'retrying';
    sub.error = reason;
    sub.timer = setTimeout(() => {
      sub.timer = null;
      void this.open(sub);
    }, this.deps.retryMs ?? 10_000);
    sub.timer.unref?.();
  }

  private async open(sub: Sub): Promise<void> {
    if (sub.closed) return;
    sub.state = 'connecting';
    let href: string;
    try {
      href = await this.deps.subscribe(sub.registryId, sub.kind);
    } catch (e) {
      log.warn({ registry: sub.registryId, kind: sub.kind, err: String(e) }, 'origin watch: subscription failed, retrying');
      return this.retry(sub, (e as Error).message);
    }
    if (sub.closed) return;
    const ws = new WebSocket(href);
    sub.ws = ws;
    ws.onopen = () => {
      sub.state = 'open';
      sub.error = null;
      log.info({ registry: sub.registryId, kind: sub.kind }, `origin watch: subscribed to ${sub.kind}s`);
    };
    ws.onmessage = (ev) => this.handle(sub, String(ev.data));
    ws.onerror = () => {
      /* onclose follows and retries */
    };
    ws.onclose = () => {
      if (sub.ws === ws) sub.ws = null;
      this.retry(sub, 'connection closed');
    };
  }

  private handle(sub: Sub, raw: string): void {
    let msg: Grain;
    try {
      msg = JSON.parse(raw) as Grain;
    } catch {
      return;
    }
    const watched = new Map(
      this.deps
        .targets()
        .filter((t) => t.registryId === sub.registryId && t.kind === sub.kind)
        .map((t) => [t.originId, t]),
    );
    const anyMissing = [...watched.values()].some((t) => t.missing);
    let maybeBack = false;
    for (const item of msg.grain?.data ?? []) {
      const id = item.post?.id;
      const version = item.post?.version;
      if (!id || !version) {
        // Removed. The copy keeps running on what it has; whether the original came
        // back under new ids is for the re-binding pass to find out.
        const goneId = item.pre?.id;
        if (goneId) sub.seen.delete(goneId);
        const gone = goneId && watched.get(goneId);
        if (gone) this.deps.onGone?.(gone);
        continue;
      }
      const target = watched.get(id);
      if (anyMissing && (target?.missing || !item.pre)) maybeBack = true;
      const before = sub.seen.get(id);
      sub.seen.set(id, version);
      if (!target || target.missing) continue;
      if (target.kind === 'sender' && target.version !== version) this.deps.onChange(target, version);
      if (before !== undefined && before !== version) this.deps.onModified?.(target);
    }
    if (maybeBack) this.deps.onBack?.(sub.registryId);
  }
}
