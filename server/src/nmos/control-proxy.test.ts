import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { acceptEmptyJson } from '../api/http.js';
import { registerNodeApi } from './node-api.js';
import { Engine } from '../federation/engine.js';
import { StateStore } from '../federation/state.js';
import { PoolManager } from '../federation/pools.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { DEFAULT_CONFIG, type AppConfig } from '../config/schema.js';

const ORIG_DEV = '0a0a0a0a-0000-4000-8000-00000000dddd';
const ORIG_RX = '0a0a0a0a-0000-4000-8000-0000000000a1';
const ORIG_TX = '0a0a0a0a-0000-4000-8000-0000000000b1';
const ORIG_SRC = '0a0a0a0a-0000-4000-8000-0000000000c1';

/** An original device: IS-12 over WebSocket, IS-08 over HTTP, recording what arrives. */
async function startOriginal() {
  const seen = { ncp: [] as string[], cm: [] as string[] };
  const app = Fastify();
  await app.register(fastifyWebsocket);
  app.get('/x-nmos/ncp/v1.0/connect', { websocket: true }, (socket) => {
    socket.on('message', (data: Buffer) => {
      seen.ncp.push(data.toString());
      // A BCP-008 receiver monitor answering with its touchpoint.
      socket.send(JSON.stringify({ messageType: 1, responses: [{ handle: 1, result: { status: 200, value: [{ contextNamespace: 'x-nmos', resource: { resourceType: 'receiver', id: ORIG_RX } }] } }] }));
    });
  });
  app.get('/x-nmos/channelmapping/v1.0/io', async () => ({
    inputs: { in1: { parent: { id: ORIG_RX, type: 'receiver' } } },
    outputs: { out1: { source_id: ORIG_SRC } },
  }));
  app.post('/x-nmos/channelmapping/v1.0/map/activations', async (req) => {
    seen.cm.push(JSON.stringify(req.body));
    return req.body;
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  return { app, port, seen };
}

test('an original device\'s IS-12 and IS-08 pass through to its copies, ids swapped both ways', async (t) => {
  const original = await startOriginal();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-proxy-'));
  const base = `127.0.0.1:${original.port}`;
  const controls = [
    { type: 'urn:x-nmos:control:ncp/v1.0', href: `ws://${base}/x-nmos/ncp/v1.0/connect` },
    { type: 'urn:x-nmos:control:cm-ctrl/v1.0', href: `http://${base}/x-nmos/channelmapping/v1.0` },
  ];
  const origin = { originDeviceId: ORIG_DEV, originDeviceLabel: 'Original', originControls: controls, originGroupHint: null };
  const domain = (id: string, kind: 'internal' | 'external', base: string) => ({
    ...structuredClone(DEFAULT_CONFIG.domains[0]!),
    id,
    label: id,
    kind,
    iface: { name: 'lo', address: '127.0.0.1' },
    pool: { base, pairs: 8, sourceNat: null },
  });
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    domains: [domain('internal', 'internal', '239.201.0.0'), domain('partner', 'external', '239.202.0.0')],
    registries: [{ id: 'reg', label: 'Partner', domainId: 'partner', mode: 'manual', ip: '127.0.0.1', port: 9, version: 'v1.3', enabled: false }],
    bridges: [{ id: 'b1', label: 'Bridge', domains: ['internal', 'partner'], registries: [], nat: false, enabled: true }],
    devices: [{ id: 'dev1', label: 'Copies', bridgeId: 'b1', receiverIds: ['proxy'] }],
    receivers: [
      { id: 'proxy', label: 'Proxy RX', deviceId: 'dev1', format: 'video', enabled: true, side: 'internal',
        proxyFor: { registryId: 'reg', receiverId: ORIG_RX, deviceId: ORIG_DEV, mirrorId: 'm-rx' } },
    ],
    mirrors: [
      { id: 'm-rx', kind: 'receiver', deviceId: 'dev1', registryId: 'reg', originId: ORIG_RX, originLabel: 'RX', enabled: true, ...origin },
      { id: 'm-tx', kind: 'sender', deviceId: 'dev1', registryId: 'reg', originId: ORIG_TX, originLabel: 'TX', enabled: true, originSourceId: ORIG_SRC, ...origin },
    ],
  };
  const state = new StateStore(dir);
  await state.load();
  const sw = { host: '', user: '', password: '', tls: true, join: 'igmpStatic' as const };
  const engine = new Engine({
    config: () => cfg,
    state,
    pools: new PoolManager(cfg.domains, cfg.nat.groupIdRange),
    drivers: { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) },
  });
  const nodeApi = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
  acceptEmptyJson(nodeApi);
  registerNodeApi(nodeApi, cfg.domains[0]!, engine, state);
  await nodeApi.listen({ port: 0, host: '127.0.0.1' });
  const port = (nodeApi.server.address() as { port: number }).port;
  engine.setDomainPort('internal', port);
  t.after(async () => {
    await nodeApi.close();
    await original.app.close();
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const ourRx = engine.receiverNmosId('proxy');
  const ourTx = engine.senderNmosId('mirror-m-tx');
  const ourSrc = engine.sourceNmosId('mirror-m-tx');
  const devId = engine.deviceId('dev1');

  // The device advertises the proxied controls where its copies appear — and only there.
  const internalDevice = engine.domainResources('internal').devices[0]!;
  assert.deepEqual(
    internalDevice.controls.map((c) => c.href),
    [`http://127.0.0.1:${port}/x-nmos/connection/v1.1/`, `ws://127.0.0.1:${port}/x-nmos-proxy/${devId}/ncp`, `http://127.0.0.1:${port}/x-nmos-proxy/${devId}/cm/`],
  );
  assert.equal(engine.domainResources('partner').devices[0]!.controls.length, 1, 'not on the original\'s side');

  // IS-12: a request naming our receiver reaches the original with its own id; the
  // touchpoint coming back names our receiver.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/x-nmos-proxy/${devId}/ncp`);
  const reply = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ messageType: 0, commands: [{ handle: 1, oid: 3, methodId: { level: 1, index: 1 }, arguments: { id: { level: 1, index: 7 }, about: ourRx } }] }));
    ws.onmessage = (ev) => resolve(String(ev.data));
    ws.onerror = () => reject(new Error('proxy socket failed'));
    setTimeout(() => reject(new Error('no reply in 3 s')), 3000);
  });
  ws.close();
  assert.ok(original.seen.ncp[0]!.includes(ORIG_RX) && !original.seen.ncp[0]!.includes(ourRx), 'our id became the original\'s');
  assert.ok(reply.includes(ourRx) && !reply.includes(ORIG_RX), 'the touchpoint names our receiver');

  // IS-08: inputs and outputs refer to our receiver and our source.
  const io = (await (await fetch(`http://127.0.0.1:${port}/x-nmos-proxy/${devId}/cm/io`)).json()) as {
    inputs: { in1: { parent: { id: string } } };
    outputs: { out1: { source_id: string } };
  };
  assert.equal(io.inputs.in1.parent.id, ourRx);
  assert.equal(io.outputs.out1.source_id, ourSrc);
  // …and a request naming ours arrives with the original's.
  const act = await fetch(`http://127.0.0.1:${port}/x-nmos-proxy/${devId}/cm/map/activations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: ourSrc, other: ourTx }),
  });
  assert.equal(act.status, 200);
  assert.ok(original.seen.cm[0]!.includes(ORIG_SRC) && original.seen.cm[0]!.includes(ORIG_TX));
  assert.ok((await act.text()).includes(ourSrc), 'and the echo comes back as ours');

  // A free virtual receiver on the device: its status is not the original's to report.
  cfg.receivers.push({ id: 'free', label: 'Free', deviceId: 'dev1', format: 'video', enabled: true, side: 'internal' });
  cfg.devices[0]!.receiverIds.push('free');
  assert.equal(engine.domainResources('internal').devices[0]!.controls.length, 1, 'no passthrough for a mixed device');
  assert.equal((await fetch(`http://127.0.0.1:${port}/x-nmos-proxy/${devId}/cm/io`)).status, 404);
});
