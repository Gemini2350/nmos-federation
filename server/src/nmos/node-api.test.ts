import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerNodeApi } from './node-api.js';
import { acceptEmptyJson } from '../api/http.js';
import { Engine } from '../federation/engine.js';
import { PoolManager } from '../federation/pools.js';
import { StateStore } from '../federation/state.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { DEFAULT_CONFIG, type AppConfig, type DomainConfig } from '../config/schema.js';

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

const domain = (id: string, kind: 'internal' | 'external', base: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: 'lo0', address: '127.0.0.1' },
  firstLeg: 'red',
  switchInterface: { red: '', blue: '' },
  pool: { base, pairs: 4, sourceNat: null },
  enabled: true,
});

/** A bridge with one device, one virtual receiver and an active channel — so every
 *  kind of href exists: node.href, the device's control href, a sender's manifest. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'nmos-hrefs-'));
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    domains: [domain('internal', 'internal', '239.201.0.0'), domain('partner', 'external', '239.200.0.0')],
    registries: [],
    bridges: [{ id: 'b1', label: 'Bridge', domains: ['internal', 'partner'], registries: [], nat: false, enabled: true }],
    devices: [{ id: 'd1', label: 'Cams', bridgeId: 'b1', receiverIds: ['rx1'] }],
    receivers: [{ id: 'rx1', label: 'CAM 1', deviceId: 'd1', format: 'video', enabled: true }],
    mirrors: [],
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
  engine.setDomainPort('internal', 8081);
  engine.setDomainPort('partner', 8081);
  await engine.activate('rx1', {
    sender_id: null,
    master_enable: true,
    transport_file: { data: SDP, type: 'application/sdp' },
    transport_params: [{}],
  });

  const app = (d: DomainConfig) => {
    const a = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
    acceptEmptyJson(a);
    registerNodeApi(a, d, engine, state);
    return a;
  };
  return {
    source: app(cfg.domains[0]!),
    target: app(cfg.domains[1]!),
    cleanup: async () => {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const pathOf = (href: string) => new URL(href).pathname;

test('node.href answers — it used to be a 404', async (t) => {
  const { source, cleanup } = await setup();
  t.after(cleanup);
  const self = (await source.inject({ url: '/x-nmos/node/v1.3/self' })).json() as { href: string };
  const res = await source.inject({ url: pathOf(self.href) });
  assert.equal(res.statusCode, 200, `${self.href} -> ${res.statusCode}`);
});

test("a device's control href answers, and so does what a controller builds from it", async (t) => {
  const { source, cleanup } = await setup();
  t.after(cleanup);
  const devices = (await source.inject({ url: '/x-nmos/node/v1.3/devices' })).json() as { controls: { href: string }[] }[];
  const href = devices[0]!.controls[0]!.href;
  assert.ok(href.endsWith('/'), `control href should end in a slash: ${href}`);
  assert.equal((await source.inject({ url: pathOf(href) })).statusCode, 200, `${href} itself`);
  // A controller appends to it. Without the slash this became ".../v1.1single/receivers".
  assert.equal((await source.inject({ url: pathOf(href + 'single/receivers/') })).statusCode, 200);
});

test("a virtual sender's manifest_href serves its SDP", async (t) => {
  const { target, cleanup } = await setup();
  t.after(cleanup);
  const senders = (await target.inject({ url: '/x-nmos/node/v1.3/senders' })).json() as { manifest_href: string }[];
  assert.equal(senders.length, 1);
  const res = await target.inject({ url: pathOf(senders[0]!.manifest_href) });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /application\/sdp/);
  assert.ok(res.body.startsWith('v=0'));
});

test('every base path answers with and without a trailing slash', async (t) => {
  const { source, cleanup } = await setup();
  t.after(cleanup);
  const bases = [
    '/x-nmos',
    '/x-nmos/node',
    '/x-nmos/node/v1.3',
    '/x-nmos/node/v1.3/devices',
    '/x-nmos/node/v1.3/receivers',
    '/x-nmos/connection',
    '/x-nmos/connection/v1.1',
    '/x-nmos/connection/v1.1/single',
    '/x-nmos/connection/v1.1/single/receivers',
    '/x-nmos/connection/v1.1/bulk',
  ];
  for (const b of bases) {
    for (const url of [b, `${b}/`]) {
      const res = await source.inject({ url });
      assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode}`);
    }
  }
});
