import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { registerNodeApi } from './node-api.js';
import { registerRestApi } from '../api/rest.js';
import { acceptEmptyJson } from '../api/http.js';
import { ConfigStore } from '../config/store.js';
import { Engine } from '../federation/engine.js';
import { PoolManager } from '../federation/pools.js';
import { StateStore } from '../federation/state.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { ANNOTATION_SERVICE, GROUPHINT_TAG, mergeTags, validatePatch } from './annotation.js';
import type { Annotator } from './annotation-api.js';

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.1.1.50',
  's=CAM01',
  't=0 0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.1.5/64',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709;',
  '',
].join('\r\n');

type Res = { id: string; version: string; label: string; description: string; tags: Record<string, string[]> };

/**
 * A bridge with one device and two virtual receivers, one of them connected — so the
 * partner side carries a sender whose name is derived. The node APIs reach the REST
 * write queue exactly as in index.ts.
 */
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'nmos-is13-'));
  const store = new ConfigStore(dir);
  await store.load();
  const cfg = structuredClone(store.current);
  cfg.domains[0]!.iface = { name: 'lo0', address: '127.0.0.1' };
  cfg.domains.push({ ...structuredClone(cfg.domains[0]!), id: '2', label: 'Partner', kind: 'external' });
  cfg.domains[1]!.pool.base = '239.202.0.0';
  cfg.registries = [];
  cfg.bridges = [{ id: 'b1', label: 'Bridge', domains: [cfg.domains[0]!.id, '2'], registries: [], nat: false, enabled: true }];
  cfg.devices = [{ id: 'd1', label: 'Cams', bridgeId: 'b1', receiverIds: ['rx1', 'rx2'] }];
  cfg.receivers = [
    { id: 'rx1', label: 'CAM 1', deviceId: 'd1', format: 'video', enabled: true },
    { id: 'rx2', label: 'CAM 2', deviceId: 'd1', format: 'video', enabled: true },
  ];
  await store.save(cfg);
  const state = new StateStore(dir);
  await state.load();
  const sw = { host: '', user: '', password: '', tls: true, join: 'igmpStatic' as const };
  const engine = new Engine({
    config: () => store.current,
    state,
    pools: new PoolManager(store.current.domains, store.current.nat.groupIdRange),
    drivers: { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) },
  });
  for (const d of store.current.domains) engine.setDomainPort(d.id, 8081);
  await engine.activate('rx1', { sender_id: null, master_enable: true, transport_file: { data: SDP, type: 'application/sdp' }, transport_params: [{}] });

  const rest = Fastify();
  acceptEmptyJson(rest);
  await rest.register(fastifyWebsocket);
  registerRestApi(rest, store, engine, state, async () => undefined);
  const annotate: Annotator = async (kind, id, patch) => {
    const res = await rest.inject({ method: 'PATCH', url: `/api/annotations/${kind}/${id}`, payload: patch });
    return { status: res.statusCode, body: res.json() };
  };
  const nodeApi = (domainId: string) => {
    const a = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
    acceptEmptyJson(a);
    registerNodeApi(a, store.current.domains.find((d) => d.id === domainId)!, engine, state, annotate);
    return a;
  };
  const home = nodeApi(store.current.domains[0]!.id);
  const partner = nodeApi('2');
  t.after(async () => {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const self = (await home.inject({ url: '/x-nmos/node/v1.3/self' })).json() as Res & { services: { href: string; type: string }[] };
  const service = self.services.find((s) => s.type === ANNOTATION_SERVICE)!;
  const base = new URL(service.href).pathname;
  const deviceId = engine.deviceId('d1');
  return { store, engine, home, partner, self, service, base, deviceId, rest };
}

test('the node advertises its own Annotation API, and its base answers', async (t) => {
  const { self, service, base, home } = await setup(t);
  assert.ok(service, 'no annotation service in node.services');
  assert.ok(service.href.endsWith('/'));
  assert.ok(base.includes(self.id), 'the base names the node — several bridges share one node API');
  assert.deepEqual((await home.inject({ url: base })).json(), ['node/']);
  assert.deepEqual((await home.inject({ url: `${base}node/` })).json(), ['self/', 'devices/', 'sources/', 'flows/', 'senders/', 'receivers/']);
  assert.deepEqual((await home.inject({ url: `${base}node/sources` })).json(), []);
  const ann = (await home.inject({ url: `${base}node/self` })).json() as Res;
  assert.deepEqual(Object.keys(ann).sort(), ['description', 'id', 'label', 'tags', 'version']);
  assert.equal(ann.id, self.id);
});

test('renaming the node from a controller reaches IS-04, the GUI and resets with null', async (t) => {
  const { home, partner, base, self, store } = await setup(t);
  const res = await home.inject({ method: 'PATCH', url: `${base}node/self`, payload: { label: 'Studio Gateway', description: 'to the studios' } });
  assert.equal(res.statusCode, 200, res.body);
  const after = res.json() as Res;
  assert.equal(after.label, 'Studio Gateway');
  assert.equal(after.description, 'to the studios');
  assert.notEqual(after.version, self.version, 'IS-13: a PATCH increments the version');
  assert.equal(store.current.bridges[0]!.label, 'Studio Gateway', 'stored where the GUI edits it');
  // The same node in the other domain carries the same name.
  assert.equal(((await partner.inject({ url: '/x-nmos/node/v1.3/self' })).json() as Res).label, 'Studio Gateway');

  const reset = (await home.inject({ method: 'PATCH', url: `${base}node/self`, payload: { label: null, description: null } })).json() as Res;
  assert.equal(reset.label, 'NMOS Federation');
  assert.equal(reset.description, 'NMOS Federation', 'the description follows the label again');
});

test('a device takes a name, a description and user tags; tags merge per name', async (t) => {
  const { home, base, deviceId, store } = await setup(t);
  const url = `${base}node/devices/${deviceId}`;
  assert.deepEqual((await home.inject({ url: `${base}node/devices` })).json(), [`${deviceId}/`]);
  let res = await home.inject({ method: 'PATCH', url, payload: { label: 'Cameras', tags: { 'urn:x-nmos:tag:user:studio': ['HQ2'] } } });
  assert.equal(res.statusCode, 200, res.body);
  res = await home.inject({ method: 'PATCH', url, payload: { tags: { 'urn:x-nmos:tag:user:floor': ['3'] } } });
  assert.deepEqual((res.json() as Res).tags, { 'urn:x-nmos:tag:user:studio': ['HQ2'], 'urn:x-nmos:tag:user:floor': ['3'] });
  const dev = ((await home.inject({ url: `/x-nmos/node/v1.3/devices/${deviceId}` })).json() as Res);
  assert.equal(dev.label, 'Cameras');
  assert.deepEqual(dev.tags['urn:x-nmos:tag:user:floor'], ['3']);

  res = await home.inject({ method: 'PATCH', url, payload: { label: null, tags: { 'urn:x-nmos:tag:user:studio': null } } });
  assert.equal((res.json() as Res).label, 'Device');
  assert.deepEqual((res.json() as Res).tags, { 'urn:x-nmos:tag:user:floor': ['3'] });
  await home.inject({ method: 'PATCH', url, payload: { tags: null } });
  assert.equal(store.current.devices[0]!.tags, undefined);
});

test('a group hint sets the natural group and role; our own tags stay read-only', async (t) => {
  const { home, base, engine, store } = await setup(t);
  const url = `${base}node/receivers/${engine.receiverNmosId('rx2')}`;
  const res = await home.inject({ method: 'PATCH', url, payload: { tags: { [GROUPHINT_TAG]: ['Cam 2:Video'] } } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual((res.json() as Res).tags[GROUPHINT_TAG], ['Cam 2:Video']);
  const rx = store.current.receivers.find((r) => r.id === 'rx2')!;
  assert.equal(rx.group, 'Cam 2');
  assert.equal(rx.role, 'Video');
  assert.equal(rx.tags, undefined, 'the group hint is not kept as a user tag');

  const alias = await home.inject({ method: 'PATCH', url, payload: { tags: { 'urn:x-nmos-federation:alias-of': ['x'] } } });
  assert.equal(alias.statusCode, 500);
  const two = await home.inject({ method: 'PATCH', url, payload: { tags: { [GROUPHINT_TAG]: ['a:b', 'c:d'] } } });
  assert.equal(two.statusCode, 500);
});

test('a sender named after its receiver is refused with the reason', async (t) => {
  const { partner, engine, store } = await setup(t);
  const self = (await partner.inject({ url: '/x-nmos/node/v1.3/self' })).json() as { services: { href: string }[] };
  const base = new URL(self.services[0]!.href).pathname;
  const senderId = engine.senderNmosId('rx1');
  assert.deepEqual((await partner.inject({ url: `${base}node/senders` })).json(), [`${senderId}/`]);
  const res = await partner.inject({ method: 'PATCH', url: `${base}node/senders/${senderId}`, payload: { label: 'X' } });
  assert.equal(res.statusCode, 500);
  assert.match((res.json() as { error: string }).error, /CAM 1/);
  assert.equal(store.current.receivers[0]!.label, 'CAM 1');
});

test('bad bodies are 400, unknown resources 404, and CORS is answered', async (t) => {
  const { home, base } = await setup(t);
  assert.equal((await home.inject({ method: 'PATCH', url: `${base}node/self`, payload: { label: 3 } })).statusCode, 400);
  assert.equal((await home.inject({ method: 'PATCH', url: `${base}node/self`, payload: { format: 'x' } })).statusCode, 400);
  assert.equal((await home.inject({ method: 'PATCH', url: `${base}node/self`, payload: { label: '  ' } })).statusCode, 500);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await home.inject({ method: 'PATCH', url: `${base}node/devices/${unknown}`, payload: { label: 'x' } })).statusCode, 404);
  assert.equal((await home.inject({ url: `/x-nmos-bridge/${unknown}/x-nmos/annotation/v1.0/node/self` })).statusCode, 404);
  const pre = await home.inject({ method: 'OPTIONS', url: `${base}node/self`, headers: { origin: 'http://x', 'access-control-request-method': 'PATCH' } });
  assert.equal(pre.statusCode, 200);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
});

test('null gives a proxy back its proxy name and a sender copy its original name', async (t) => {
  const { store, engine, rest } = await setup(t);
  const cfg = structuredClone(store.current);
  cfg.mirrors = [
    { id: 'm-rx', kind: 'receiver', deviceId: 'd1', registryId: 'x', originId: 'o1', originDeviceId: 'od', originLabel: 'MON03', label: 'Wall', enabled: true },
    { id: 'm-tx', kind: 'sender', deviceId: 'd1', registryId: 'x', originId: 'o2', originDeviceId: 'od', originLabel: 'CAM07', label: 'Truck cam', enabled: true },
  ];
  cfg.receivers.push({ id: 'px', label: 'Wall', deviceId: 'd1', format: 'video', enabled: true, proxyFor: { registryId: 'x', receiverId: 'o1', deviceId: 'od', mirrorId: 'm-rx' } });
  cfg.devices[0]!.receiverIds.push('px');
  await store.save(cfg);
  const patch = (kind: string, id: string, payload: object) => rest.inject({ method: 'PATCH', url: `/api/annotations/${kind}/${id}`, payload });

  let res = await patch('receiver', engine.receiverNmosId('px'), { label: 'Big wall' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.current.mirrors.find((m) => m.id === 'm-rx')!.label, 'Big wall', 'the copy entry follows, as with the GUI');
  res = await patch('receiver', engine.receiverNmosId('px'), { label: null });
  assert.equal(store.current.receivers.find((r) => r.id === 'px')!.label, 'Proxy MON03');

  res = await patch('sender', engine.senderNmosId('mirror-m-tx'), { label: null });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.current.mirrors.find((m) => m.id === 'm-tx')!.label, undefined, 'falls back to the original name');
});

test('the patch helpers follow the IS-13 schema', () => {
  assert.ok('patch' in validatePatch({ label: null, description: '', tags: { a: null, b: ['x'] } }));
  assert.ok('error' in validatePatch({ tags: { a: 'x' } }));
  assert.ok('error' in validatePatch([]));
  assert.deepEqual(mergeTags({ a: ['1'] }, { b: ['2'] }), { a: ['1'], b: ['2'] });
  assert.equal(mergeTags({ a: ['1'] }, { a: null }), undefined);
  assert.equal(mergeTags({ a: ['1'] }, null), undefined);
  assert.deepEqual(mergeTags({ a: ['1'] }, undefined), { a: ['1'] });
});
