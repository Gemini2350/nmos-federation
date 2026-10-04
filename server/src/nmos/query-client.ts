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
  label: string;
  description?: string;
  device_id: string;
  flow_id: string | null;
  manifest_href: string | null;
  transport: string;
  subscription?: { receiver_id: string | null; active: boolean };
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
}

export interface QueryDevice {
  id: string;
  label: string;
  node_id: string;
  controls?: { href: string; type: string }[];
}

export interface QueryFlow {
  id: string;
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
  constructor(private readonly cfg: RegistryConfig) {}

  /** Base of the query API. Falls back to the registration address. */
  base(): string {
    const port = this.cfg.queryPort ?? this.cfg.port;
    const url = registryUrl({ ...this.cfg, port });
    if (!url) throw new QueryError(`registry ${this.cfg.id}: no IP configured`);
    return `${url}/x-nmos/query/${this.cfg.version}`;
  }

  senders = async () => (await this.getAll<QuerySender>('senders')).items;
  receivers = async () => (await this.getAll<QueryReceiver>('receivers')).items;
  devices = async () => (await this.getAll<QueryDevice>('devices')).items;
  flows = async () => (await this.getAll<QueryFlow>('flows')).items;

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
    const base = `${this.base()}/${resourcePath}`;
    const byId = new Map<string, T>();
    let pages = 0;
    let truncated = false;

    // Probe the bare collection once to learn the registry's own page limit. Beyond
    // being useful, one registry is known to return a self-contradictory
    // `X-Paging-Since: 0:0` ("nothing older exists") for a parameterless request while
    // older pages do exist, and to answer correctly as soon as paging.limit is stated
    // at all. Two requests to the base is the price of a correct walk.
    const probe = await getRaw(base);
    if (!probe.ok) throw new QueryError(`HTTP ${probe.status}`);
    const limitHeader = probe.headers.get('x-paging-limit');
    const limit = limitHeader ? Number(limitHeader) : null;
    const baseUrl = limit ? withParams(base, { 'paging.limit': limit }) : base;

    const walk = async (rel: 'next' | 'prev', cursorHeader: string, param: string) => {
      let url = baseUrl;
      let lastCursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const res = await getRaw(url);
        if (!res.ok) throw new QueryError(`HTTP ${res.status}`);
        const items = (await res.json()) as T[];
        pages++;
        for (const item of items) byId.set(item.id, item);

        const rels = linkRels(res.headers.get('link'));
        const cursor = res.headers.get(cursorHeader);
        // Stop on: no such rel advertised, no cursor to continue from, an empty page,
        // or a cursor that did not move (which would otherwise spin).
        if (!rels.has(rel) || !cursor || !items.length || cursor === lastCursor) return;
        lastCursor = cursor;
        url = withParams(baseUrl, { [param]: cursor });
      }
      truncated = true;
    };

    // Older first: that is the direction that actually yields anything from the base
    // response. Then newer, which matters once a cursor has been used.
    await walk('prev', 'x-paging-since', 'paging.until');
    await walk('next', 'x-paging-until', 'paging.since');

    return { items: [...byId.values()], pages, truncated, limit };
  }

  sender = (id: string) => getJson<QuerySender>(`${this.base()}/senders/${id}`);
  receiver = (id: string) => getJson<QueryReceiver>(`${this.base()}/receivers/${id}`);
  device = (id: string) => getJson<QueryDevice>(`${this.base()}/devices/${id}`);

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
      const base = this.base();
      await getJson<unknown>(`${base}/`);
      return { reachable: true, base };
    } catch (e) {
      log.debug({ registry: this.cfg.id, err: String(e) }, 'query API probe failed');
      return { reachable: false, base: null, error: (e as Error).message };
    }
  }
}
