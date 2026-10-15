import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Engine } from '../federation/engine.js';
import type { DomainConfig } from '../config/schema.js';
import { ANNOTATION_VERSION, annotationOf, validatePatch, type AnnotationKind, type AnnotationPatch } from './annotation.js';

/**
 * Applies a PATCH to the configuration. Runs through the REST write queue (see index.ts),
 * so it cannot overwrite a change the GUI is making at the same moment.
 */
export type Annotator = (kind: AnnotationKind, nmosId: string, patch: AnnotationPatch) => Promise<{ status: number; body: unknown }>;

type Plural = 'devices' | 'senders' | 'receivers';
const KIND: Record<Plural, AnnotationKind> = { devices: 'device', senders: 'sender', receivers: 'receiver' };

/**
 * IS-13 Annotation API, one per bridge node: `/x-nmos-bridge/{nodeId}/x-nmos/annotation/v1.0/`.
 *
 * A domain's node API serves every bridge touching it, so a single Annotation API could
 * not say which node `node/self` is. The node advertises its own base in `services`, and
 * below it only that node's resources exist.
 */
export function registerAnnotationApi(app: FastifyInstance, domain: DomainConfig, engine: Engine, annotate: Annotator): void {
  const base = `/x-nmos-bridge/:node/x-nmos/annotation/${ANNOTATION_VERSION}`;
  type P = { node: string; id?: string };

  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ code, error, debug: null });

  /** This node's resources in this domain — exactly what its IS-04 node API lists. */
  const scope = (nodeId: string) => {
    const r = engine.domainResources(domain.id);
    const self = r.nodes.find((n) => n.id === nodeId);
    if (!self) return undefined;
    const devices = r.devices.filter((d) => d.node_id === nodeId);
    const ids = new Set(devices.map((d) => d.id));
    return {
      self,
      devices,
      senders: r.senders.filter((s) => ids.has(s.device_id)),
      receivers: r.receivers.filter((x) => ids.has(x.device_id)),
    };
  };

  app.get(`/x-nmos-bridge/:node/`, async () => ['x-nmos/']);
  app.get(`/x-nmos-bridge/:node/x-nmos/`, async () => ['annotation/']);
  app.get(`/x-nmos-bridge/:node/x-nmos/annotation/`, async () => [`${ANNOTATION_VERSION}/`]);
  app.get<{ Params: P }>(`${base}/`, async () => ['node/']);
  app.get<{ Params: P }>(`${base}/node/`, async (req, reply) => {
    if (!scope(req.params.node)) return fail(reply, 404, 'unknown node');
    return ['self/', 'devices/', 'sources/', 'flows/', 'senders/', 'receivers/'];
  });

  app.get<{ Params: P }>(`${base}/node/self`, async (req, reply) => {
    const s = scope(req.params.node);
    return s ? annotationOf(s.self) : fail(reply, 404, 'unknown node');
  });

  // Sources and flows are not annotatable — they carry their sender's name. IS-13 asks
  // for an empty list then.
  for (const kind of ['sources', 'flows'] as const) {
    app.get<{ Params: P }>(`${base}/node/${kind}`, async (req, reply) => (scope(req.params.node) ? [] : fail(reply, 404, 'unknown node')));
    app.get<{ Params: P }>(`${base}/node/${kind}/:id`, async (_req, reply) => fail(reply, 404, `${kind} are not annotatable here`));
  }

  for (const kind of ['devices', 'senders', 'receivers'] as const) {
    app.get<{ Params: P }>(`${base}/node/${kind}`, async (req, reply) => {
      const s = scope(req.params.node);
      return s ? s[kind].map((x) => `${x.id}/`) : fail(reply, 404, 'unknown node');
    });
    app.get<{ Params: P }>(`${base}/node/${kind}/:id`, async (req, reply) => {
      const item = scope(req.params.node)?.[kind].find((x) => x.id === req.params.id);
      return item ? annotationOf(item) : fail(reply, 404, `unknown ${KIND[kind]}`);
    });
  }

  const patch = async (req: { params: P; body: unknown }, reply: FastifyReply, kind: AnnotationKind, plural?: Plural) => {
    const find = () => {
      const s = scope(req.params.node);
      if (!s) return undefined;
      return plural ? s[plural].find((x) => x.id === req.params.id) : s.self;
    };
    if (!find()) return fail(reply, 404, plural ? `unknown ${kind}` : 'unknown node');
    const checked = validatePatch(req.body);
    if ('error' in checked) return fail(reply, 400, checked.error);
    const res = await annotate(kind, find()!.id, checked.patch);
    if (res.status !== 200) return reply.code(res.status).send(res.body);
    // IS-13: the response is the updated resource, new version included.
    const after = find();
    return after ? annotationOf(after) : fail(reply, 404, `the ${kind} is gone`);
  };
  app.patch<{ Params: P }>(`${base}/node/self`, async (req, reply) => patch(req, reply, 'node'));
  for (const plural of ['devices', 'senders', 'receivers'] as const) {
    app.patch<{ Params: P }>(`${base}/node/${plural}/:id`, async (req, reply) => patch(req, reply, KIND[plural], plural));
  }
}
