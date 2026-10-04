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

export class QueryError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    const reason =
      err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)
        ? `timeout after ${Math.round(TIMEOUT_MS / 1000)} s`
        : ((err.cause as { code?: string } | undefined)?.code ?? err.message);
    throw new QueryError(reason);
  }
  if (!res.ok) throw new QueryError(`HTTP ${res.status}`);
  return (await res.json()) as T;
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

  senders = () => getJson<QuerySender[]>(`${this.base()}/senders`);
  receivers = () => getJson<QueryReceiver[]>(`${this.base()}/receivers`);
  devices = () => getJson<QueryDevice[]>(`${this.base()}/devices`);
  flows = () => getJson<QueryFlow[]>(`${this.base()}/flows`);

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
