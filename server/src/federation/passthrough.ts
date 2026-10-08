/**
 * Passing an original device's control APIs through to its copies.
 *
 * When every port of a federation device is a copy of the same original device, that
 * device's status (BCP-008 over IS-12) and channel mapping (IS-08) belong to our copies
 * just as much. Our device then advertises those controls itself — pointing at a proxy
 * on this software's address in the domain the copies appear in — and the proxy
 * forwards to the original.
 *
 * Two things make a plain pass-through useless, and the proxy fixes both:
 *  - Reachability. The original's address lives in its own network; a controller on
 *    the other side reaches it only if unicast is routed between the domains, which a
 *    multicast-NAT plant typically does not do. This software has an address in both.
 *  - Identity. Both APIs name IS-04 resources by id — a BCP-008 monitor's touchpoint,
 *    an IS-08 input's parent, an output's source. Those are the ORIGINAL's ids; a
 *    controller looking for our copies would never match them. Every message is
 *    therefore translated: original ids to ours on the way out, ours to the original's
 *    on the way in. Ids we have no copy of pass unchanged.
 */

/** Control types passed through, and the path segment their proxy lives under. */
export const PASSTHROUGH: Record<string, { kind: 'ncp' | 'cm'; label: string }> = {
  'urn:x-nmos:control:ncp/v1.0': { kind: 'ncp', label: 'IS-12 / BCP-008' },
  'urn:x-nmos:control:cm-ctrl/v1.0': { kind: 'cm', label: 'IS-08' },
};

export interface Passthrough {
  /** The domain our copies — and so the proxied controls — appear in. */
  domainId: string;
  originDeviceId: string;
  originDeviceLabel: string | null;
  /** The original's controls, one per passed-through type. */
  controls: { type: string; href: string }[];
  /** Original id → ours, and back. Keys are lower-case. */
  toOurs: Map<string, string>;
  toOrigin: Map<string, string>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replaces every known id in a message; anything else passes as it is. */
export function translateIds(text: string, map: Map<string, string>): string {
  if (!map.size) return text;
  return text.replace(UUID, (id) => map.get(id.toLowerCase()) ?? id);
}

/** Controls of the original worth passing through — the first of each type. */
export function passableControls(controls: { type: string; href: string }[] | null | undefined): { type: string; href: string }[] {
  const out: { type: string; href: string }[] = [];
  for (const c of controls ?? []) {
    if (PASSTHROUGH[c.type] && !out.some((o) => o.type === c.type)) out.push({ type: c.type, href: c.href });
  }
  return out;
}
