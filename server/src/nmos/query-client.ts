import { registryUrl, type RegistryConfig } from '../config/schema.js';
import { log } from '../util/log.js';

/**
 * IS-04 Query API client — read-only.
 *
 * Used to browse a registry for existing senders and receivers so they can be copied
 * into another registry. The query API may sit on a different port than the
 * registration API (nmos-cpp only shares one when it is configured with a single
 * `http_port`), hence `queryPort`.
 */

export interface QuerySender {
  id: string;
  version?: string;
  label: string;
  description?: string;
  device_id: string;
  flow_id: string | null;
  manifest_href: string | null;
  transport: string;
  subscription?: { receiver_id: string | null; active: boolean };
  tags?: Record<string, string[]>;
}

export interface QueryReceiver {
  id: string;
  label: string;
  description?: string;
  device_id: string;
  format: string;
  transport: string;
  caps?: { media_types?: string[] };
  subscription?: { sender_id: string | null; active: boolean };
  tags?: Record<string, string[]>;
}

export interface QueryDevice {
  id: string;
  label: string;
  node_id: string;
  controls?: { href: string; type: string }[];
}

export interface QueryFlow {
  id: string;
  source_id?: string;
  label: string;
  format: string;
  media_type: string;
  frame_width?: number;
  frame_height?: number;
  grain_rate?: { numerator: number; denominator?: number };
}

const TIMEOUT_MS = 5000;
/** Hard stop for pagination, so a registry with an odd cursor cannot loop us forever. */
const MAX_PAGES = 100;
/**
 * The page size we ask for. IS-04 lets a client request a limit; the registry caps it to
 * its own maximum and reports what it applied in X-Paging-Limit. Asking high instead of
 * walking the registry's default of 10 turns a few dozen round trips into a handful.
 */
export const REQUESTED_PAGE_LIMIT = 1000;

/**
 * Oldest version a query may be downgraded to. A Query API returns only resources
 * registered at its own version unless asked otherwise (IS-04 "Query Parameters"), so a
 * v1.3 query silently hides every device that registers at v1.2 — on a live central
 * registry that was 4 senders shown out of more than 100. `query.downgrade` adds the
 * older registrations as they are; IS-04 "Upgrade Path" recommends exactly this for
 * Query API clients.
 */
export const QUERY_DOWNGRADE = 'v1.0';
/** The cursor a registry reports when there is nothing further in that direction. */
const EMPTY_CURSOR = '0:0';

export class QueryError extends Error {}

function failure(e: unknown): string {
  const err = e as Error;
  return err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)
    ? `timeout after ${Math.round(TIMEOUT_MS / 1000)} s`
    : ((err.cause as { code?: string } | undefined)?.code ?? err.message);
}

async function getRaw(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new QueryError(failure(e));
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await getRaw(url);
  if (!res.ok) throw new QueryError(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The `rel` values a Link header advertises. Only the names are used — see getAll(). */
function linkRels(header: string | null): Set<string> {
  const rels = new Set<string>();
  if (!header) return rels;
  for (const m of header.matchAll(/rel\s*=\s*"?([a-zA-Z]+)"?/g)) rels.add(m[1]!.toLowerCase());
  return rels;
}

/**
 * Appends query parameters **without percent-encoding**. The cursors are version
 * stamps of the form `<seconds>:<nanoseconds>`, and encoding that colon is known to
 * make a real registry stop responding. URLSearchParams would encode it, so the query
 * string is assembled by hand.
 */
function withParams(base: string, params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  if (!parts.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

export interface PagedResult<T> {
  items: T[];
  /** Pages fetched across both directions, for diagnostics. */
  pages: number;
  /** True when MAX_PAGES was hit, i.e. the list may be incomplete. */
  truncated: boolean;
  /** The limit the registry advertised, if any. */
  limit: number | null;
}

export class QueryClient {
  /** False once the registry refused a requested limit; then we go without one. */
  private limitAccepted = true;
  /** Cleared once the registry refuses `query.downgrade`; remembered like the limit. */
  private downgradeAccepted = true;

  /**
   * @param resolveRegistry resolves the registration API's base URL — the registry
   *   client's own resolver, which is the only thing that knows where a DNS-SD registry
   *   actually lives. Without it a discovered registry has no `ip` to build on and
   *   browsing it fails with "no IP configured", which is true and useless.
   */
  constructor(
    private readonly cfg: RegistryConfig,
    private readonly resolveRegistry?: () => Promise<string>,
  ) {}

  /** Base of the query API. */
  async base(): Promise<string> {
    let root: string | null;
    if (this.cfg.mode === 'dnssd') {
      if (!this.resolveRegistry) {
        throw new QueryError(`registry ${this.cfg.id}: set to DNS-SD but no resolver available`);
      }
      root = await this.resolveRegistry();
    } else {
      root = registryUrl(this.cfg);
      if (!root) throw new QueryError(`registry ${this.cfg.id}: no IP configured`);
    }

    // The query API may sit on a different port than registration — nmos-cpp only
    // shares one when it is configured with a single http_port.
    if (this.cfg.queryPort) {
      root = root.replace(/^(https?:\/\/(?:\[[^\]]+\]|[^/:]+))(?::\d+)?$/, `$1:${this.cfg.queryPort}`);
    }
    return `${root}/x-nmos/query/${this.cfg.version}`;
  }

  senders = async () => (await this.getAll<QuerySender>('senders')).items;
  receivers = async () => (await this.getAll<QueryReceiver>('receivers')).items;
  devices = async () => (await this.getAll<QueryDevice>('devices')).items;
  flows = async () => (await this.getAll<QueryFlow>('flows')).items;

  sender = async (id: string) => this.getOne<QuerySender>(`senders/${id}`);
  receiver = async (id: string) => this.getOne<QueryReceiver>(`receivers/${id}`);
  device = async (id: string) => this.getOne<QueryDevice>(`devices/${id}`);
  flow = async (id: string) => this.getOne<QueryFlow>(`flows/${id}`);

  private downgradeParam(): Record<string, string> {
    return this.downgradeAccepted ? { 'query.downgrade': QUERY_DOWNGRADE } : {};
  }

  /**
   * One resource, downgraded like the collections: a device registered at v1.2 is a 404
   * on a plain v1.3 lookup, which made a proxy for its receiver fail to find its
   * connection API although the receiver was listed.
   */
  private async getOne<T>(path: string): Promise<T> {
    const url = `${await this.base()}/${path}`;
    const params = this.downgradeParam();
    let res = await getRaw(Object.keys(params).length ? withParams(url, params) : url);
    if (res.status === 400 && Object.keys(params).length) {
      this.downgradeAccepted = false;
      res = await getRaw(url);
    }
    if (!res.ok) throw new QueryError(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Fetches a complete resource collection, following IS-04 query API pagination.
   *
   * Five things here are not obvious, and each of them silently truncates or corrupts
   * the result if skipped:
   *
   *  1. **A registry may cap a page.** Trusting the first response loses everything
   *     past the boundary — a cap of 10 is a real default in the wild.
   *  2. **Both directions have to be walked.** The parameterless base response is
   *     defined as the most recently updated resources in descending order, so
   *     `rel="next"` (toward newer) is a dead end from there: nothing is newer than
   *     "most recent". A large, mostly stable registry's older majority only appears
   *     walking `rel="prev"`.
   *  3. **The next URL is built here, not taken from the Link header.** A real
   *     registry emits a malformed Link header (missing the `?` before its query
   *     string) that 404s if followed verbatim. The header's `rel` names are still the
   *     continue/stop signal; the URL comes from the X-Paging-* cursors.
   *  4. **Cursors go out unencoded** — see withParams().
   *  5. **The cursor is not a strict boundary.** The resource sitting exactly at it has
   *     been observed to reappear as the first item of the next page, e.g. when two
   *     resources share a version timestamp. Collecting into a map keyed by id means
   *     one flaky boundary cannot duplicate a resource everywhere downstream.
   */
  async getAll<T extends { id: string }>(resourcePath: string): Promise<PagedResult<T>> {
    const base = `${await this.base()}/${resourcePath}`;
    const byId = new Map<string, T>();
    let pages = 0;
    let truncated = false;

    // Always state a limit, and a large one. That does two things at once: the registry
    // hands back as much per page as it allows — 100 instead of 10 on nmos-cpp — and no
    // request ever goes out without a limit, which matters because one registry answers a
    // parameterless request with a self-contradictory `X-Paging-Since: 0:0` while older
    // pages exist. The probe that used to learn the registry's default is gone with it.
    const urlFor = () => {
      const params = { ...(this.limitAccepted ? { 'paging.limit': REQUESTED_PAGE_LIMIT } : {}), ...this.downgradeParam() };
      return Object.keys(params).length ? withParams(base, params) : base;
    };
    let baseUrl = urlFor();
    let limit: number | null = null;
    // Fetch the first page once and walk outwards from it. Running each direction from
    // scratch fetched the base twice per collection, which on a registry that answers in
    // a few hundred milliseconds is time spent on a page already in hand.
    let first = await getRaw(baseUrl);
    // A registry should cap a limit it does not like, but one that rejects a parameter
    // outright still deserves an answer. The downgrade goes first — it is the one an
    // older registry is likelier not to know — then the limit; each is remembered.
    if (first.status === 400 && this.downgradeAccepted) {
      this.downgradeAccepted = false;
      baseUrl = urlFor();
      first = await getRaw(baseUrl);
    }
    if (first.status === 400 && this.limitAccepted) {
      this.limitAccepted = false;
      baseUrl = urlFor();
      first = await getRaw(baseUrl);
    }
    if (!first.ok) throw new QueryError(`HTTP ${first.status}`);
    const applied = first.headers.get('x-paging-limit');
    limit = applied ? Number(applied) : null;
    const firstItems = (await first.json()) as T[];
    pages++;
    for (const item of firstItems) byId.set(item.id, item);
    const firstRels = linkRels(first.headers.get('link'));

    const walk = async (rel: 'prev', cursorHeader: string, param: string, from: Response) => {
      let cursor = from.headers.get(cursorHeader);
      let lastCursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        // "0:0" means nothing further that way. Safe to trust here: it is only bogus on a
        // parameterless request, and every request states a limit (unless the registry
        // refused one, in which case we keep walking to be safe).
        if (!cursor || cursor === lastCursor || (cursor === EMPTY_CURSOR && this.limitAccepted)) return;
        lastCursor = cursor;
        const res = await getRaw(withParams(baseUrl, { [param]: cursor }));
        if (!res.ok) throw new QueryError(`HTTP ${res.status}`);
        const items = (await res.json()) as T[];
        pages++;
        for (const item of items) byId.set(item.id, item);

        // Stop on: no such rel advertised, an empty page, or a cursor that did not move.
        if (!linkRels(res.headers.get('link')).has(rel) || !items.length) return;
        cursor = res.headers.get(cursorHeader);
      }
      truncated = true;
    };

    // Only older. The base response is defined as the most recently updated resources,
    // so nothing newer exists at that moment — yet nmos-cpp advertises rel="next" on that
    // page anyway, and following it returned an empty page every time: one request per
    // collection for nothing. A resource updated after the first page is a race no walk
    // closes, so skipping it loses no guarantee.
    if (firstRels.has('prev')) await walk('prev', 'x-paging-since', 'paging.until', first);

    return { items: [...byId.values()], pages, truncated, limit };
  }

  /**
   * Opens an IS-04 Query API subscription and returns the WebSocket URL to read it from.
   * Non-persistent: the registry drops it once nobody is connected. Downgraded like
   * every other query, so changes to v1.2-registered senders arrive too.
   */
  async subscribe(resourcePath: string): Promise<string> {
    const url = `${await this.base()}/subscriptions`;
    const post = (params: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_update_rate_ms: 100, resource_path: resourcePath, params, persist: false, secure: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((e) => {
        throw new QueryError(failure(e));
      });
    let res = await post(this.downgradeParam());
    if (res.status === 400 && this.downgradeAccepted) {
      this.downgradeAccepted = false;
      res = await post({});
    }
    if (!res.ok) throw new QueryError(`subscription: HTTP ${res.status}`);
    const sub = (await res.json()) as { ws_href?: string };
    if (!sub.ws_href) throw new QueryError('subscription without ws_href');
    return sub.ws_href;
  }

  /**
   * Fetches a sender's SDP from its manifest. This is the origin SDP for a sender
   * copy — the same input an IS-05 activation would hand us.
   */
  async transportFile(sender: QuerySender): Promise<string> {
    if (!sender.manifest_href) throw new QueryError(`sender ${sender.id} has no manifest_href`);
    let res: Response;
    try {
      res = await fetch(sender.manifest_href, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new QueryError(`manifest ${sender.manifest_href}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new QueryError(`manifest ${sender.manifest_href}: HTTP ${res.status}`);
    const sdp = await res.text();
    if (!sdp.trim().startsWith('v=')) throw new QueryError(`manifest ${sender.manifest_href} is not an SDP`);
    return sdp;
  }

  async probe(): Promise<{ reachable: boolean; base: string | null; error?: string }> {
    try {
      const base = await this.base();
      await getJson<unknown>(`${base}/`);
      return { reachable: true, base };
    } catch (e) {
      log.debug({ registry: this.cfg.id, err: String(e) }, 'query API probe failed');
      return { reachable: false, base: null, error: (e as Error).message };
    }
  }
}
