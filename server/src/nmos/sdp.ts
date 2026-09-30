import type { Fabric, Leg } from '../types.js';
import { ipToInt } from '../federation/pool.js';

export interface SdpMedia {
  /** Index der m=-Zeile, 0-basiert. */
  index: number;
  type: string;            // video | audio | application
  port: number;
  /** Aus media-level c=, sonst session-level c=. */
  group: string | null;
  ttl: number | null;
  /** Quelle aus a=source-filter (SSM), sonst null. */
  sourceFilter: string | null;
  /** a=rtpmap: 96 raw/90000  ->  { payload: 96, encoding: 'raw', clockRate: 90000, params: [] } */
  rtpmap: { payload: number; encoding: string; clockRate: number; params: string[] } | null;
  /** Parameter aus a=fmtp, Schlüssel klein geschrieben. */
  fmtp: Record<string, string>;
  lines: string[];
}

export interface ParsedSdp {
  raw: string;
  eol: string;
  /** Adresse aus der o=-Zeile. */
  originAddress: string | null;
  sessionConnection: { group: string; ttl: number | null } | null;
  /** true, wenn a=group:DUP vorhanden ist — ST 2022-7. */
  dup: boolean;
  media: SdpMedia[];
  /** a=ts-refclk:ptp=... der ersten Media-Section, falls vorhanden. */
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
    if (eq < 0) out[token.toLowerCase()] = '';          // Flags wie "interlace"
    else out[token.slice(0, eq).trim().toLowerCase()] = token.slice(eq + 1).trim();
  }
  return out;
}

/** Session-Name aus s=, für abgeleitete Labels. */
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

  // Media ohne eigenes c= erbt die Session-Connection.
  for (const m of media) {
    if (!m.group && sessionConnection) {
      m.group = sessionConnection.group;
      m.ttl = sessionConnection.ttl;
    }
  }

  return { raw: text, eol, originAddress, sessionConnection, dup, media, tsRefclk };
}

/** Zuordnung Media-Section → Fabric. */
export interface FabricSubnets {
  red: string | null;   // CIDR, z. B. 10.1.1.0/24
  blue: string | null;
}

function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  if (!net || !bitsRaw) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net) & mask) >>> 0);
}

/**
 * Ordnet jedem Bein eine Fabric zu: primär über das Quell-Subnetz, hilfsweise über
 * die Reihenfolge der m=-Zeilen (Leg 0 = red, Leg 1 = blue).
 */
export function assignFabrics(parsed: ParsedSdp, subnets: FabricSubnets): Leg[] {
  const bySubnet = (src: string | null): Fabric | null => {
    if (!src) return null;
    if (subnets.red && inCidr(src, subnets.red)) return 'red';
    if (subnets.blue && inCidr(src, subnets.blue)) return 'blue';
    return null;
  };

  const order: Fabric[] = ['red', 'blue'];
  const legs: Leg[] = [];
  for (const m of parsed.media) {
    if (!m.group) continue;
    const src = m.sourceFilter ?? parsed.originAddress;
    const fabric = bySubnet(src) ?? order[legs.length % 2]!;
    legs.push({ fabric, group: m.group, source: m.sourceFilter, port: m.port });
  }
  return legs;
}

export interface SdpRewrite {
  /** Neue Adressen je Media-Index. */
  byMediaIndex: Map<number, { group: string; source: string | null }>;
  /** Neue o=-Adresse; Default: Quelle des ersten Beins. */
  originAddress?: string;
  /** a=ts-refclk der Zieldomäne; ohne Angabe bleibt die Original-Zeile stehen. */
  tsRefclk?: string;
}

/**
 * Schreibt Gruppen- und Quelladressen im SDP um und lässt alles andere in Ruhe —
 * insbesondere fmtp, mediaclk, Payload-Typen und Ports.
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
      // Session-Ebene
      const o = ORIGIN_RE.exec(line);
      if (o) {
        // sess-version hochzählen, damit Empfänger die Änderung sehen
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
