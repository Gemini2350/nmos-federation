/**
 * AMWA IS-13 NMOS Annotation — renaming our resources from a controller.
 *
 * A controller (NMOS-Crosspoint, among others) finds the Annotation API in a node's IS-04
 * `services` and PATCHes `{label, description, tags}` on `node/self`,
 * `node/devices/{id}`, `node/senders/{id}` or `node/receivers/{id}`; `null` restores the
 * default. The change is stored in the configuration — the same name the GUI edits — and
 * reaches every registry as a new version of the resource.
 *
 * Tags this software manages are not the controller's to set: a group hint written
 * through IS-13 becomes the port's group and role (BCP-002-01), the alias tag is ignored.
 */

export const ANNOTATION_VERSION = 'v1.0';
export const ANNOTATION_SERVICE = `urn:x-nmos:service:annotation/${ANNOTATION_VERSION}`;

export type AnnotationKind = 'node' | 'device' | 'sender' | 'receiver';

/** A PATCH body; `null` restores the default, per field and per tag. */
export interface AnnotationPatch {
  label?: string | null;
  description?: string | null;
  tags?: Record<string, string[] | null> | null;
}

/** Tags whose value this software owns. A group hint maps to group and role instead. */
export const GROUPHINT_TAG = 'urn:x-nmos:tag:grouphint/v1.0';
export const READ_ONLY_TAGS = ['urn:x-nmos-federation:alias-of'];

/** Generous, but bounded: a controller cannot grow the configuration file without end. */
const MAX_TEXT = 1024;
const MAX_TAGS = 64;

/**
 * Checks a PATCH body against IS-13's resource_core_patch schema. A violation is a 400
 * with the reason; what the schema allows but we cannot do is decided by the caller (500).
 */
export function validatePatch(body: unknown): { patch: AnnotationPatch } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the body must be an object' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !['label', 'description', 'tags'].includes(k));
  if (unknown.length) return { error: `not an annotation property: ${unknown.join(', ')}` };
  for (const key of ['label', 'description'] as const) {
    const v = b[key];
    if (v !== undefined && v !== null && typeof v !== 'string') return { error: `${key} must be a string or null` };
    if (typeof v === 'string' && v.length > MAX_TEXT) return { error: `${key} is longer than ${MAX_TEXT} characters` };
  }
  if (b.tags !== undefined && b.tags !== null) {
    if (typeof b.tags !== 'object' || Array.isArray(b.tags)) return { error: 'tags must be an object or null' };
    const entries = Object.entries(b.tags as Record<string, unknown>);
    if (entries.length > MAX_TAGS) return { error: `more than ${MAX_TAGS} tags` };
    for (const [k, v] of entries) {
      if (v === null) continue;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { error: `tag ${k} must be an array of strings, or null` };
      if (k.length > MAX_TEXT || v.some((x) => (x as string).length > MAX_TEXT)) return { error: `tag ${k} is too long` };
    }
  }
  return { patch: b as AnnotationPatch };
}

/**
 * The operator's own tags after a PATCH: per tag, an array sets it and null removes it;
 * `tags: null` removes them all. Undefined when none are left.
 */
export function mergeTags(
  current: Record<string, string[]> | undefined,
  patch: AnnotationPatch['tags'],
): Record<string, string[]> | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const out: Record<string, string[]> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === GROUPHINT_TAG) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** IS-13's view of a resource: its core properties. */
export const annotationOf = (res: { id: string; version: string; label: string; description: string; tags: Record<string, string[]> }) => ({
  id: res.id,
  version: res.version,
  label: res.label,
  description: res.description,
  tags: res.tags,
});
