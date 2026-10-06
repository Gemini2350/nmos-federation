import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Engine } from './engine.js';
import { PoolManager } from './pools.js';
import { StateStore } from './state.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { DEFAULT_CONFIG, type AppConfig, type DomainConfig } from '../config/schema.js';
import type { AristaConfig } from '../switch/arista-eapi.js';

const SDP = [
  'v=0',
  'o=- 99 99 IN IP4 10.1.1.70',
  's=CAM07 Video',
  't=0 0',
  'a=group:DUP PRIMARY SECONDARY',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.1.7/64',
  'a=source-filter: incl IN IP4 239.10.1.7 10.1.1.70',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=50; depth=10; TCS=SDR; colorimetry=BT709;',
  'a=mediaclk:direct=0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.2.7/64',
  'a=source-filter: incl IN IP4 239.10.2.7 10.1.2.70',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=50; depth=10; TCS=SDR; colorimetry=BT709;',
  'a=mediaclk:direct=0',
  '',
].join('\r\n');

const ORIGIN_SENDER = '11111111-1111-4111-8111-111111111111';
const ORIGIN_RECEIVER = '22222222-2222-4222-8222-222222222222';
const ORIGIN_DEVICE = '33333333-3333-4333-8333-333333333333';
const FOREIGN_NODE = '44444444-4444-4444-8444-444444444444';

/**
 * A stub registry that also answers the query API, serves a sender manifest and
 * accepts IS-05 patches on a receiver — enough to exercise both copy directions.
 */
interface Stub {
  server: Server;
  ip: string;
  port: number;
  posts: { type: string; id: string; data: Record<string, unknown> }[];
  deletes: string[];
  patches: { receiverId: string; body: Record<string, unknown> }[];
  manifestHits: number;
  manifestDown?: boolean;
}

async function startStub(): Promise<Stub> {
  const stub = { posts: [], deletes: [], patches: [], manifestHits: 0, manifestDown: false } as unknown as Stub;
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    if (req.method === 'GET' && url === '/manifest.sdp') {
      stub.manifestHits++;
      if (stub.manifestDown) {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/sdp' });
      return res.end(SDP);
    }
    if (req.method === 'GET' && url.includes('/x-nmos/query/')) {
      const tail = url.split('/x-nmos/query/v1.3/')[1] ?? '';
      const sender = {
        id: ORIGIN_SENDER,
        label: 'CAM07 Video',
        device_id: ORIGIN_DEVICE,
        flow_id: null,
        manifest_href: `${origin}/manifest.sdp`,
        transport: 'urn:x-nmos:transport:rtp.mcast',
      };
      const receiver = {
        id: ORIGIN_RECEIVER,
        label: 'MON03',
        device_id: ORIGIN_DEVICE,
        format: 'urn:x-nmos:format:video',
        transport: 'urn:x-nmos:transport:rtp.mcast',
        caps: { media_types: ['video/raw'] },
      };
      const device = {
        id: ORIGIN_DEVICE,
        label: 'Foreign device',
        node_id: FOREIGN_NODE,
        controls: [{ href: `${origin}/x-nmos/connection/v1.1`, type: 'urn:x-nmos:control:sr-ctrl/v1.1' }],
      };
      if (tail === 'senders') return json(200, [sender]);
      if (tail === `senders/${ORIGIN_SENDER}`) return json(200, sender);
      if (tail === 'receivers') return json(200, [receiver]);
      if (tail === `receivers/${ORIGIN_RECEIVER}`) return json(200, receiver);
      if (tail === 'devices') return json(200, [device]);
      if (tail === `devices/${ORIGIN_DEVICE}`) return json(200, device);
      if (tail === 'flows') return json(200, []);
      return json(200, []);
    }
    if (req.method === 'PATCH' && url.includes('/single/receivers/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const receiverId = url.split('/single/receivers/')[1]!.split('/')[0]!;
        stub.patches.push({ receiverId, body: JSON.parse(body) });
        json(200, JSON.parse(body));
      });
    }
    if (req.method === 'POST' && url.includes('/health/nodes/')) return json(200, { health: '1' });
    if (req.method === 'POST' && url.endsWith('/resource')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const parsed = JSON.parse(body) as { type: string; data: Record<string, unknown> };
        stub.posts.push({ type: parsed.type, id: String(parsed.data.id), data: parsed.data });
        json(201, parsed.data);
      });
    }
    if (req.method === 'DELETE') {
      stub.deletes.push(url);
      res.writeHead(204);
      return res.end();
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.server = server;
  stub.ip = '127.0.0.1';
  stub.port = (server.address() as { port: number }).port;
  return stub;
}

const domain = (id: string, kind: 'internal' | 'external', red: string, blue: string, base: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: kind === 'internal' ? 'eth0' : 'eth1', address: '127.0.0.1' },
  firstLeg: 'red',
  switchInterface: { red, blue },
  pool: {
    base,
    pairs: 8,
    sourceNat: kind === 'internal' ? { red: '10.1.1.200', blue: '10.1.2.200' } : { red: '10.9.1.200', blue: '10.9.2.200' },
  },
  enabled: true,
});

const sw = (): AristaConfig => ({ host: '10.0.0.11', user: 'x', password: 'y', tls: true, join: 'igmpStatic' });

async function build(internal: Stub, partner: Stub, dir: string, extra?: Partial<AppConfig>) {
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    nat: { enabled: true, driver: 'mock', groupIdRange: [100, 199], switches: { red: sw(), blue: sw() } },
    domains: [
      domain('internal', 'internal', 'Vlan101', 'Vlan102', '239.201.0.0'),
      domain('partnerA', 'external', 'Vlan901', 'Vlan902', '239.200.0.0'),
    ],
    registries: [
      { id: 'int', label: 'internal', domainId: 'internal', mode: 'manual', ip: internal.ip, port: internal.port, version: 'v1.3', enabled: true },
      { id: 'regA', label: 'Partner A', domainId: 'partnerA', mode: 'manual', ip: partner.ip, port: partner.port, version: 'v1.3', enabled: true },
    ],
    bridges: [
      {
        id: 'b1',
        label: 'NMOS Federation',
        sourceDomain: 'internal',
        targetDomain: 'partnerA',
        targetRegistries: ['regA'],
        nat: true,
        enabled: true,
      },
    ],
    devices: [{ id: 'dev1', label: 'Federation OUT', bridgeId: 'b1', receiverIds: [] }],
    receivers: [],
    mirrors: [],
    ...extra,
  };
  const state = new StateStore(dir);
  await state.load();
  const drivers = { red: new MockSwitchDriver('red', sw()), blue: new MockSwitchDriver('blue', sw()) };
  const pools = new PoolManager(cfg.domains, cfg.nat.groupIdRange);
  return { engine: new Engine({ config: () => cfg, state, pools, drivers }), cfg, state, drivers };
}

test('copying a sender reads its manifest, NATs it and publishes the copy', async (t) => {
  const internal = await startStub();
  const partner = await startStub();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-mirror-'));
  const mirrorId = randomUUID();
  const { engine, drivers } = await build(internal, partner, dir, {
    mirrors: [
      {
        id: mirrorId,
        kind: 'sender',
        deviceId: 'dev1',
        registryId: 'int',
        originId: ORIGIN_SENDER,
        originDeviceId: ORIGIN_DEVICE,
        originLabel: 'CAM07 Video',
        enabled: true,
      },
    ],
  });
  t.after(async () => {
    await engine.stop();
    internal.server.close();
    partner.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const channel = await engine.copySender(mirrorId);

  assert.equal(channel.state, 'active');
  assert.equal(channel.mirrorId, mirrorId);
  assert.equal(channel.originSenderId, ORIGIN_SENDER);
  // The origin SDP came from the manifest, so the legs are the original addresses.
  assert.deepEqual(channel.legs.map((l) => [l.fabric, l.group]), [
    ['red', '239.10.1.7'],
    ['blue', '239.10.2.7'],
  ]);
  // …and the copy carries pool addresses of the target domain.
  assert.equal(channel.allocation!.groups.red, '239.200.0.1');
  assert.match(channel.senderSdp!, /c=IN IP4 239\.200\.0\.1\/64/);
  assert.ok(!channel.senderSdp!.includes('239.10.1.7'));

  // NAT is programmed from the source domain's interface into the target domain's.
  const red = drivers.red.applied.get(`${channel.id}:red`)!;
  assert.ok(red.includes('ip nat destination static 239.10.1.7 239.200.0.1 group 100'));
  assert.ok(red.includes('interface Vlan101'));
  assert.ok(red.includes('interface Vlan901'));

  // The copy is published in the partner registry, with the origin's label.
  const sender = partner.posts.find((p) => p.type === 'sender');
  assert.ok(sender, 'the copy must be registered in the partner registry');
  assert.equal(sender!.data.label, 'CAM07 Video');
  assert.equal(internal.posts.filter((p) => p.type === 'sender').length, 0);

  // No IS-05 anywhere — a sender copy drives nothing.
  assert.equal(internal.patches.length + partner.patches.length, 0);
});

test('a proxy receiver drives the original receiver over IS-05', async (t) => {
  const internal = await startStub();
  const partner = await startStub();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-mirror-'));
  const mirrorId = randomUUID();
  const proxyId = 'proxy-rx-1';
  const { engine, cfg, drivers } = await build(internal, partner, dir, {
    mirrors: [
      {
        id: mirrorId,
        kind: 'receiver',
        deviceId: 'dev1',
        registryId: 'regA',
        originId: ORIGIN_RECEIVER,
        originDeviceId: ORIGIN_DEVICE,
        originLabel: 'MON03',
        enabled: true,
      },
    ],
    receivers: [
      {
        id: proxyId,
        label: 'Proxy MON03',
        deviceId: 'dev1',
        format: 'video',
        enabled: true,
        proxyFor: { registryId: 'regA', receiverId: ORIGIN_RECEIVER, deviceId: ORIGIN_DEVICE, mirrorId },
      },
    ],
  });
  cfg.devices[0]!.receiverIds = [proxyId];

  t.after(async () => {
    await engine.stop();
    internal.server.close();
    partner.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  // The proxy is a normal virtual receiver in the source domain.
  assert.ok(internal.posts.some((p) => p.type === 'receiver' && p.data.label === 'Proxy MON03'));

  const channel = await engine.activate(proxyId, {
    sender_id: 'local-sender',
    master_enable: true,
    transport_file: { data: SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  assert.equal(channel.state, 'active');
  assert.equal(channel.remoteReceiver?.connected, true, channel.remoteReceiver?.error ?? '');
  assert.equal(drivers.red.applied.size, 1, 'NAT is programmed for a proxy too');

  // The original receiver was patched with our published sender and the rewritten SDP.
  assert.equal(partner.patches.length, 1);
  const patch = partner.patches[0]!;
  assert.equal(patch.receiverId, ORIGIN_RECEIVER);
  assert.equal(patch.body.master_enable, true);
  assert.equal((patch.body.activation as { mode: string }).mode, 'activate_immediate');
  const publishedSender = partner.posts.find((p) => p.type === 'sender')!;
  assert.equal(patch.body.sender_id, publishedSender.id, 'it must subscribe to the sender we published');
  const sdp = (patch.body.transport_file as { data: string }).data;
  assert.match(sdp, /c=IN IP4 239\.200\.0\.1\/64/);
  assert.ok(!sdp.includes('239.10.1.7'), 'the remote receiver must get the translated addresses');

  // Teardown releases the original receiver before our sender disappears.
  partner.deletes.length = 0;
  await engine.deactivate(proxyId);
  assert.equal(partner.patches.length, 2);
  assert.equal(partner.patches[1]!.body.master_enable, false);
  assert.equal(partner.patches[1]!.body.sender_id, null);
  assert.ok(partner.deletes.some((u) => u.includes('/senders/')));
  assert.equal(drivers.red.applied.size, 0);
});

test('a proxy stays usable when the original receiver refuses the patch', async (t) => {
  const internal = await startStub();
  const partner = await startStub();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-mirror-'));
  const proxyId = 'proxy-rx-2';
  const { engine } = await build(internal, partner, dir, {
    receivers: [
      {
        id: proxyId,
        label: 'Proxy Unreachable',
        deviceId: 'dev1',
        format: 'video',
        enabled: true,
        // Points at a registry that is not configured — the IS-05 step must fail.
        proxyFor: { registryId: 'nope', receiverId: ORIGIN_RECEIVER, deviceId: ORIGIN_DEVICE, mirrorId: 'm' },
      },
    ],
  });
  t.after(async () => {
    await engine.stop();
    internal.server.close();
    partner.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const channel = await engine.activate(proxyId, {
    sender_id: null,
    master_enable: true,
    transport_file: { data: SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  // The stream exists and is published; only the remote receiver did not take it.
  assert.equal(channel.state, 'active');
  assert.equal(channel.remoteReceiver?.connected, false);
  assert.match(channel.remoteReceiver!.error!, /not enabled/);
  assert.ok(partner.posts.some((p) => p.type === 'sender'));
});

test('an unreachable origin is fetched once, not every reconcile', async (t) => {
  const internal = await startStub();
  const partner = await startStub();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-mirror-'));
  const mirrorId = randomUUID();
  const { engine, state } = await build(internal, partner, dir, {
    mirrors: [
      {
        id: mirrorId,
        kind: 'sender',
        deviceId: 'dev1',
        registryId: 'int',
        originId: ORIGIN_SENDER,
        originDeviceId: ORIGIN_DEVICE,
        originLabel: 'CAM07 Video',
        enabled: true,
      },
    ],
  });
  t.after(async () => {
    await engine.stop();
    internal.server.close();
    partner.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  // The end device's connection API is down.
  internal.manifestDown = true;
  await engine.start();
  await engine.reconcile();
  const afterFirst = internal.manifestHits;
  assert.ok(afterFirst >= 1, 'the origin must have been tried');

  // The reconciler runs every 30 s. It used to fetch the manifest again each time, because
  // a failure before the channel existed left nothing behind to say "leave this alone".
  await engine.reconcile();
  await engine.reconcile();
  assert.equal(internal.manifestHits, afterFirst, 'an end device must not be polled');

  const channel = state.current.channels.find((c) => c.mirrorId === mirrorId)!;
  assert.equal(channel.state, 'failed');
  assert.match(channel.error!, /cannot read the original sender/);

  // Retry once it is back.
  internal.manifestDown = false;
  const rebuilt = await engine.copySender(mirrorId);
  assert.equal(rebuilt.state, 'active');
});
