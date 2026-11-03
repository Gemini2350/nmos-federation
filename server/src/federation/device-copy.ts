import type { AppConfig, MirrorEntry } from '../config/schema.js';
import type { DeviceFollow, FederationDevice } from '../types.js';

/**
 * A whole device copied 1:1: every sender and receiver it has now, and whatever it gains
 * later. The ports themselves are ordinary copies (`MirrorEntry`) — they follow their
 * originals' SDP, state and ids the way any copy does. All this adds is deciding which
 * resources of the device have no copy yet.
 *
 * What leaves the original is deliberately not removed here: to the registry a device
 * restarting looks the same as a port deleted for good. The copy goes offline with its
 * original and keeps its id, so controllers keep their connections; removing it for good
 * is the operator's call.
 */

export interface OriginDevice {
  id: string;
  label: string;
  node_id?: string;
  controls?: { type: string }[];
}
export interface OriginSender {
  id: string;
  label: string;
  device_id: string;
  transport?: string | null;
  manifest_href?: string | null;
}
export interface OriginReceiver {
  id: string;
  label: string;
  device_id: string;
  transport?: string | null;
  format?: string;
}
export interface RegistryContent {
  devices: OriginDevice[];
  senders: OriginSender[];
  receivers: OriginReceiver[];
}

export interface PlannedCopy {
  kind: 'sender' | 'receiver';
  id: string;
  label: string;
  format?: 'video' | 'audio' | 'data';
}

export type DeviceCopyPlan =
  | { status: 'offline'; reason: string }
  | { status: 'ok'; originDeviceId: string; originDeviceLabel: string; add: PlannedCopy[]; skipped: NonNullable<DeviceFollow['skipped']> };

const isMxl = (r: { transport?: string | null }): boolean => /^urn:x-nmos:transport:mxl\b/.test(r.transport ?? '');
const formatOf = (format = ''): 'video' | 'audio' | 'data' => (format.endsWith(':audio') ? 'audio' : format.endsWith(':data') ? 'data' : 'video');

/** The device in the registry: by id, or — a device that does not keep its ids — by its one namesake. */
function findOrigin(follow: DeviceFollow, cfg: Pick<AppConfig, 'devices'>, devices: OriginDevice[]): OriginDevice | string {
  const byId = devices.find((d) => d.id === follow.originDeviceId);
  if (byId) return byId;
  const taken = new Set(cfg.devices.filter((d) => d.follows?.registryId === follow.registryId).map((d) => d.follows!.originDeviceId));
  const namesakes = devices.filter((d) => d.label === follow.originDeviceLabel && !taken.has(d.id));
  if (namesakes.length === 1) return namesakes[0]!;
  return namesakes.length
    ? `${namesakes.length} devices named "${follow.originDeviceLabel}" — ambiguous`
    : `no device named "${follow.originDeviceLabel}" in the registry`;
}

/** What a followed device still lacks. Reads nothing and changes nothing. */
export function planDeviceCopy(device: FederationDevice, cfg: Pick<AppConfig, 'devices' | 'mirrors'>, registry: RegistryContent): DeviceCopyPlan {
  const follow = device.follows!;
  const origin = findOrigin(follow, cfg, registry.devices);
  if (typeof origin === 'string') return { status: 'offline', reason: origin };

  const add: PlannedCopy[] = [];
  const skipped: NonNullable<DeviceFollow['skipped']> = [];
  const controllable = !!origin.controls?.some((c) => c.type.startsWith('urn:x-nmos:control:sr-ctrl/'));

  const consider = (kind: 'sender' | 'receiver', r: OriginSender | OriginReceiver, refuse: string | null, format?: PlannedCopy['format']) => {
    const copy = cfg.mirrors.find((m) => m.registryId === follow.registryId && m.kind === kind && m.originId === r.id);
    if (copy) {
      if (copy.deviceId !== device.id) {
        const where = cfg.devices.find((d) => d.id === copy.deviceId)?.label ?? copy.deviceId;
        skipped.push({ kind, label: r.label, reason: `already copied into "${where}"` });
      }
      return;
    }
    // Removed here by hand: stays removed, also when the device comes back under new ids.
    if (follow.excluded?.some((x) => x.kind === kind && (x.id === r.id || x.label === r.label))) return;
    // A copy still missing its original may be waiting for exactly this one, when the
    // re-binding pass found the name ambiguous. A second copy would be worse than a wait.
    if (cfg.mirrors.some((m) => m.deviceId === device.id && m.kind === kind && m.originMissing && m.originLabel === r.label)) return;
    if (refuse) skipped.push({ kind, label: r.label, reason: refuse });
    else add.push({ kind, id: r.id, label: r.label, ...(format ? { format } : {}) });
  };

  for (const s of registry.senders.filter((x) => x.device_id === origin.id)) {
    consider('sender', s, isMxl(s) ? 'MXL is host-local' : s.manifest_href ? null : 'no manifest, so no SDP to read');
  }
  for (const r of registry.receivers.filter((x) => x.device_id === origin.id)) {
    consider('receiver', r, isMxl(r) ? 'MXL is host-local' : controllable ? null : 'its device offers no IS-05 control', formatOf(r.format));
  }
  return { status: 'ok', originDeviceId: origin.id, originDeviceLabel: origin.label, add, skipped };
}

/**
 * Takes what a plan found about the device itself into the configuration: new ids, a new
 * name — which a copy that was not renamed by hand follows. Says whether anything changed.
 */
export function applyOriginDevice(device: FederationDevice, cfg: Pick<AppConfig, 'mirrors'>, plan: Extract<DeviceCopyPlan, { status: 'ok' }>): boolean {
  const follow = device.follows!;
  let changed = false;
  if (follow.originDeviceId !== plan.originDeviceId) {
    follow.originDeviceId = plan.originDeviceId;
    changed = true;
  }
  if (follow.originDeviceLabel !== plan.originDeviceLabel) {
    if (device.label === follow.originDeviceLabel) device.label = plan.originDeviceLabel;
    follow.originDeviceLabel = plan.originDeviceLabel;
    // The name is what finds these originals again after an id change.
    for (const m of cfg.mirrors.filter((x) => x.deviceId === device.id)) m.originDeviceLabel = plan.originDeviceLabel;
    changed = true;
  }
  if (JSON.stringify(follow.skipped ?? []) !== JSON.stringify(plan.skipped)) {
    if (plan.skipped.length) follow.skipped = plan.skipped;
    else delete follow.skipped;
    changed = true;
  }
  return changed;
}

/** A copy removed by hand from a followed device must not come back with the next pass. */
export function excludeFromFollow(cfg: Pick<AppConfig, 'devices'>, mirror: MirrorEntry): void {
  const follow = cfg.devices.find((d) => d.id === mirror.deviceId)?.follows;
  // One whose original is gone is being cleared away, not refused.
  if (!follow || mirror.originMissing || mirror.registryId !== follow.registryId || mirror.originDeviceId !== follow.originDeviceId) return;
  (follow.excluded ??= []).push({ kind: mirror.kind, id: mirror.originId, label: mirror.originLabel });
}
