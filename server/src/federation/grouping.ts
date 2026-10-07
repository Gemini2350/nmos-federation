/**
 * Natural grouping (AMWA BCP-002-01) for the ports of a federation device.
 *
 * A controller groups senders and receivers that belong together — the video, audio
 * and ancillary of one camera — by the tag `urn:x-nmos:tag:grouphint/v1.0`, whose value
 * is `<group>:<role>[:<scope>]`. Most devices in the field set it; a copy that dropped it
 * turned a tidy "Service 01: Video 1, Audio 1, Anc 1" into three loose entries.
 *
 * Where a port's hint comes from, in order:
 *  1. a group the operator typed for it — the role is then the original's, or derived
 *     from the format ("Video 1", "Audio 2") for a free virtual receiver;
 *  2. for a copy, the original's own hint;
 *  3. nothing.
 *
 * One federation device can hold copies of several original devices, and group names
 * are only unique per device ("Receive0" exists on every SDI card). Two originals from
 * different devices with the same group name would merge into one group here, so such
 * a name gets its original device's label in front.
 */

export const GROUPHINT = 'urn:x-nmos:tag:grouphint/v1.0';

export interface GroupHint {
  group: string;
  role: string;
  /** "device" (the default) or "node". */
  scope?: string;
}

export function parseGroupHint(value: string | null | undefined): GroupHint | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length < 2) return null;
  let scope: string | undefined;
  if (parts.length >= 3 && (parts[parts.length - 1] === 'device' || parts[parts.length - 1] === 'node')) {
    scope = parts.pop();
  }
  const role = parts.pop()!.trim();
  const group = parts.join(':').trim();
  if (!group || !role) return null;
  return { group, role, ...(scope ? { scope } : {}) };
}

export function formatGroupHint(h: GroupHint): string {
  return `${h.group}:${h.role}${h.scope ? `:${h.scope}` : ''}`;
}

export interface Port {
  /** The channel key: a virtual receiver's id, or `mirror-<id>` for a sender copy. */
  key: string;
  format: 'video' | 'audio' | 'data';
  /** Group the operator set; empty = none. */
  group?: string;
  /** For a copy: the original's hint and the device it sits on. */
  origin?: { hint: string | null | undefined; deviceId: string; deviceLabel?: string | null };
}

const ROLE: Record<Port['format'], string> = { video: 'Video', audio: 'Audio', data: 'Data' };

/** Effective hint per port key, for the ports of ONE federation device, in their order. */
export function groupHints(ports: Port[]): Map<string, GroupHint> {
  const out = new Map<string, GroupHint>();

  // Inherited names that come from more than one original device would merge here.
  const devicesPerGroup = new Map<string, Set<string>>();
  for (const p of ports) {
    if (p.group?.trim()) continue;
    const hint = parseGroupHint(p.origin?.hint);
    if (!hint || !p.origin) continue;
    const set = devicesPerGroup.get(hint.group) ?? new Set<string>();
    set.add(p.origin.deviceId);
    devicesPerGroup.set(hint.group, set);
  }

  const pendingRole: Port[] = [];
  for (const p of ports) {
    const own = p.group?.trim();
    const inherited = parseGroupHint(p.origin?.hint);
    if (own) {
      if (inherited) out.set(p.key, { group: own, role: inherited.role });
      else pendingRole.push(p);
      continue;
    }
    if (!inherited || !p.origin) continue;
    const clash = (devicesPerGroup.get(inherited.group)?.size ?? 0) > 1;
    const prefix = p.origin.deviceLabel?.trim() || p.origin.deviceId.slice(0, 8);
    out.set(p.key, { ...inherited, group: clash ? `${prefix} / ${inherited.group}` : inherited.group });
  }

  // Free virtual receivers in a group: number the roles per format, in port order.
  const counters = new Map<string, number>();
  for (const p of pendingRole) {
    const group = p.group!.trim();
    const n = (counters.get(`${group}|${p.format}`) ?? 0) + 1;
    counters.set(`${group}|${p.format}`, n);
    out.set(p.key, { group, role: `${ROLE[p.format]} ${n}` });
  }
  return out;
}

/** The `tags` object for a resource with this hint. */
export function grouphintTags(hint: GroupHint | undefined): Record<string, string[]> {
  return hint ? { [GROUPHINT]: [formatGroupHint(hint)] } : {};
}
