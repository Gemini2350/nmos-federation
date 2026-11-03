import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { acceptEmptyJson } from '../api/http.js';
import { registerRestApi } from '../api/rest.js';
import { ConfigStore } from '../config/store.js';
import type { MirrorEntry } from '../config/schema.js';
import { MockSwitchDriver } from '../switch/mock.js';
import type { FederationDevice } from '../types.js';
import { planDeviceCopy, excludeFromFollow } from './device-copy.js';
import { Engine } from './engine.js';
import { PoolManager } from './pools.js';
import { StateStore } from './state.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORIGIN = uuid(1);
const NODE = uuid(2);
const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.1.1.50',
  's=CAM',
  't=0 0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.1.5/64',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709;',
  '',
].join('\r\n');
const CTRL = [{ href: 'http://127.0.0.1:1/x-nmos/connection/v1.1', type: 'urn:x-nmos:control:sr-ctrl/v1.1' }];

const followed = (extra: Partial<FederationDevice['follows']> = {}): FederationDevice => ({
  id: 'd1',
  label: 'SNP',
  bridgeId: 'b1',
  receiverIds: [],
  follows: { registryId: 'reg', originDeviceId: ORIGIN, originDeviceLabel: 'SNP', ...extra },
});
const copy = (over: Partial<MirrorEntry>): MirrorEntry => ({
  id: 'm',
  kind: 'sender',
  deviceId: 'd1',
  registryId: 'reg',
  originId: 's1',
  originDeviceId: ORIGIN,
  originLabel: 'TX 1',
  enabled: true,
  ...over,
});
const registry = {
  devices: [{ id: ORIGIN, label: 'SNP', node_id: NODE, controls: CTRL }],
  senders: [
    { id: 's1', label: 'TX 1', device_id: ORIGIN, manifest_href: 'http://x/1' },
    { id: 's2', label: 'TX 2', device_id: ORIGIN, manifest_href: 'http://x/2' },
    { id: 'other', label: 'TX 9', device_id: uuid(9), manifest_href: 'http://x/9' },
  ],
  receivers: [{ id: 'r1', label: 'RX 1', device_id: ORIGIN, format: 'urn:x-nmos:format:audio' }],
};

const added = (plan: ReturnType<typeof planDeviceCopy>) => (plan.status === 'ok' ? plan.add.map((a) => a.id) : plan.reason);

test('a plan lists what has no copy yet, on this device only', () => {
  const device = followed();
  const plan = planDeviceCopy(device, { devices: [device], mirrors: [copy({})] }, registry);
  assert.deepEqual(added(plan), ['s2', 'r1']);
  assert.equal(plan.status === 'ok' && plan.add[1]!.format, 'audio');
});

test('what cannot be copied is reported with the reason, not copied', () => {
  const device = followed();
  const plan = planDeviceCopy(device, { devices: [device], mirrors: [] }, {
    devices: [{ id: ORIGIN, label: 'SNP', controls: [] }],
    senders: [
      { id: 'x', label: 'MXL', device_id: ORIGIN, transport: 'urn:x-nmos:transport:mxl', manifest_href: 'http://x' },
      { id: 'y', label: 'No SDP', device_id: ORIGIN, manifest_href: null },
    ],
    receivers: [{ id: 'r', label: 'No IS-05', device_id: ORIGIN }],
  });
  assert.equal(plan.status, 'ok');
  if (plan.status !== 'ok') return;
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.skipped.map((s) => s.label), ['MXL', 'No SDP', 'No IS-05']);
});

test('a copy removed by hand stays removed, also under a new id', () => {
  const device = followed();
  const cfg = { devices: [device], mirrors: [copy({})] };
  excludeFromFollow(cfg, cfg.mirrors[0]!);
  cfg.mirrors = [];
  assert.deepEqual(added(planDeviceCopy(device, cfg, registry)), ['s2', 'r1']);
  const renumbered = { ...registry, senders: [{ id: 's1-new', label: 'TX 1', device_id: ORIGIN, manifest_href: 'http://x/1' }] };
  assert.deepEqual(added(planDeviceCopy(device, cfg, renumbered)), ['r1']);
});

test('clearing away a copy whose original is gone does not refuse a later one', () => {
  const device = followed();
  const cfg = { devices: [device], mirrors: [copy({ originMissing: { since: 'x', reason: 'gone' } })] };
  excludeFromFollow(cfg, cfg.mirrors[0]!);
  assert.equal(device.follows!.excluded, undefined);
});

test('a copy waiting for its original gets no duplicate when the name was ambiguous', () => {
  const device = followed();
  const cfg = { devices: [device], mirrors: [copy({ originId: 'old', originMissing: { since: 'x', reason: 'ambiguous' } })] };
  assert.deepEqual(added(planDeviceCopy(device, cfg, registry)), ['s2', 'r1']);
});

test('a device with new ids is found by its name; two of that name are left alone', () => {
  const device = followed({ originDeviceId: uuid(5) });
  const plan = planDeviceCopy(device, { devices: [device], mirrors: [] }, registry);
  assert.equal(plan.status === 'ok' && plan.originDeviceId, ORIGIN);
  const two = { ...registry, devices: [...registry.devices, { id: uuid(6), label: 'SNP' }] };
  assert.equal(planDeviceCopy(device, { devices: [device], mirrors: [] }, two).status, 'offline');
});

test('copied elsewhere already: said so, not copied twice', () => {
  const device = followed();
  const elsewhere: FederationDevice = { id: 'd2', label: 'Earlier', bridgeId: 'b1', receiverIds: [] };
  const plan = planDeviceCopy(device, { devices: [device, elsewhere], mirrors: [copy({ deviceId: 'd2' })] }, registry);
  assert.equal(plan.status, 'ok');
  if (plan.status !== 'ok') return;
  assert.deepEqual(plan.add.map((a) => a.id), ['s2', 'r1']);
  assert.match(plan.skipped[0]!.reason, /Earlier/);
});

// ---- Through the REST API, against a registry ------------------------------

interface Registry {
  senders: { id: string; label: string; device_id: string; flow_id: null; version: string; manifest_href: string; transport: string; subscription: { active: boolean } }[];
  receivers: { id: string; label: string; device_id: string; format: string; transport: string; caps: object }[];
  deviceLabel: string;
  node: string;
}

async function startRegistry(): Promise<Registry & { ip: string; port: number; close: () => void; addSender: (id: string, label: string) => void }> {
  const reg: Registry = { senders: [], receivers: [], deviceLabel: 'SNP', node: NODE };
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/manifest.sdp') {
      res.writeHead(200, { 'content-type': 'application/sdp' });
      return res.end(SDP);
    }
    if (req.method === 'POST' && url.endsWith('/subscriptions')) {
      req.resume();
      return json(501, { code: 501 });
    }
    if (req.method === 'GET' && url.includes('/x-nmos/query/')) {
      const tail = (url.split('/x-nmos/query/v1.3/')[1] ?? '').split('?')[0]!;
      const device = { id: ORIGIN, label: reg.deviceLabel, node_id: reg.node, controls: CTRL };
      if (tail === 'senders') return json(200, reg.senders);
      if (tail === 'receivers') return json(200, reg.receivers);
      if (tail === 'devices') return json(200, [device]);
      if (tail === `devices/${ORIGIN}`) return json(200, device);
      const [kind, id] = tail.split('/');
      const one = kind === 'senders' ? reg.senders.find((s) => s.id === id) : kind === 'receivers' ? reg.receivers.find((r) => r.id === id) : undefined;
      if (one) return json(200, one);
      return tail.includes('/') ? json(404, { code: 404 }) : json(200, []);
    }
    if (req.method === 'POST' && url.includes('/health/nodes/')) return json(200, { health: '1' });
    if (req.method === 'POST' && url.endsWith('/resource')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => json(201, (JSON.parse(body) as { data: unknown }).data));
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(reg, {
    ip: '127.0.0.1',
    port,
    close: () => server.close(),
    addSender: (id: string, label: string) => {
      reg.senders.push({
        id,
        label,
        device_id: ORIGIN,
        flow_id: null,
        version: '100:0',
        manifest_href: `http://127.0.0.1:${port}/manifest.sdp`,
        transport: 'urn:x-nmos:transport:rtp.mcast',
        subscription: { active: true },
      });
    },
  });
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const origin = await startRegistry();
  const partner = await startRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-devcopy-'));
  const store = new ConfigStore(dir);
  await store.load();
  const cfg = structuredClone(store.current);
  const home = cfg.domains[0]!;
  home.iface = { name: 'lo0', address: '127.0.0.1' };
  cfg.domains.push({ ...structuredClone(home), id: 'p', label: 'Partner', kind: 'external' });
  cfg.domains[1]!.pool.base = '239.202.0.0';
  cfg.registries = [
    { id: 'reg', label: 'Origin', domainId: home.id, mode: 'manual', ip: origin.ip, port: origin.port, version: 'v1.3', enabled: true },
    { id: 'part', label: 'Partner', domainId: 'p', mode: 'manual', ip: partner.ip, port: partner.port, version: 'v1.3', enabled: true },
  ];
  cfg.bridges = [{ id: 'b1', label: 'Bridge', domains: [home.id, 'p'], registries: [], nat: false, enabled: true }];
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
  await engine.start();
  const app = Fastify();
  acceptEmptyJson(app);
  await app.register(fastifyWebsocket);
  registerRestApi(app, store, engine, state, async () => undefined);
  t.after(async () => {
    await app.close();
    await engine.stop();
    origin.close();
    partner.close();
    await rm(dir, { recursive: true, force: true });
  });
  const copyDevice = () => app.inject({ method: 'POST', url: '/api/devices/copy', payload: { bridgeId: 'b1', registryId: 'reg', originDeviceId: ORIGIN } });
  const rebind = () => app.inject({ method: 'POST', url: '/api/mirrors/rebind', payload: {} });
  return { origin, store, engine, app, copyDevice, rebind };
}

test('copying a device copies all of it, and what it gains later follows', async (t) => {
  const { origin, store, engine, app, copyDevice, rebind } = await setup(t);
  origin.addSender(uuid(11), 'TX 1');
  origin.receivers.push({ id: uuid(21), label: 'RX 1', device_id: ORIGIN, format: 'urn:x-nmos:format:video', transport: 'urn:x-nmos:transport:rtp.mcast', caps: {} });

  const res = await copyDevice();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { device: FederationDevice; senders: number; receivers: number; failed: unknown[] };
  assert.equal(body.senders, 1);
  assert.equal(body.receivers, 1);
  assert.deepEqual(body.failed, []);
  const device = store.current.devices.find((d) => d.id === body.device.id)!;
  assert.equal(device.label, 'SNP', 'named after the original');
  assert.equal(store.current.mirrors.length, 2);
  assert.equal((await copyDevice()).statusCode, 409, 'not a second time');

  // The original gains a sender: the next pass copies it, and starts its channel.
  origin.addSender(uuid(12), 'TX 2');
  const pass = (await rebind()).json() as { followed: string[] };
  assert.equal(pass.followed.length, 1);
  const fresh = store.current.mirrors.find((m) => m.originId === uuid(12))!;
  assert.equal(fresh.deviceId, device.id);
  assert.ok(engine.channels().some((c) => c.receiverId === `mirror-${fresh.id}` && c.state === 'active'));
  assert.equal(((await rebind()).json() as { followed?: string[] }).followed, undefined, 'nothing new the second time');

  // A copy removed by hand does not come back.
  await app.inject({ method: 'DELETE', url: `/api/mirrors/${fresh.id}` });
  await rebind();
  assert.ok(!store.current.mirrors.some((m) => m.originId === uuid(12)));

  // Stopped: new ports stay where they are, the copies stay too.
  await app.inject({ method: 'DELETE', url: `/api/devices/${device.id}/follow` });
  origin.addSender(uuid(13), 'TX 3');
  await rebind();
  assert.ok(!store.current.mirrors.some((m) => m.originId === uuid(13)));
  assert.equal(store.current.mirrors.length, 2);
});

test('a device already partly copied is taken over, not copied again', async (t) => {
  const { origin, store, app, copyDevice } = await setup(t);
  origin.addSender(uuid(11), 'TX 1');
  origin.addSender(uuid(12), 'TX 2');
  const made = (await app.inject({ method: 'POST', url: '/api/devices', payload: { bridgeId: 'b1', label: 'Mine' } })).json() as FederationDevice;
  const one = await app.inject({
    method: 'POST',
    url: '/api/mirrors',
    payload: { kind: 'sender', deviceId: made.id, registryId: 'reg', originId: uuid(11), originDeviceId: ORIGIN, originLabel: 'TX 1' },
  });
  assert.equal(one.statusCode, 200, one.body);

  const res = (await copyDevice()).json() as { device: FederationDevice; senders: number };
  assert.equal(res.device.id, made.id);
  assert.equal(res.senders, 1, 'only what was missing');
  assert.equal(store.current.devices.find((d) => d.id === made.id)!.label, 'Mine', 'its name stays');
  assert.equal(store.current.mirrors.filter((m) => m.deviceId === made.id).length, 2);
});

test('a name follows the original unless it was given by hand', async (t) => {
  const { origin, store, app, copyDevice, rebind } = await setup(t);
  origin.addSender(uuid(11), 'TX 1');
  const { device } = (await copyDevice()).json() as { device: FederationDevice };
  origin.deviceLabel = 'SNP Rack 2';
  await rebind();
  assert.equal(store.current.devices.find((d) => d.id === device.id)!.label, 'SNP Rack 2');

  await app.inject({ method: 'PUT', url: `/api/devices/${device.id}`, payload: { label: 'Mine' } });
  origin.deviceLabel = 'SNP Rack 3';
  await rebind();
  const after = store.current.devices.find((d) => d.id === device.id)!;
  assert.equal(after.label, 'Mine');
  assert.equal(after.follows!.originDeviceLabel, 'SNP Rack 3');
});

test('one of our own devices cannot be copied, nor a device the registry does not hold', async (t) => {
  const { origin, engine, copyDevice, app } = await setup(t);
  assert.equal((await copyDevice()).statusCode, 200, 'an empty device can be followed');
  await app.inject({ method: 'DELETE', url: `/api/devices/${(await app.inject({ url: '/api/devices' })).json<FederationDevice[]>()[0]!.id}` });
  origin.node = engine.nodeId('b1');
  assert.equal((await copyDevice()).statusCode, 400);
  const res = await app.inject({ method: 'POST', url: '/api/devices/copy', payload: { bridgeId: 'b1', registryId: 'reg', originDeviceId: uuid(99) } });
  assert.equal(res.statusCode, 404);
});
