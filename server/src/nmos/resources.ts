import { createHash, randomUUID } from 'node:crypto';
import { parseSdp, sessionName, type ParsedSdp } from './sdp.js';

/**
 * Deterministic IDs (UUIDv5). A container restart must not break a controller's
 * bindings — so never randomUUID() for resources meant to survive a restart. The
 * seed is generated once and persisted in the state so that two installations do
 * not hand out the same IDs.
 */
export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const newSeed = (): string => randomUUID();

/** IS-04 version stamp "<seconds>:<nanoseconds>". */
export function nmosVersion(date = new Date()): string {
  const ms = date.getTime();
  return `${Math.floor(ms / 1000)}:${(ms % 1000) * 1_000_000}`;
}

export type NmosFormat = 'urn:x-nmos:format:video' | 'urn:x-nmos:format:audio' | 'urn:x-nmos:format:data';

export interface EssenceParams {
  format: NmosFormat;
  mediaType: string;
  label: string | null;
  video?: {
    frameWidth: number;
    frameHeight: number;
    grainRate: { numerator: number; denominator: number };
    interlaceMode: string;
    colorspace: string;
    transferCharacteristic: string;
    depth: number;
    components: { name: string; width: number; height: number; bit_depth: number }[];
  };
  audio?: { channels: number; sampleRate: number; bitDepth: number };
}

const COLORSPACE: Record<string, string> = { BT709: 'BT709', BT2020: 'BT2020', BT2100: 'BT2100', BT601: 'BT601' };
const TCS: Record<string, string> = { SDR: 'SDR', PQ: 'PQ', HLG: 'HLG', LINEAR: 'LINEAR' };

function grainRate(exact: string | undefined): { numerator: number; denominator: number } {
  if (!exact) throw new Error('fmtp without exactframerate');
  const [num, den] = exact.split('/');
  const numerator = Number(num);
  if (!Number.isFinite(numerator) || numerator <= 0) throw new Error(`cannot parse exactframerate: ${exact}`);
  return { numerator, denominator: den ? Number(den) : 1 };
}

/** ST 2110-20 components derived from sampling + depth. */
function components(sampling: string, width: number, height: number, depth: number) {
  const sub = sampling.includes('4:2:2') ? [2, 1] : sampling.includes('4:2:0') ? [2, 2] : [1, 1];
  if (sampling.startsWith('RGB')) {
    return ['R', 'G', 'B'].map((name) => ({ name, width, height, bit_depth: depth }));
  }
  return [
    { name: 'Y', width, height, bit_depth: depth },
    { name: 'Cb', width: width / sub[0]!, height: height / sub[1]!, bit_depth: depth },
    { name: 'Cr', width: width / sub[0]!, height: height / sub[1]!, bit_depth: depth },
  ];
}

/**
 * Derives flow/source parameters from the SDP. If that fails the channel goes to
 * `failed` — better no sender than a wrongly described one.
 */
export function essenceFromSdp(sdp: string | ParsedSdp): EssenceParams {
  const parsed = typeof sdp === 'string' ? parseSdp(sdp) : sdp;
  const media = parsed.media[0];
  if (!media) throw new Error('SDP without an m= line');
  const label = sessionName(parsed);
  const encoding = media.rtpmap?.encoding?.toLowerCase() ?? '';

  if (media.type === 'video' && encoding === 'raw') {
    const f = media.fmtp;
    const width = Number(f['width']);
    const height = Number(f['height']);
    const depth = Number(f['depth'] ?? 10);
    const sampling = f['sampling'] ?? '';
    if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) {
      throw new Error('fmtp without width/height');
    }
    if (!sampling) throw new Error('fmtp without sampling');
    const interlaceMode =
      'segmented' in f ? 'progressive_segmented_frame' : 'interlace' in f ? 'interlaced_tff' : 'progressive';
    return {
      format: 'urn:x-nmos:format:video',
      mediaType: 'video/raw',
      label,
      video: {
        frameWidth: width,
        frameHeight: height,
        grainRate: grainRate(f['exactframerate']),
        interlaceMode,
        colorspace: COLORSPACE[(f['colorimetry'] ?? 'BT709').toUpperCase()] ?? 'BT709',
        transferCharacteristic: TCS[(f['tcs'] ?? 'SDR').toUpperCase()] ?? 'SDR',
        depth,
        components: components(sampling, width, height, depth),
      },
    };
  }

  if (media.type === 'audio' && /^l(16|24|32)$/.test(encoding)) {
    const bitDepth = Number(encoding.slice(1));
    const channels = Number(media.rtpmap!.params[0] ?? 1);
    return {
      format: 'urn:x-nmos:format:audio',
      mediaType: `audio/${encoding.toUpperCase()}`,
      label,
      audio: { channels, sampleRate: media.rtpmap!.clockRate, bitDepth },
    };
  }

  if (media.type === 'video' && encoding === 'smpte291') {
    return { format: 'urn:x-nmos:format:data', mediaType: 'video/smpte291', label };
  }

  throw new Error(`unsupported essence: m=${media.type} rtpmap=${media.rtpmap?.encoding ?? '-'}`);
}

// ---------------------------------------------------------------------------
// IS-04 resources
// ---------------------------------------------------------------------------

export interface NodeIdentity {
  id: string;
  href: string;
  address: string;
  port: number;
  interfaceName: string;
}

export interface ClockInfo {
  /** The domain's ts-refclk, e.g. "ptp=IEEE1588-2008:08-00-…:0"; null = not used. */
  refclk: string | null;
}

const macFromRefclk = (refclk: string | null): string | null => {
  const m = refclk?.match(/IEEE1588-2008:([0-9A-Fa-f-]{23})/);
  return m ? m[1]!.toUpperCase() : null;
};

export function buildNode(identity: NodeIdentity, label: string, clock: ClockInfo, version = nmosVersion()) {
  const gmid = macFromRefclk(clock.refclk);
  return {
    id: identity.id,
    version,
    label,
    description: label,
    tags: {},
    href: identity.href,
    hostname: null,
    caps: {},
    api: {
      versions: ['v1.3'],
      endpoints: [{ host: identity.address, port: identity.port, protocol: 'http' }],
    },
    services: [],
    clocks: gmid
      ? [{ name: 'clk0', ref_type: 'ptp', traceable: true, version: 'IEEE1588-2008', gmid: gmid.toLowerCase(), locked: true }]
      : [{ name: 'clk0', ref_type: 'internal' }],
    interfaces: [{ name: identity.interfaceName, chassis_id: null, port_id: null }],
  };
}

export function buildDevice(
  id: string,
  nodeId: string,
  label: string,
  controlHref: string,
  senders: string[],
  receivers: string[],
  version = nmosVersion(),
) {
  return {
    id,
    version,
    label,
    description: label,
    tags: {},
    type: 'urn:x-nmos:device:generic',
    node_id: nodeId,
    senders,
    receivers,
    controls: [{ href: controlHref, type: 'urn:x-nmos:control:sr-ctrl/v1.1' }],
  };
}

export function buildSource(id: string, deviceId: string, label: string, essence: EssenceParams, version = nmosVersion()) {
  const base = {
    id,
    version,
    label,
    description: label,
    format: essence.format,
    caps: {},
    tags: {},
    device_id: deviceId,
    parents: [] as string[],
    clock_name: 'clk0',
  };
  if (essence.audio) {
    return { ...base, channels: Array.from({ length: essence.audio.channels }, (_, i) => ({ label: `Channel ${i + 1}` })) };
  }
  return base;
}

export function buildFlow(
  id: string,
  sourceId: string,
  deviceId: string,
  label: string,
  essence: EssenceParams,
  version = nmosVersion(),
) {
  const base = {
    id,
    version,
    label,
    description: label,
    tags: {},
    source_id: sourceId,
    device_id: deviceId,
    parents: [] as string[],
    format: essence.format,
    media_type: essence.mediaType,
  };
  if (essence.video) {
    return {
      ...base,
      grain_rate: essence.video.grainRate,
      frame_width: essence.video.frameWidth,
      frame_height: essence.video.frameHeight,
      interlace_mode: essence.video.interlaceMode,
      colorspace: essence.video.colorspace,
      transfer_characteristic: essence.video.transferCharacteristic,
      components: essence.video.components,
    };
  }
  if (essence.audio) {
    return {
      ...base,
      sample_rate: { numerator: essence.audio.sampleRate, denominator: 1 },
      bit_depth: essence.audio.bitDepth,
    };
  }
  return base;
}

export function buildSender(
  id: string,
  flowId: string,
  deviceId: string,
  label: string,
  manifestHref: string,
  interfaceBindings: string[],
  version = nmosVersion(),
) {
  return {
    id,
    version,
    label,
    description: label,
    tags: {},
    flow_id: flowId,
    transport: 'urn:x-nmos:transport:rtp.mcast',
    device_id: deviceId,
    manifest_href: manifestHref,
    interface_bindings: interfaceBindings,
    subscription: { receiver_id: null, active: true },
    caps: {},
  };
}

export function buildReceiver(
  id: string,
  deviceId: string,
  label: string,
  format: NmosFormat,
  mediaTypes: string[],
  interfaceBindings: string[],
  subscription: { sender_id: string | null; active: boolean },
  version = nmosVersion(),
) {
  return {
    id,
    version,
    label,
    description: label,
    tags: {},
    format,
    caps: { media_types: mediaTypes },
    device_id: deviceId,
    transport: 'urn:x-nmos:transport:rtp.mcast',
    interface_bindings: interfaceBindings,
    subscription,
  };
}

export const MEDIA_TYPES: Record<'video' | 'audio' | 'data', { format: NmosFormat; mediaTypes: string[] }> = {
  video: { format: 'urn:x-nmos:format:video', mediaTypes: ['video/raw'] },
  audio: { format: 'urn:x-nmos:format:audio', mediaTypes: ['audio/L24', 'audio/L16'] },
  data: { format: 'urn:x-nmos:format:data', mediaTypes: ['video/smpte291'] },
};
