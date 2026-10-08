import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { DomainConfig } from '../config/schema.js';
import type { Engine } from '../federation/engine.js';
import { PASSTHROUGH, translateIds } from '../federation/passthrough.js';
import { log } from '../util/log.js';

/**
 * The proxy behind passed-through controls (see federation/passthrough.ts): IS-12 over
 * WebSocket, IS-08 over HTTP, each forwarded to the original device with ids swapped —
 * ours to the original's on the way in, the original's to ours on the way out.
 *
 * Mounted on a domain's node API, so it is reached on this software's address in that
 * domain; only a device whose copies appear in this domain answers here. The target is
 * always a control the original device advertised itself — never anything a client
 * names — so the proxy cannot be pointed elsewhere.
 */

const TIMEOUT_MS = 5000;

export function registerControlProxy(app: FastifyInstance, domain: DomainConfig, engine: Engine): void {
  const controlOf = (nmosDeviceId: string, kind: 'ncp' | 'cm') => {
    const pt = engine.passthroughByNmosId(nmosDeviceId, domain.id);
    const control = pt?.controls.find((c) => PASSTHROUGH[c.type]?.kind === kind);
    return pt && control ? { pt, href: control.href } : null;
  };

  // Encapsulated, so the WebSocket plugin is there whoever builds this app.
  app.register(async (scope) => {
    await scope.register(fastifyWebsocket);

    // ---- IS-12 (BCP-008 status) ---------------------------------------------
    scope.get<{ Params: { dev: string } }>('/x-nmos-proxy/:dev/ncp', { websocket: true }, (socket, req) => {
      const target = controlOf(req.params.dev, 'ncp');
      if (!target) {
        socket.close(1008, 'nothing passed through here');
        return;
      }
      const upstream = new WebSocket(target.href);
      const pending: string[] = [];
      // Looked up per message: copies added or removed while a controller stays
      // connected must translate correctly from then on.
      const maps = () => engine.passthroughByNmosId(req.params.dev, domain.id) ?? target.pt;

      upstream.onopen = () => {
        for (const m of pending.splice(0)) upstream.send(m);
      };
      upstream.onmessage = (ev) => socket.send(translateIds(String(ev.data), maps().toOurs));
      upstream.onerror = () => {
        log.warn({ device: req.params.dev, href: target.href }, 'IS-12 passthrough: original unreachable');
      };
      upstream.onclose = () => socket.close();
      socket.on('message', (data: Buffer) => {
        const msg = translateIds(data.toString(), maps().toOrigin);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push(msg);
      });
      socket.on('close', () => upstream.close());
    });

    // ---- IS-08 (channel mapping) --------------------------------------------
    const forward = async (req: FastifyRequest<{ Params: { dev: string; '*'?: string } }>, reply: FastifyReply) => {
      const target = controlOf(req.params.dev, 'cm');
      if (!target) return reply.code(404).send({ code: 404, error: 'nothing passed through here', debug: null });
      const { pt, href } = target;
      const rest = translateIds(req.params['*'] ?? '', pt.toOrigin);
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const url = `${href.replace(/\/*$/, '/')}${rest}${query}`;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined && req.body !== null;
      const body = hasBody ? translateIds(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), pt.toOrigin) : undefined;
      let res: Response;
      try {
        res = await fetch(url, {
          method: req.method,
          headers: body !== undefined ? { 'content-type': String(req.headers['content-type'] ?? 'application/json') } : {},
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        return reply.code(502).send({ code: 502, error: `original device unreachable: ${(e as Error).message}`, debug: null });
      }
      const text = await res.text();
      reply.code(res.status).type(res.headers.get('content-type') ?? 'application/json');
      return reply.send(translateIds(text, pt.toOurs));
    };
    scope.all('/x-nmos-proxy/:dev/cm', forward);
    scope.all('/x-nmos-proxy/:dev/cm/*', forward);
  });
}
