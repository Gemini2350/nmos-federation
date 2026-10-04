import type { Fabric, Leg } from '../types.js';

export interface SdpMedia {
  /** Index of the m= line, zero-based. */
  index: number;
  type: string;            // video | audio | application
  port: number;
  /** From the media-level c=, else the session-level c=. */
  group: string | null;
  ttl: number | null;
  /** Source from a=source-filter (SSM), else null. */
  sourceFilter: string | null;
  /** a=rtpmap: 96 raw/90000  ->  { payload: 96, encoding: 'raw', clockRate: 90000, params: [] } */
  rtpmap: { payload: number; encoding: string; clockRate: number; params: string[] } | null;
  /** Parameters from a=fmtp, keys lower-cased. */
  fmtp: Record<string, string>;
  lines: string[];
}

export interface ParsedSdp {
  raw: string;
  eol: string;
  /** Address from the o= line. */
  originAddress: string | null;
  sessionConnection: { group: string; ttl: number | null } | null;
  /** true when a=group:DUP is present — ST 2022-7. */
  dup: boolean;
  media: SdpMedia[];
  /** a=ts-refclk:ptp=... of the first media section, if present. */
  tsRefclk: string | null;
}

const CONNECTION_RE = /^c=IN\s+IP4\s+([0-9.]+)(?:\/(\d+))?/i;
const SOURCE_FILTER_RE = /^a=source-filter:\s*incl\s+IN\s+IP4\s+([0-9.]+)\s+([0-9.]+)/i;
const ORIGIN_RE = /^o=(\S+)\s+(\S+)\s+(\S+)\s+IN\s+IP4\s+([0-9.]+)/i;
const RTPMAP_RE = /^a=rtpmap:\s*(\d+)\s+([^/]+)\/(\d+)(?:\/(.+))?/i;
const FMTP_RE = /^a=fmtp:\s*\d+\s+(.*)$/i;

/** "sampling=YCbCr-4:2:2; width=1920; TP=2110TPN;" -> { sampling: 'YCbCr-4:2:2', width: '1920', ... } */
function parseFmtp(params: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of params.split(';')) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) out[token.toLowerCase()] = '';          // flags such as "interlace"
    else out[token.slice(0, eq).trim().toLowerCase()] = token.slice(eq + 1).trim();
  }
  return out;
}

/** Session name from s=, used for derived labels. */
export function sessionName(parsed: ParsedSdp): string | null {
  const line = parsed.raw.split(/\r?\n/).find((l) => l.startsWith('s='));
  return line ? line.slice(2).trim() || null : null;
}

export function parseSdp(text: string): ParsedSdp {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  let originAddress: string | null = null;
  let sessionConnection: ParsedSdp['sessionConnection'] = null;
  let dup = false;
  let tsRefclk: string | null = null;
  const media: SdpMedia[] = [];
  let current: SdpMedia | null = null;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/);
      current = {
        index: media.length,
        type: parts[0] ?? 'unknown',
        port: Number(parts[1] ?? 0),
        group: null,
        ttl: null,
        sourceFilter: null,
        rtpmap: null,
        fmtp: {},
        lines: [line],
      };
      media.push(current);
      continue;
    }

    if (current) {
      current.lines.push(line);
      const c = CONNECTION_RE.exec(line);
      if (c) {
        current.group = c[1]!;
        current.ttl = c[2] ? Number(c[2]) : null;
        continue;
      }
      const sf = SOURCE_FILTER_RE.exec(line);
      if (sf) {
        current.sourceFilter = sf[2]!;
        continue;
      }
      const rtp = RTPMAP_RE.exec(line);
      if (rtp) {
        current.rtpmap = {
          payload: Number(rtp[1]),
          encoding: rtp[2]!.trim(),
          clockRate: Number(rtp[3]),
          params: rtp[4] ? rtp[4].split('/').map((x) => x.trim()) : [],
        };
        continue;
      }
      const fmtp = FMTP_RE.exec(line);
      if (fmtp) {
        current.fmtp = parseFmtp(fmtp[1]!);
        continue;
      }
      if (!tsRefclk && line.startsWith('a=ts-refclk:')) tsRefclk = line.slice('a=ts-refclk:'.length);
      continue;
    }

    // Session-Ebene
    const o = ORIGIN_RE.exec(line);
    if (o) {
      originAddress = o[4]!;
      continue;
    }
    const c = CONNECTION_RE.exec(line);
    if (c) {
      sessionConnection = { group: c[1]!, ttl: c[2] ? Number(c[2]) : null };
      continue;
    }
    if (/^a=group:DUP\b/i.test(line)) dup = true;
  }

  // Media without its own c= inherits the session connection.
  for (const m of media) {
    if (!m.group && sessionConnection) {
      m.group = sessionConnection.group;
      m.ttl = sessionConnection.ttl;
    }
  }

  return { raw: text, eol, originAddress, sessionConnection, dup, media, tsRefclk };
}

/**
 * Assigns a fabric to each leg **positionally**: the first `m=` line takes the first
 * entry of `order`, the second the other one.
 *
 * Not derived from source subnets. Which domain hangs on which switch interface is
 * already configured, so the mapping belongs to the plant description; guessing it from
 * an address only adds a way to silently NAT a stream onto the wrong fabric.
 *
 * For a redundant SDP the legs follow the order their `a=mid:` values appear in
 * `a=group:DUP`, which is what actually defines which leg is primary — falling back to
 * the order of the `m=` lines when the mids are absent.
 */
export function assignFabrics(parsed: ParsedSdp, order: Fabric[]): Leg[] {
  const usable = parsed.media.filter((m) => m.group);
  const ordered = parsed.dup ? orderByDupGroup(parsed, usable) : usable;
  return ordered.slice(0, order.length).map((m, i) => ({
    fabric: order[i]!,
    group: m.group!,
    source: m.sourceFilter,
    port: m.port,
  }));
}

/** `a=group:DUP PRIMARY SECONDARY` plus `a=mid:` per block defines the leg order. */
function orderByDupGroup(parsed: ParsedSdp, media: SdpMedia[]): SdpMedia[] {
  const groupLine = parsed.raw.split(/\r?\n/).find((l) => /^a=group:DUP\b/i.test(l));
  const mids = groupLine ? groupLine.trim().split(/\s+/).slice(1) : [];
  if (!mids.length) return media;
  const midOf = (m: SdpMedia) => m.lines.find((l) => l.startsWith('a=mid:'))?.slice('a=mid:'.length).trim();
  const byMid = new Map(media.map((m) => [midOf(m), m]));
  const ordered = mids.map((mid) => byMid.get(mid)).filter((m): m is SdpMedia => !!m);
  // Anything the group did not name keeps its original position behind the named ones.
  return [...ordered, ...media.filter((m) => !ordered.includes(m))];
}

/**
 * How many separate essences this SDP describes. More than one means it cannot be
 * represented as a single sender — a video+audio SDP is not a redundant pair, and
 * treating its two `m=` lines as legs would NAT an audio group as if it were the
 * second path of the video.
 */
export function essenceCount(parsed: ParsedSdp): number {
  const usable = parsed.media.filter((m) => m.group);
  if (parsed.dup) return usable.length > 2 ? usable.length - 1 : 1;
  return usable.length;
}

export interface SdpRewrite {
  /** New addresses per media index. */
  byMediaIndex: Map<number, { group: string; source: string | null }>;
  /** New o= address; defaults to the first leg's source. */
  originAddress?: string;
  /** Target domain's a=ts-refclk; without it the original line is kept. */
  tsRefclk?: string;
}

/**
 * Rewrites group and source addresses in the SDP and leaves everything else alone —
 * in particular fmtp, mediaclk, payload types and ports.
 */
export function rewriteSdp(text: string, rewrite: SdpRewrite): string {
  const parsed = parseSdp(text);
  const lines = text.split(/\r?\n/);
  const first = rewrite.byMediaIndex.get(0) ?? null;
  const newOrigin = rewrite.originAddress ?? first?.source ?? null;

  let mediaIndex = -1;
  const out = lines.map((line) => {
    if (line.startsWith('m=')) {
      mediaIndex++;
      return line;
    }
    const target = mediaIndex >= 0 ? rewrite.byMediaIndex.get(mediaIndex) : null;

    if (mediaIndex < 0) {
      // session level
      const o = ORIGIN_RE.exec(line);
      if (o) {
        // bump sess-version so receivers notice the change
        const version = /^\d+$/.test(o[3]!) ? String(BigInt(o[3]!) + 1n) : o[3]!;
        const addr = newOrigin ?? o[4]!;
        return `o=${o[1]} ${o[2]} ${version} IN IP4 ${addr}`;
      }
      const c = CONNECTION_RE.exec(line);
      if (c && first) {
        return `c=IN IP4 ${first.group}${c[2] ? `/${c[2]}` : ''}`;
      }
      return line;
    }

    if (!target) return line;

    const c = CONNECTION_RE.exec(line);
    if (c) return `c=IN IP4 ${target.group}${c[2] ? `/${c[2]}` : ''}`;

    const sf = SOURCE_FILTER_RE.exec(line);
    if (sf) {
      const src = target.source ?? sf[2]!;
      return `a=source-filter: incl IN IP4 ${target.group} ${src}`;
    }

    if (rewrite.tsRefclk && line.startsWith('a=ts-refclk:')) {
      return `a=ts-refclk:${rewrite.tsRefclk}`;
    }

    return line;
  });

  return out.join(parsed.eol);
}
