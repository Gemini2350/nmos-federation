import type { FastifyInstance } from 'fastify';
import type { DomainConfig } from '../config/schema.js';
import type { Engine } from '../federation/engine.js';
import type { StateStore } from '../federation/state.js';
import { emptyConnection, type ConnectionState } from '../federation/state.js';
import { log } from '../util/log.js';
import { registerControlProxy } from './control-proxy.js';

/**
 * IS-04 Node API + IS-05 Connection API for **one** domain.
 *
 * The IS-05 activation of a virtual receiver is the trigger for the whole federation
 * chain: transport_file (SDP) + master_enable=true -> Engine.activate().
 *
 * Virtual senders are read-only; /transportfile serves the rewritten SDP.
 */

const NODE_VER = 'v1.3';
const CONN_VER = 'v1.1';

interface ActivationRequest {
  mode?: 'activate_immediate' | 'activate_scheduled_absolute' | 'activate_scheduled_relative' | null;
  requested_time?: string | null;
}

interface StagedPatch {
  sender_id?: string | null;
  master_enable?: boolean;
  transport_file?: { data?: string | null; type?: string | null };
  transport_params?: Record<string, unknown>[];
  activation?: ActivationRequest;
}

export function registerNodeApi(app: FastifyInstance, domain: DomainConfig, engine: Engine, state: StateStore): void {
  const res = () => engine.domainResources(domain.id);

  /** NMOS receiver ID -> our virtual receiver. */
  const vrxByNmosId = (nmosId: string) =>
    engine.config.receivers.find((r) => engine.receiverNmosId(r.id) === nmosId);

  const channelBySenderNmosId = (nmosId: string) =>
    engine.channels().find((c) => c.targetDomain === domain.id && engine.senderNmosId(c.receiverId) === nmosId);

  // ---- Discovery paths ----------------------------------------------------
  // node.href points at the root, so the root has to answer. It used to be a 404, and so
  // was the device's control href, because it lacked the trailing slash the route was
  // registered with. The app is created with ignoreTrailingSlash, and a test follows
  // every href we publish.
  app.get('/', async () => ['x-nmos/']);
  app.get('/x-nmos/', async () => ['node/', 'connection/']);
  app.get('/x-nmos/node/', async () => [`${NODE_VER}/`]);
  app.get(`/x-nmos/node/${NODE_VER}/`, async () => ['self/', 'devices/', 'sources/', 'flows/', 'senders/', 'receivers/']);
  app.get('/x-nmos/connection/', async () => [`${CONN_VER}/`]);
  app.get(`/x-nmos/connection/${CONN_VER}/`, async () => ['bulk/', 'single/']);
  app.get(`/x-nmos/connection/${CONN_VER}/single/`, async () => ['senders/', 'receivers/']);

  // ---- IS-04 --------------------------------------------------------------
  /**
   * `self` is a single node, but a domain can carry several — one per bridge touching
   * it. The first is served here and all of them are listed under /nodes, which is what
   * a registry gets anyway; a controller reaching this API already knows which node it
   * came from.
   */
  app.get(`/x-nmos/node/${NODE_VER}/self`, async (_req, reply) => {
    const first = res().nodes[0];
    if (!first) return reply.code(404).send({ code: 404, error: 'no node in this domain', debug: null });
    return first;
  });

  app.get(`/x-nmos/node/${NODE_VER}/nodes`, async () => res().nodes);

  for (const kind of ['devices', 'sources', 'flows', 'senders', 'receivers'] as const) {
    app.get(`/x-nmos/node/${NODE_VER}/${kind}`, async () => res()[kind === 'devices' ? 'devices' : kind]);
    app.get<{ Params: { id: string } }>(`/x-nmos/node/${NODE_VER}/${kind}/:id`, async (req, reply) => {
      const list = res()[kind] as { id: string }[];
      const item = list.find((x) => x.id === req.params.id);
      if (!item) return reply.code(404).send({ code: 404, error: 'not found', debug: null });
      return item;
    });
  }

  // ---- IS-05 senders (read-only) -----------------------------------------
  app.get(`/x-nmos/connection/${CONN_VER}/single/senders`, async () => res().senders.map((s) => `${s.id}/`));

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id`, async () => [
    'constraints/',
    'staged/',
    'active/',
    'transportfile/',
    'transporttype/',
  ]);

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/transporttype`, async () => 'urn:x-nmos:transport:rtp.mcast');

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/constraints`, async (req) => {
    const channel = channelBySenderNmosId(req.params.id);
    return (channel?.legs ?? [{}]).map(() => ({}));
  });

  const senderState = (id: string) => {
    const channel = channelBySenderNmosId(id);
    const alloc = channel?.allocation ?? null;
    const params = alloc
      ? channel!.legs.map((leg) => ({
          destination_ip: alloc.groups[leg.fabric],
          source_ip: alloc.sources?.[leg.fabric] ?? null,
          destination_port: leg.port,
          rtp_enabled: true,
        }))
      : [{ destination_ip: null, source_ip: null, destination_port: null, rtp_enabled: channel?.state === 'active' }];
    return {
      master_enable: channel?.state === 'active',
      activation: { mode: null, requested_time: null, activation_time: null },
      receiver_id: null,
      transport_params: params,
    };
  };
  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/active`, async (req) => senderState(req.params.id));
  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/staged`, async (req) => senderState(req.params.id));

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/transportfile`, async (req, reply) => {
    const channel = channelBySenderNmosId(req.params.id);
    if (!channel?.senderSdp) return reply.code(404).send({ code: 404, error: 'no active transport file', debug: null });
    return reply.type('application/sdp').send(channel.senderSdp);
  });

  // A foreign controller must not reconfigure our virtual senders.
  app.patch<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/senders/:id/staged`, async (req, reply) =>
    reply.code(423).send({
      code: 423,
      error: 'virtual senders are driven by the federation and cannot be patched',
      debug: null,
    }),
  );

  // ---- IS-05 receivers ---------------------------------------------------
  app.get(`/x-nmos/connection/${CONN_VER}/single/receivers`, async () => res().receivers.map((r) => `${r.id}/`));

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/receivers/:id`, async () => [
    'constraints/',
    'staged/',
    'active/',
    'transporttype/',
  ]);

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/receivers/:id/transporttype`, async () => 'urn:x-nmos:transport:rtp.mcast');

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/receivers/:id/constraints`, async () => [{}, {}]);

  const shape = (conn: ConnectionState, activation: Record<string, unknown> | null = null) => ({
    sender_id: conn.sender_id,
    master_enable: conn.master_enable,
    activation: activation ?? { mode: null, requested_time: null, activation_time: null },
    transport_file: conn.transport_file,
    transport_params: conn.transport_params,
  });

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/receivers/:id/staged`, async (req, reply) => {
    const vrx = vrxByNmosId(req.params.id);
    if (!vrx) return reply.code(404).send({ code: 404, error: 'not found', debug: null });
    return shape(state.connection(vrx.id).staged);
  });

  app.get<{ Params: { id: string } }>(`/x-nmos/connection/${CONN_VER}/single/receivers/:id/active`, async (req, reply) => {
    const vrx = vrxByNmosId(req.params.id);
    if (!vrx) return reply.code(404).send({ code: 404, error: 'not found', debug: null });
    return shape(state.connection(vrx.id).active);
  });

  app.patch<{ Params: { id: string }; Body: StagedPatch }>(
    `/x-nmos/connection/${CONN_VER}/single/receivers/:id/staged`,
    async (req, reply) => {
      const vrx = vrxByNmosId(req.params.id);
      if (!vrx) return reply.code(404).send({ code: 404, error: 'not found', debug: null });
      if (!vrx.enabled) {
        return reply.code(423).send({ code: 423, error: 'virtual receiver is disabled', debug: null });
      }

      const body = req.body ?? {};
      const mode = body.activation?.mode ?? null;
      if (mode && mode !== 'activate_immediate') {
        return reply.code(501).send({
          code: 501,
          error: `activation mode ${mode} is not supported — only activate_immediate`,
          debug: null,
        });
      }

      const conn = state.connection(vrx.id);
      const staged: ConnectionState = {
        sender_id: body.sender_id !== undefined ? body.sender_id : conn.staged.sender_id,
        master_enable: body.master_enable !== undefined ? body.master_enable : conn.staged.master_enable,
        transport_file: {
          data: body.transport_file?.data !== undefined ? body.transport_file.data : conn.staged.transport_file.data,
          type: body.transport_file?.type !== undefined ? body.transport_file.type : conn.staged.transport_file.type,
        },
        transport_params: body.transport_params ?? conn.staged.transport_params,
      };
      conn.staged = staged;

      if (!mode) {
        await state.save();
        return shape(staged);
      }

      // Immediate: staged becomes active, then the federation chain runs.
      const activationTime = `${Math.floor(Date.now() / 1000)}:0`;
      conn.active = structuredClone(staged);
      conn.staged = emptyConnection();
      await state.save();

      try {
        if (staged.master_enable && staged.transport_file.data) {
          await engine.activate(vrx.id, conn.active);
        } else {
          await engine.deactivate(vrx.id);
        }
      } catch (e) {
        log.error({ receiver: vrx.id, err: String(e) }, 'activation failed');
        return reply.code(500).send({ code: 500, error: `federation failed: ${(e as Error).message}`, debug: null });
      }

      return shape(conn.active, { mode: 'activate_immediate', requested_time: null, activation_time: activationTime });
    },
  );

  app.get(`/x-nmos/connection/${CONN_VER}/bulk/`, async () => ['senders/', 'receivers/']);

  // Controls of an original device passed through to its copies (IS-12, IS-08).
  registerControlProxy(app, domain, engine);
}
