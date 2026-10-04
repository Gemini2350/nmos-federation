import { promises as dns } from 'node:dns';
import { readFile } from 'node:fs/promises';
import makeMdns from 'multicast-dns';
import { log } from '../util/log.js';

/**
 * DNS-SD discovery for NMOS registries.
 *
 * Three things this has to get right, each of which is easy to get wrong:
 *
 *  1. DNS-SD is a two-step lookup. The service name carries a PTR record pointing at
 *     instance names; SRV and TXT hang off the *instance*. Querying SRV directly on
 *     `_nmos-register._tcp.<domain>` finds nothing on a correctly configured server.
 *  2. `.local` is mDNS and cannot be resolved through `node:dns` at all — that is
 *     unicast DNS only. The multicast path needs its own socket, hence multicast-dns.
 *  3. TXT decides the outcome: `api_proto` picks http vs https, `api_ver` says whether
 *     the registry speaks our version, and `pri` orders the candidates (lower wins,
 *     >= 100 means "not for production").
 */

/** IS-04 v1.3 renamed the service; older registries still advertise the old name. */
export const SERVICE_TYPES = ['_nmos-register._tcp', '_nmos-registration._tcp'];

/**
 * Last-resort address recovery from the instance name.
 *
 * nmos-cpp names its instances `nmos-cpp_registration_<ip-with-dashes>_<port>`. That
 * matters in practice: when an mDNS reflector carries announcements across a subnet
 * boundary it forwards the service records but not the host's A record, and the host
 * does not answer our A query either because it is not on our link. The announcement
 * then names a `.local` host we can never resolve — while the address is sitting right
 * there in the instance name.
 *
 * Only used when no A record arrived, and reported as a guess.
 */
export function addressFromInstanceName(instance: string): string | null {
  const m = /(?:^|[_.])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?:[_.]|$)/.exec(instance);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.join('.');
}

export interface DiscoveredRegistry {
  /** Instance name as advertised. */
  instance: string;
  url: string;
  /** Host as advertised in SRV — may be a .local name. */
  host: string;
  /** Address from the accompanying A/AAAA record, or recovered from the instance name. */
  address: string | null;
  /** Where `address` came from — an instance-name guess is worth showing as such. */
  addressSource: 'a-record' | 'instance-name' | null;
  port: number;
  proto: 'http' | 'https';
  versions: string[];
  /** TXT `pri`; lower is better. */
  priority: number;
  via: 'unicast' | 'mdns';
  serviceType: string;
  domain: string;
}

export interface DiscoveryResult {
  found: DiscoveredRegistry[];
  /** Everything that was queried, so a failure is diagnosable. */
  tried: string[];
  notes: string[];
}

const TXT_TIMEOUT_MS = 3000;
const MDNS_TIMEOUT_MS = 3000;

/**
 * Search domains the host was given — with `network_mode: host` these come straight
 * from DHCP. Node exposes no API for the search list, so resolv.conf it is.
 */
export async function hostSearchDomains(path = '/etc/resolv.conf'): Promise<string[]> {
  const out: string[] = [];
  try {
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const m = /^(search|domain)\s+(.+)$/i.exec(trimmed);
      if (m) {
        for (const d of m[2]!.split(/\s+/)) {
          const clean = d.replace(/\.$/, '');
          // "." and a bare "local" search entry are useless for unicast DNS-SD.
          if (clean && clean !== '.' && !out.includes(clean)) out.push(clean);
        }
      }
    }
  } catch {
    /* no resolv.conf (or unreadable) — fall back to mDNS only */
  }
  return out;
}

function parseTxt(records: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of records) {
    const eq = entry.indexOf('=');
    if (eq < 0) out[entry.toLowerCase()] = '';
    else out[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
  }
  return out;
}

export function buildCandidate(
  instance: string,
  host: string,
  port: number,
  txt: Record<string, string>,
  srvPriority: number,
  via: DiscoveredRegistry['via'],
  serviceType: string,
  domain: string,
  address: string | null = null,
  addressSource: DiscoveredRegistry['addressSource'] = address ? 'a-record' : null,
): DiscoveredRegistry {
  const proto = txt['api_proto'] === 'https' ? 'https' : 'http';
  const versions = (txt['api_ver'] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const pri = Number(txt['pri']);
  const cleanHost = host.replace(/\.$/, '');
  const defaultPort = proto === 'https' ? 443 : 80;
  // A `.local` SRV target is useless to an HTTP client: Node's resolver does not do
  // mDNS either, so the hostname would time out. Use the address from the A record
  // that came with the announcement, and keep the name only for display.
  const target = cleanHost.endsWith('.local') && address ? address : cleanHost;
  const authority = target.includes(':') ? `[${target}]` : target;
  const url = port === defaultPort ? `${proto}://${authority}` : `${proto}://${authority}:${port}`;
  return {
    instance,
    url,
    host: cleanHost,
    address,
    addressSource,
    port,
    proto,
    versions,
    priority: Number.isFinite(pri) ? pri : srvPriority,
    via,
    serviceType,
    domain,
  };
}

/** Unicast DNS-SD: PTR on the service name, then SRV and TXT per instance. */
export async function discoverUnicast(domains: string[]): Promise<DiscoveryResult> {
  const found: DiscoveredRegistry[] = [];
  const tried: string[] = [];
  const notes: string[] = [];

  for (const domain of domains) {
    for (const type of SERVICE_TYPES) {
      const serviceName = `${type}.${domain}`;
      tried.push(`PTR ${serviceName}`);
      let instances: string[];
      try {
        instances = await dns.resolvePtr(serviceName);
      } catch (e) {
        const code = (e as { code?: string }).code ?? (e as Error).message;
        if (code !== 'ENOTFOUND' && code !== 'ENODATA') notes.push(`PTR ${serviceName}: ${code}`);
        continue;
      }
      for (const instance of instances) {
        const name = instance.replace(/\.$/, '');
        try {
          const [srv, txtRaw] = await Promise.all([
            dns.resolveSrv(name),
            dns.resolveTxt(name).catch(() => [] as string[][]),
          ]);
          const txt = parseTxt(txtRaw.flat());
          for (const entry of srv) {
            found.push(buildCandidate(name, entry.name, entry.port, txt, entry.priority, 'unicast', type, domain));
          }
        } catch (e) {
          notes.push(`SRV ${name}: ${(e as { code?: string }).code ?? (e as Error).message}`);
        }
      }
    }
  }
  return { found, tried, notes };
}

/**
 * mDNS: the `.local` case. One query per service type, collecting answers until the
 * timeout — there is no "end of results" in multicast DNS.
 */
export async function discoverMdns(timeoutMs = MDNS_TIMEOUT_MS): Promise<DiscoveryResult> {
  const found: DiscoveredRegistry[] = [];
  const tried = SERVICE_TYPES.map((t) => `mDNS PTR ${t}.local`);
  const notes: string[] = [];

  let mdns: ReturnType<typeof makeMdns>;
  try {
    mdns = makeMdns();
  } catch (e) {
    return { found, tried, notes: [`mDNS socket: ${(e as Error).message}`] };
  }

  // Instance -> what we know so far; SRV and TXT usually arrive in the same packet,
  // but nothing guarantees it.
  const srvByInstance = new Map<string, { host: string; port: number; priority: number; type: string }>();
  const txtByInstance = new Map<string, Record<string, string>>();
  /** A/AAAA records from the same announcement — the only way to reach a .local host. */
  const addressByHost = new Map<string, string>();

  const onResponse = (response: { answers?: unknown[]; additionals?: unknown[] }) => {
    const records = [...(response.answers ?? []), ...(response.additionals ?? [])] as {
      name: string;
      type: string;
      data: unknown;
    }[];
    for (const rec of records) {
      const serviceType = SERVICE_TYPES.find((t) => rec.name.startsWith(`${t}.`) || rec.name.endsWith(`.${t}.local`));
      if (rec.type === 'SRV') {
        const data = rec.data as { target: string; port: number; priority: number };
        const type = SERVICE_TYPES.find((t) => rec.name.includes(t)) ?? SERVICE_TYPES[0]!;
        srvByInstance.set(rec.name, { host: data.target, port: data.port, priority: data.priority, type });
      } else if (rec.type === 'TXT') {
        const raw = rec.data as Buffer | Buffer[] | string | string[];
        const list = (Array.isArray(raw) ? raw : [raw]).map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)));
        txtByInstance.set(rec.name, parseTxt(list));
      } else if (rec.type === 'A' || rec.type === 'AAAA') {
        const name = rec.name.replace(/\.$/, '');
        // Prefer IPv4: plenty of registries publish a link-local v6 that is useless here.
        if (rec.type === 'A' || !addressByHost.has(name)) addressByHost.set(name, String(rec.data));
      } else if (rec.type === 'PTR' && serviceType) {
        /* the instance name itself arrives with SRV below */
      }
    }
  };

  mdns.on('response', onResponse);
  const askPtr = () => {
    for (const type of SERVICE_TYPES) {
      mdns.query({ questions: [{ name: `${type}.local`, type: 'PTR' }] });
    }
  };
  // Ask repeatedly. A single query is routinely missed — especially from a
  // freshly started process, which is exactly the case at server startup — and
  // responders only suppress duplicates for a short window.
  askPtr();
  for (const delay of [400, 800]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    askPtr();
  }
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));

  // A real responder often sends the A record in a separate packet, or only when
  // asked. Anything still without an address gets an explicit query — without it a
  // .local target stays unreachable, which defeats the whole discovery.
  const unresolved = [...new Set([...srvByInstance.values()].map((s2) => s2.host.replace(/\.$/, '')))].filter(
    (host) => !addressByHost.has(host),
  );
  if (unresolved.length) {
    for (const host of unresolved) {
      mdns.query({ questions: [{ name: host, type: 'A' }] });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 1500)));
  }

  mdns.removeListener('response', onResponse);
  try {
    mdns.destroy();
  } catch {
    /* already closed */
  }

  for (const [instance, srv] of srvByInstance) {
    if (!SERVICE_TYPES.some((t) => instance.includes(t))) continue;
    const txt = txtByInstance.get(instance) ?? {};
    const host = srv.host.replace(/\.$/, '');
    let address = addressByHost.get(host) ?? null;
    let source: DiscoveredRegistry['addressSource'] = address ? 'a-record' : null;

    if (!address && host.endsWith('.local')) {
      address = addressFromInstanceName(instance);
      if (address) {
        source = 'instance-name';
        notes.push(`${instance}: no A record for ${host}; using ${address} from the instance name`);
      } else {
        notes.push(`${instance}: announced ${host} but no A record and no address in the name — configure ip/port instead`);
      }
    }
    found.push(buildCandidate(instance, srv.host, srv.port, txt, srv.priority, 'mdns', srv.type, 'local', address, source));
  }
  return { found, tried, notes };
}

/**
 * Best candidate first: **unicast always before mDNS**, then lower TXT `pri` within the
 * same mechanism, then a stable order.
 *
 * Unicast is the administratively configured answer; mDNS is opportunistic and fragile
 * across subnets. A `pri` value only ranks registries announced the same way — an mDNS
 * announcement with a better `pri` must not override what the network's DNS says.
 * (The original ordering compared URLs as strings on a tie, so an mDNS hit on a bare IP
 * beat a unicast hit on a hostname simply because a digit sorts before a letter.)
 */
export function compareCandidates(a: DiscoveredRegistry, b: DiscoveredRegistry): number {
  const viaRank = (r: DiscoveredRegistry) => (r.via === 'unicast' ? 0 : 1);
  return viaRank(a) - viaRank(b) || a.priority - b.priority || a.url.localeCompare(b.url);
}

export interface DiscoverOptions {
  /** Explicitly configured search domain; empty = take the host's. */
  domain?: string;
  /** API version the registry has to speak, e.g. "v1.3". */
  version?: string;
  /** Skip the multicast path. */
  unicastOnly?: boolean;
  resolvConfPath?: string;
  mdnsTimeoutMs?: number;
}

/**
 * Full discovery: unicast across the configured or host-provided search domains,
 * then mDNS. Returns every candidate, best first, plus what was tried — a discovery
 * failure is only actionable if you can see which names were queried.
 */
export async function discoverRegistries(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const explicit = opts.domain?.replace(/^\.|\.$/g, '').trim();
  const domains = explicit ? [explicit] : await hostSearchDomains(opts.resolvConfPath);
  const notes: string[] = [];
  const tried: string[] = [];
  let found: DiscoveredRegistry[] = [];

  if (domains.length) {
    const unicast = await discoverUnicast(domains);
    found = found.concat(unicast.found);
    tried.push(...unicast.tried);
    notes.push(...unicast.notes);
  } else if (!explicit) {
    notes.push('no search domain configured and none found in resolv.conf — unicast DNS-SD skipped');
  }

  if (!opts.unicastOnly) {
    const mdns = await discoverMdns(opts.mdnsTimeoutMs);
    found = found.concat(mdns.found);
    tried.push(...mdns.tried);
    notes.push(...mdns.notes);
  }

  // Drop registries that do not speak our version, and the ones explicitly marked as
  // not for production. A registry that advertises no api_ver at all is kept — some
  // implementations omit it, and refusing it outright would be worse than trying.
  const wanted = opts.version;
  const usable = found.filter((r) => {
    if (r.priority >= 100) {
      notes.push(`${r.instance} skipped: pri=${r.priority} means not for production use`);
      return false;
    }
    if (wanted && r.versions.length && !r.versions.includes(wanted)) {
      notes.push(`${r.instance} skipped: advertises ${r.versions.join(',')}, needs ${wanted}`);
      return false;
    }
    return true;
  });

  usable.sort(compareCandidates);

  // The same registry is routinely announced under both service types, and a dual
  // stack host answers twice. One entry per address is what the operator wants to see.
  const deduped: DiscoveredRegistry[] = [];
  for (const candidate of usable) {
    const seen = deduped.find((d) => d.url === candidate.url);
    if (!seen) deduped.push(candidate);
    else if (!seen.versions.length && candidate.versions.length) seen.versions = candidate.versions;
  }

  log.debug({ found: deduped.length, domains, tried: tried.length }, 'DNS-SD discovery finished');
  return { found: deduped, tried, notes };
}
