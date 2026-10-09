import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { acceptEmptyJson } from '../api/http.js';
import { registerNodeApi } from './node-api.js';
import { Engine } from '../federation/engine.js';
import { StateStore } from '../federation/state.js';
import { PoolManager } from '../federation/pools.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { DEFAULT_CONFIG, type AppConfig } from '../config/schema.js';

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.1.1.50',
  's=CAM',
  't=0 0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.1.5/64',
  'a=source-filter: incl IN IP4 239.10.1.5 10.1.1.50',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709;',
  '',
].join('\r\n');

/** One bridge, one virtual receiver, connected — the published sender is what is tested. */
async function setup(t: { after(fn: () => Promise<void>): void }, nat: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'nmos-tx-'));
  const sw = { host: '10.0.0.11', user: 'x', password: 'y', tls: true, join: 'igmpStatic' as const };
  const domain = (id: string, kind: 'internal' | 'external', base: string, vlan: [string, string]) => ({
    ...structuredClone(DEFAULT_CONFIG.domains[0]!),
    id,
    label: id,
    kind,
    iface: { name: 'lo', address: '127.0.0.1' },
    switchInterface: { red: vlan[0], blue: vlan[1] },
    pool: { base, pairs: 8, sourceNat: null },
  });
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    nat: { enabled: true, driver: 'mock', groupIdRange: [100, 199], switches: { red: sw, blue: sw } },
    domains: [domain('internal', 'internal', '239.201.0.0', ['Vlan101', 'Vlan102']), domain('partner', 'external', '239.200.0.0', ['Vlan901', 'Vlan902'])],
    registries: [],
    bridges: [{ id: 'b1', label: 'B', domains: ['internal', 'partner'], registries: [], nat, enabled: true }],
    devices: [{ id: 'd1', label: 'D', bridgeId: 'b1', receiverIds: ['rx'] }],
    receivers: [{ id: 'rx', label: 'RX', deviceId: 'd1', format: 'video', enabled: true, side: 'internal' }],
  };
  const state = new StateStore(dir);
  await state.load();
  const drivers = { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) };
  const engine = new Engine({ config: () => cfg, state, pools: new PoolManager(cfg.domains, cfg.nat.groupIdRange), drivers });
  await engine.activate('rx', { sender_id: 'orig', master_enable: true, transport_file: { data: SDP, type: 'application/sdp' }, transport_params: [{}] });
  const app = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
  acceptEmptyJson(app);
  registerNodeApi(app, cfg.domains[1]!, engine, state); // the sender appears at the partner
  t.after(async () => {
    await app.close();
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `/x-nmos/connection/v1.1/single/senders/${engine.senderNmosId('rx')}`;
  const patch = (body: unknown) => app.inject({ method: 'PATCH', url: `${base}/staged`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const active = async () => (await app.inject({ method: 'GET', url: `${base}/active` })).json() as { transport_params: { destination_ip: string; source_ip: string; destination_port: number }[] };
  return { engine, drivers, app, base, patch, active, state };
}

test('without NAT a copied sender shows the original multicast, and refuses to change it', async (t) => {
  const { patch, active, app, base } = await setup(t, false);
  // It used to be null, and controllers showed the copy without a multicast.
  assert.deepEqual((await active()).transport_params[0], { destination_ip: '239.10.1.5', source_ip: '10.1.1.50', destination_port: 5004, rtp_enabled: true });
  const constraints = (await app.inject({ method: 'GET', url: `${base}/constraints` })).json() as Record<string, { enum: unknown[] }>[];
  assert.deepEqual(constraints[0]!.destination_ip, { enum: ['239.10.1.5'] }, 'the constraints say it is fixed');

  const refused = await patch({ transport_params: [{ destination_ip: '239.50.0.10' }], activation: { mode: 'activate_immediate' } });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /NAT is off/);
  // Re-stating what is there, as some controllers do before routing, is fine.
  const noop = await patch({ master_enable: true, transport_params: [{ destination_ip: '239.10.1.5' }], activation: { mode: 'activate_immediate' } });
  assert.equal(noop.statusCode, 200);
});

test('with NAT the multicast of a sender can be changed over IS-05 — the NAT egress follows', async (t) => {
  const { patch, active, engine, drivers, state } = await setup(t, true);
  assert.equal((await active()).transport_params[0]!.destination_ip, '239.200.0.1', 'from the pool');

  const res = await patch({ transport_params: [{ destination_ip: '239.50.0.10' }], activation: { mode: 'activate_immediate' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await active()).transport_params[0]!.destination_ip, '239.50.0.10');
  const channel = state.channelFor('rx')!;
  assert.match(channel.senderSdp!, /c=IN IP4 239\.50\.0\.10\/64/, 'the SDP follows');
  const red = drivers.red.applied.get(`${channel.id}:red`)!;
  assert.ok(red.includes('ip nat destination static 239.10.1.5 239.50.0.10 group 100'), red.join('\n'));
  assert.ok(!red.some((c) => c.includes('239.200.0.1')), 'the old egress is gone');

  // What is refused, and why.
  assert.equal((await patch({ transport_params: [{ destination_ip: '10.0.0.1' }] })).statusCode, 400, 'not multicast');
  assert.match((await patch({ transport_params: [{ destination_ip: '239.200.0.4' }] })).json().error, /pool/, 'inside a pool');
  assert.match((await patch({ transport_params: [{ destination_port: 6000 }] })).json().error, /port/);
  assert.equal((await patch({ master_enable: false })).statusCode, 400);
  assert.equal(engine.channels()[0]!.allocation!.groups.red, '239.50.0.10', 'unchanged by the refused ones');
});
