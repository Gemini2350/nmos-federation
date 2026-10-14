import type { AppConfig, MirrorEntry } from '../config/schema.js';
import type { QueryClient } from '../nmos/query-client.js';
import { GROUPHINT } from './grouping.js';
import { passableControls } from './passthrough.js';

/**
 * What a copy keeps of its original besides the stream: its group hint, its device's
 * label (which disambiguates group names, and lets a copy find its original again),
 * the device's IS-12 / IS-08 controls and, for a sender, its source id. Read when the
 * copy is made; `null` records "the original has none" so it is not asked again.
 */
export async function readOrigin(
  query: QueryClient,
  mirror: Pick<MirrorEntry, 'kind' | 'originId' | 'originDeviceId'>,
): Promise<Pick<MirrorEntry, 'originGroupHint' | 'originDeviceLabel' | 'originControls' | 'originSourceId' | 'originCaps'>> {
  const [resource, device] = await Promise.all([
    mirror.kind === 'sender' ? query.sender(mirror.originId) : query.receiver(mirror.originId),
    query.device(mirror.originDeviceId).catch(() => null),
  ]);
  // IS-08 names a sender's output by its source, so a sender copy needs that id too.
  const flowId = mirror.kind === 'sender' ? (resource as { flow_id?: string | null }).flow_id : null;
  const flow = flowId ? await query.flow(flowId).catch(() => null) : null;
  return {
    originGroupHint: resource.tags?.[GROUPHINT]?.[0] ?? null,
    originCaps: (resource.caps as Record<string, unknown> | undefined) ?? null,
    originDeviceLabel: device?.label ?? null,
    originControls: device ? passableControls(device.controls) : null,
    ...(mirror.kind === 'sender' ? { originSourceId: flow?.source_id ?? null } : {}),
  };
}

/**
 * Finding an original again after it changed its ids.
 *
 * IS-04 wants ids to survive a restart; not every device obliges. One in the lab came
 * back with a new device id, new sender ids — and new multicast groups. Its copies
 * stayed bound to ids that no longer existed: their SDP was never updated (the change
 * feed and Refresh both look the original up by id), so without NAT they went on
 * publishing the old groups, and nothing arrived for anyone connecting to them; BCP-008
 * passthrough could not translate its touchpoints either.
 *
 * A copy whose original id is gone from its registry is re-bound when exactly one
 * resource of the same kind carries the original's label on a device with the
 * original device's label, and no other copy is bound to it. Anything less certain is
 * left alone and the copy is marked: re-binding to the wrong stream would be worse
 * than reporting a missing one.
 */
export type RebindDecision =
  | { status: 'present' }
  | { status: 'rebind'; resource: { id: string; device_id: string } }
  | { status: 'missing'; reason: string };

export function decideRebind(
  mirror: Pick<MirrorEntry, 'originId' | 'originLabel' | 'originDeviceLabel'>,
  resources: { id: string; label: string; device_id: string }[],
  deviceLabels: Map<string, string>,
  boundElsewhere: Set<string>,
): RebindDecision {
  if (resources.some((r) => r.id === mirror.originId)) return { status: 'present' };
  if (!mirror.originDeviceLabel) return { status: 'missing', reason: 'gone from the registry; its device is unknown, so it cannot be found again' };
  const candidates = resources.filter(
    (r) => r.label === mirror.originLabel && deviceLabels.get(r.device_id) === mirror.originDeviceLabel && !boundElsewhere.has(r.id),
  );
  if (candidates.length === 1) return { status: 'rebind', resource: candidates[0]! };
  return {
    status: 'missing',
    reason: candidates.length
      ? `gone from the registry; ${candidates.length} resources named "${mirror.originLabel}" on "${mirror.originDeviceLabel}" — ambiguous, not re-bound`
      : `gone from the registry; nothing named "${mirror.originLabel}" on "${mirror.originDeviceLabel}"`,
  };
}

export interface RebindResult {
  rebound: { mirrorId: string; label: string; from: string; to: string }[];
  missing: { mirrorId: string; label: string; reason: string }[];
  /** Copies whose original was marked missing and is back. */
  recovered: string[];
  /** Copies whose original changed its caps, taken over. */
  capsChanged: string[];
}

/**
 * Checks every copy against its registry and re-binds those whose original changed
 * ids. Mutates `cfg` (the copy entries and their proxy receivers); the caller saves it
 * and brings the channels up to date. Only registry reads — no device is contacted.
 */
export async function rebindMirrors(
  cfg: AppConfig,
  queryOf: (registryId: string) => QueryClient | null,
  now = new Date(),
): Promise<RebindResult> {
  const result: RebindResult = { rebound: [], missing: [], recovered: [], capsChanged: [] };
  for (const registryId of new Set(cfg.mirrors.map((m) => m.registryId))) {
    const query = queryOf(registryId);
    if (!query) continue;
    let senders, receivers, devices;
    try {
      [senders, receivers, devices] = await Promise.all([
        query.getAll<{ id: string; label: string; device_id: string; caps?: Record<string, unknown> }>('senders'),
        query.getAll<{ id: string; label: string; device_id: string; caps?: Record<string, unknown> }>('receivers'),
        query.getAll<{ id: string; label: string }>('devices'),
      ]);
    } catch {
      continue; // a registry that cannot answer says nothing about the originals
    }
    const deviceLabels = new Map(devices.items.map((d) => [d.id, d.label]));
    for (const mirror of cfg.mirrors.filter((m) => m.registryId === registryId)) {
      const list = mirror.kind === 'sender' ? senders.items : receivers.items;
      const bound = new Set(cfg.mirrors.filter((o) => o.id !== mirror.id && o.registryId === registryId && o.kind === mirror.kind).map((o) => o.originId));
      const decision = decideRebind(mirror, list, deviceLabels, bound);
      if (decision.status === 'present') {
        if (mirror.originMissing) {
          delete mirror.originMissing;
          result.recovered.push(mirror.id);
        }
        // The whole resource is in hand anyway: a device that changed what it can take
        // passes that on to its copy within a minute.
        const caps = list.find((r) => r.id === mirror.originId)?.caps ?? null;
        if (JSON.stringify(caps) !== JSON.stringify(mirror.originCaps ?? null)) {
          mirror.originCaps = caps;
          result.capsChanged.push(mirror.id);
        }
        continue;
      }
      if (decision.status === 'missing') {
        mirror.originMissing ??= { since: now.toISOString(), reason: decision.reason };
        mirror.originMissing.reason = decision.reason;
        result.missing.push({ mirrorId: mirror.id, label: mirror.originLabel, reason: decision.reason });
        continue;
      }
      const from = mirror.originId;
      mirror.originId = decision.resource.id;
      mirror.originDeviceId = decision.resource.device_id;
      delete mirror.originMissing;
      Object.assign(mirror, await readOrigin(query, mirror).catch(() => ({})));
      if (mirror.kind === 'receiver') {
        const proxy = cfg.receivers.find((r) => r.proxyFor?.mirrorId === mirror.id);
        if (proxy?.proxyFor) {
          proxy.proxyFor.receiverId = mirror.originId;
          proxy.proxyFor.deviceId = mirror.originDeviceId;
        }
      }
      result.rebound.push({ mirrorId: mirror.id, label: mirror.originLabel, from, to: mirror.originId });
    }
  }
  return result;
}
