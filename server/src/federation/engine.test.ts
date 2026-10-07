import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from './engine.js';
import { PoolManager } from './pools.js';
import { StateStore } from './state.js';
import { MockSwitchDriver } from '../switch/mock.js';
import { DEFAULT_CONFIG, type AppConfig, type DomainConfig } from '../config/schema.js';
import type { AristaConfig } from '../switch/arista-eapi.js';

/** Stub registry: accepts registrations and records them. */
interface StubRegistry {
  server: Server;
  ip: string;
  port: number;
  posts: { type: string; id: string; data: Record<string, unknown> }[];
  deletes: string[];
  heartbeats: number;
  /** Flip to make the health endpoint answer 404, as a restarted registry would. */
  health404?: boolean;
}

async function startStubRegistry(): Promise<StubRegistry> {
  // One object, shared with the handler: returning a spread copy would mean a test
  // flipping `health404` on the result had no effect on the running server.
  const stub = {
    posts: [] as StubRegistry['posts'],
    deletes: [] as string[],
    heartbeats: 0,
    health404: false,
  } as StubRegistry;

  stub.server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.includes('/health/nodes/')) {
      stub.heartbeats++;
      if (stub.health404) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ health: String(Math.floor(Date.now() / 1000)) }));
    }
    if (req.method === 'POST' && url.endsWith('/resource')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const parsed = JSON.parse(body) as { type: string; data: Record<string, unknown> };
        stub.posts.push({ type: parsed.type, id: String(parsed.data.id), data: parsed.data });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(parsed.data));
      });
    }
    if (req.method === 'DELETE') {
      stub.deletes.push(url);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
  stub.ip = '127.0.0.1';
  stub.port = (stub.server.address() as { port: number }).port;
  return stub;
}

const DUP_SDP = [
  'v=0',
  'o=- 1443716955 1443716955 IN IP4 10.1.1.50',
  's=CAM01 Video',
  't=0 0',
  'a=group:DUP PRIMARY SECONDARY',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.1.5/64',
  'a=source-filter: incl IN IP4 239.10.1.5 10.1.1.50',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; TP=2110TPN;',
  'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0',
  'a=mediaclk:direct=0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.2.5/64',
  'a=source-filter: incl IN IP4 239.10.2.5 10.1.2.50',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; TP=2110TPN;',
  'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0',
  'a=mediaclk:direct=0',
  '',
].join('\r\n');

const domain = (id: string, kind: 'internal' | 'external', address: string, red: string, blue: string, base: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: kind === 'internal' ? 'eth0' : 'eth1', address },
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

async function buildEngine(reg: { internal: StubRegistry; partnerA: StubRegistry }, dir: string) {
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    nat: { enabled: true, driver: 'mock', groupIdRange: [100, 199], switches: { red: sw(), blue: sw() } },
    domains: [
      domain('internal', 'internal', '127.0.0.1', 'Vlan101', 'Vlan102', '239.201.0.0'),
      domain('partnerA', 'external', '127.0.0.1', 'Vlan901', 'Vlan902', '239.200.0.0'),
    ],
    registries: [
      { id: 'int', label: 'internal', domainId: 'internal', mode: 'manual', ip: reg.internal.ip, port: reg.internal.port, version: 'v1.3', enabled: true },
      { id: 'regA', label: 'Partner A', domainId: 'partnerA', mode: 'manual', ip: reg.partnerA.ip, port: reg.partnerA.port, version: 'v1.3', enabled: true },
    ],
    bridges: [
      {
        id: 'b1',
        label: 'NMOS Federation',
        domains: ['internal', 'partnerA'],
        registries: ['regA'],
        nat: true,
        enabled: true,
      },
    ],
    devices: [{ id: 'dev1', label: 'Federation OUT', bridgeId: 'b1', receiverIds: ['vrx1'] }],
    receivers: [{ id: 'vrx1', label: 'Fed RX 1', deviceId: 'dev1', format: 'video', enabled: true }],
  };

  const state = new StateStore(dir);
  await state.load();
  const drivers = { red: new MockSwitchDriver('red', sw()), blue: new MockSwitchDriver('blue', sw()) };
  const pools = new PoolManager(cfg.domains, cfg.nat.groupIdRange);
  const engine = new Engine({ config: () => cfg, state, pools, drivers });
  return { engine, state, drivers, cfg };
}

test('end to end: connecting to a virtual receiver creates NAT and a published sender', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, state } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);

  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();

  // The virtual receiver is registered right away — without any connection.
  assert.ok(intReg.posts.some((p) => p.type === 'node'));
  assert.ok(intReg.posts.some((p) => p.type === 'device'));
  const rx = intReg.posts.find((p) => p.type === 'receiver');
  assert.ok(rx, 'the receiver must be in the internal registry');
  assert.equal(rx!.data.label, 'Fed RX 1');
  // Before the connection there is no sender.
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);

  // Per-registry status: counted by type, and the heartbeat is current.
  const intStatus = engine.registryStatus().find((r) => r.id === 'int')!;
  assert.equal(intStatus.state, 'ok');
  assert.equal(intStatus.url, `http://${intReg.ip}:${intReg.port}`);
  assert.equal(intStatus.resources.node, 1);
  assert.equal(intStatus.resources.device, 1);
  assert.equal(intStatus.resources.receiver, 1);
  assert.equal(intStatus.resources.sender, 0);
  assert.equal(intStatus.resources.total, 3);

  const offStatus = engine.registryStatus().find((r) => r.id === 'regA')!;
  assert.equal(offStatus.domainId, 'partnerA');

  // --- the operator connects a real source to the virtual receiver ----------
  const channel = await engine.activate('vrx1', {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  assert.equal(channel.state, 'active');
  assert.equal(channel.targetDomain, 'partnerA');
  assert.deepEqual(channel.legs.map((l) => l.fabric), ['red', 'blue']);

  // Pool: even = blue, odd = red, from the TARGET domain's pool.
  assert.equal(channel.allocation!.groups.blue, '239.200.0.0');
  assert.equal(channel.allocation!.groups.red, '239.200.0.1');
  assert.deepEqual(channel.allocation!.sources, { red: '10.9.1.200', blue: '10.9.2.200' });

  // Switch: both fabrics programmed, ingress internal, egress external.
  const redCmds = drivers.red.applied.get(`${channel.id}:red`);
  const blueCmds = drivers.blue.applied.get(`${channel.id}:blue`);
  assert.ok(redCmds, 'the red fabric must be programmed');
  assert.ok(blueCmds, 'the blue fabric must be programmed');
  assert.ok(redCmds!.includes('ip nat destination static 239.10.1.5 239.200.0.1 group 100'));
  assert.ok(redCmds!.includes('ip igmp static-group 239.10.1.5 source 10.1.1.50'));
  assert.ok(redCmds!.includes('ip nat source static 10.1.1.50 10.9.1.200 group 100'));
  assert.ok(redCmds!.includes('interface Vlan101'));
  assert.ok(redCmds!.includes('interface Vlan901'));
  assert.ok(blueCmds!.includes('ip nat destination static 239.10.2.5 239.200.0.0 group 100'));

  // Registry: the sender is in the target registry, with derived essence.
  const sender = extReg.posts.find((p) => p.type === 'sender');
  const flow = extReg.posts.find((p) => p.type === 'flow');
  assert.ok(sender, 'the sender must be in the partner registry');
  assert.equal(flow!.data.frame_width, 1920);
  assert.equal(flow!.data.frame_height, 1080);
  assert.deepEqual(flow!.data.grain_rate, { numerator: 25, denominator: 1 });
  assert.equal(flow!.data.media_type, 'video/raw');
  assert.match(String(sender!.data.manifest_href), /\/transportfile$/);
  // …and not in the internal one.
  assert.equal(intReg.posts.filter((p) => p.type === 'sender').length, 0);

  // The target registry now holds source, flow and sender on top of node + device.
  const tgtStatus = engine.registryStatus().find((r) => r.id === 'regA')!;
  assert.equal(tgtStatus.state, 'ok');
  assert.equal(tgtStatus.resources.sender, 1);
  assert.equal(tgtStatus.resources.flow, 1);
  assert.equal(tgtStatus.resources.source, 1);
  assert.equal(tgtStatus.resources.receiver, 0, 'receivers belong to the source domain');

  // The virtual sender's SDP carries the pool addresses, not the originals.
  assert.match(channel.senderSdp!, /c=IN IP4 239\.200\.0\.1\/64/);
  assert.match(channel.senderSdp!, /c=IN IP4 239\.200\.0\.0\/64/);
  assert.match(channel.senderSdp!, /a=source-filter: incl IN IP4 239\.200\.0\.1 10\.9\.1\.200/);
  assert.ok(!channel.senderSdp!.includes('239.10.1.5'));
  assert.ok(!channel.senderSdp!.includes('10.1.1.50'));
  // The essence description is untouched.
  assert.ok(channel.senderSdp!.includes('width=1920; height=1080; exactframerate=25'));

  // --- the receiver is switched off -----------------------------------------
  extReg.deletes.length = 0;
  await engine.deactivate('vrx1');

  assert.equal(state.current.channels.length, 0);
  assert.equal(drivers.red.applied.size, 0, 'NAT must be cleared');
  assert.equal(drivers.blue.applied.size, 0);
  assert.ok(
    extReg.deletes.some((u) => u.includes('/senders/')),
    'the virtual sender must be unregistered',
  );
  // The sender is unregistered before source and flow — nobody should connect to
  // a stream we are about to tear down.
  const senderIdx = extReg.deletes.findIndex((u) => u.includes('/senders/'));
  const flowIdx = extReg.deletes.findIndex((u) => u.includes('/flows/'));
  assert.ok(senderIdx < flowIdx, 'sender first, then flow');

  // The pool is free again and is handed out next.
  const again = await engine.activate('vrx1', {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });
  assert.equal(again.allocation!.groups.blue, '239.200.0.0');
  assert.equal(again.allocation!.natGroupId, 100);
});

test('a bridge registers its node even with no device on it yet', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, cfg } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  // A bridge exists, but nothing has been put on it yet.
  cfg.devices = [];
  cfg.receivers = [];

  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();

  // Without this the plan is empty, nothing is registered, and the heartbeat 404s
  // forever while the status claims the registry was never contacted.
  assert.ok(
    intReg.posts.some((p) => p.type === 'node'),
    'the bridge is the node, so it registers on its own',
  );
  assert.equal(intReg.posts.filter((p) => p.type === 'device').length, 0);
  assert.ok(extReg.posts.some((p) => p.type === 'node'), 'and in the external domain too');

  const status = engine.registryStatus().find((r) => r.id === 'int')!;
  assert.notEqual(status.state, 'unknown', 'contact has happened, so the state must not say otherwise');
  assert.equal(status.resources.node, 1);
});

test('a registry shows one node per bridge and one device per device', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  await engine.activate('vrx1', {
    sender_id: null,
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  const unique = (reg: StubRegistry, type: string) =>
    new Set(reg.posts.filter((p) => p.type === type).map((p) => p.id));

  // One node for the whole installation, the same id in both registries.
  assert.equal(unique(intReg, 'node').size, 1);
  assert.equal(unique(extReg, 'node').size, 1);
  assert.deepEqual([...unique(intReg, 'node')], [...unique(extReg, 'node')], 'the same node on both sides of the bridge');

  // One device, also the same id on both sides — no separate mirror.
  assert.equal(unique(intReg, 'device').size, 1);
  assert.equal(unique(extReg, 'device').size, 1);
  assert.deepEqual([...unique(intReg, 'device')], [...unique(extReg, 'device')]);

  // It carries its receivers on the source side and its senders on the target side.
  const srcDev = intReg.posts.filter((p) => p.type === 'device').at(-1)!.data as { receivers: string[]; senders: string[] };
  const tgtDev = extReg.posts.filter((p) => p.type === 'device').at(-1)!.data as { receivers: string[]; senders: string[] };
  assert.equal(srcDev.receivers.length, 1);
  assert.equal(srcDev.senders.length, 0);
  assert.equal(tgtDev.senders.length, 1);
  assert.equal(tgtDev.receivers.length, 0);

  // And every resource hangs off that one node.
  const nodeId = [...unique(intReg, 'node')][0];
  for (const reg of [intReg, extReg]) {
    for (const p of reg.posts.filter((x) => x.type === 'device')) {
      assert.equal((p.data as { node_id: string }).node_id, nodeId);
    }
  }
});

test('the bridge name is the node name, and changing it renames the node', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, cfg } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  assert.equal(intReg.posts.find((p) => p.type === 'node')!.data.label, 'NMOS Federation');

  cfg.bridges[0]!.label = 'Brücke zu Partner A';
  await engine.syncRegistries();
  assert.equal(intReg.posts.filter((p) => p.type === 'node').at(-1)!.data.label, 'Brücke zu Partner A');
  assert.equal(extReg.posts.filter((p) => p.type === 'node').at(-1)!.data.label, 'Brücke zu Partner A');
});

test('an unchanged sync re-registers nothing', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const after = intReg.posts.length + extReg.posts.length;
  assert.ok(after > 0, 'the first sync must register something');

  // The reconciler runs this every 30 s. Stamping a fresh version on every build made it
  // re-POST the whole tree each time, so a registry saw our resources "update"
  // constantly for no reason.
  await engine.syncRegistries();
  await engine.syncRegistries();
  assert.equal(intReg.posts.length + extReg.posts.length, after, 'nothing changed, so nothing should be sent');
});

test('a changed label is sent, with a new version', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, cfg } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const before = intReg.posts.filter((p) => p.type === 'receiver').at(-1)!;
  cfg.receivers[0]!.label = 'Renamed';
  await engine.syncRegistries();

  const after = intReg.posts.filter((p) => p.type === 'receiver').at(-1)!;
  assert.equal(after.data.label, 'Renamed');
  assert.notEqual(after.data.version, before.data.version, 'changed content needs a new version');
});

test('a heartbeat 404 counts as contact, not as silence', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const client = engine.registries.get('int')!;
  // Make the stub answer 404 to the health endpoint, as a restarted registry would.
  intReg.health404 = true;
  await client.heartbeat();

  const status = client.status();
  assert.equal(status.reachable, true, 'a 404 is an answer — the registry was reached');
  assert.equal(status.state, 'degraded');
  assert.match(status.error!, /node unknown/);
});

test('an SDP carrying two essences is refused, not NATted as a redundant pair', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.start();

  // Video and audio in one SDP: two m= lines, no a=group:DUP.
  const multi = [
    'v=0',
    'o=- 1 1 IN IP4 10.1.1.50',
    's=CAM01 + MIC01',
    't=0 0',
    'm=video 5004 RTP/AVP 96',
    'c=IN IP4 239.10.1.5/64',
    'a=rtpmap:96 raw/90000',
    'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709;',
    'm=audio 5006 RTP/AVP 97',
    'c=IN IP4 239.10.1.6/64',
    'a=rtpmap:97 L24/48000/2',
    '',
  ].join('\r\n');

  await assert.rejects(
    engine.activate('vrx1', {
      sender_id: null,
      master_enable: true,
      transport_file: { data: multi, type: 'application/sdp' },
      transport_params: [{}],
    }),
    /2 essences/,
  );
  assert.equal(drivers.red.applied.size, 0, 'nothing may be programmed for an SDP we cannot represent');
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);
});

test('NAT off: the SDP is copied verbatim and the switch is left alone', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, cfg } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  cfg.bridges[0]!.nat = false;

  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  const channel = await engine.activate('vrx1', {
    sender_id: null,
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  assert.equal(channel.state, 'active');
  assert.equal(channel.allocation, null);
  assert.equal(channel.senderSdp, DUP_SDP);
  assert.equal(drivers.red.applied.size, 0);
  assert.ok(extReg.posts.some((p) => p.type === 'sender'));
});

test('an unusable SDP fails before the switch is touched', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, state } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);

  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();
  await assert.rejects(
    engine.activate('vrx1', {
      sender_id: null,
      master_enable: true,
      // fmtp without width/height -> essence cannot be derived
      transport_file: {
        data: 'v=0\r\no=- 1 1 IN IP4 10.1.1.50\r\ns=x\r\nm=video 5004 RTP/AVP 96\r\nc=IN IP4 239.10.1.5/64\r\na=rtpmap:96 raw/90000\r\na=fmtp:96 sampling=YCbCr-4:2:2;\r\n',
        type: 'application/sdp',
      },
      transport_params: [{}],
    }),
    /width\/height/,
  );

  assert.equal(drivers.red.applied.size, 0, 'the switch must not have been touched');
  assert.equal(state.current.channels[0]!.state, 'failed');
  assert.equal(state.current.channels[0]!.allocation, null, 'the pool must be released');
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);
});

test('an activation reaches the receiver subscription in the source registry at once, not with the next reconcile', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, state } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.start();

  const subscriptions = () =>
    intReg.posts.filter((p) => p.type === 'receiver').map((p) => p.data.subscription as { sender_id: string | null; active: boolean });

  // What the node API's PATCH does: active state first, then the federation chain.
  const conn = {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  };
  state.connection('vrx1').active = conn;
  await engine.activate('vrx1', conn);
  assert.deepEqual(subscriptions().at(-1), { sender_id: 'real-sender-uuid', active: true });

  state.connection('vrx1').active = { ...conn, sender_id: null, master_enable: false };
  await engine.deactivate('vrx1');
  assert.deepEqual(subscriptions().at(-1), { sender_id: null, active: false });
});

test('one bridge, both directions: a receiver offered on the far side streams back', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, cfg, drivers } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  // vrx1 is offered internally (internal → partnerA); vrx2 on the partner side, so its
  // stream flows the other way. Same device, same bridge, same node.
  cfg.receivers.push({ id: 'vrx2', label: 'Back RX 1', deviceId: 'dev1', format: 'video', enabled: true, side: 'partnerA' });
  cfg.devices[0]!.receiverIds.push('vrx2');
  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.start();

  const labels = (stub: StubRegistry, type: string) => stub.posts.filter((p) => p.type === type).map((p) => p.data.label);
  assert.deepEqual(labels(intReg, 'receiver'), ['Fed RX 1'], 'only the internally offered receiver is internal');
  assert.deepEqual(labels(extReg, 'receiver'), ['Back RX 1'], 'the back channel receiver is offered on the partner side');
  const nodeOf = (stub: StubRegistry) => stub.posts.find((p) => p.type === 'node')!.id;
  assert.equal(nodeOf(intReg), nodeOf(extReg), 'one node in both domains');

  const back = await engine.activate('vrx2', {
    sender_id: 'partner-sender',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });
  assert.equal(back.sourceDomain, 'partnerA');
  assert.equal(back.targetDomain, 'internal');
  // From the INTERNAL pool now, and NAT from the partner's interfaces into ours.
  assert.equal(back.allocation!.domainId, 'internal');
  assert.equal(back.allocation!.groups.red, '239.201.0.1');
  const red = drivers.red.applied.get(`${back.id}:red`)!;
  assert.ok(red.includes('ip nat destination static 239.10.1.5 239.201.0.1 group 100'), red.join('\n'));
  assert.ok(red.indexOf('interface Vlan901') < red.indexOf('interface Vlan101'), 'ingress on the partner side, egress internal');

  // The sender appears internally, not at the partner.
  assert.ok(intReg.posts.some((p) => p.type === 'sender'), 'published internally');
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);

  // And the forward direction still works next to it, from the partner's pool.
  const fwd = await engine.activate('vrx1', {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });
  assert.equal(fwd.targetDomain, 'partnerA');
  assert.equal(fwd.allocation!.domainId, 'partnerA');
  assert.ok(extReg.posts.some((p) => p.type === 'sender'), 'published at the partner');

  // The device carries, per domain, the receivers offered there and the senders there.
  const lastDevice = (stub: StubRegistry) => stub.posts.filter((p) => p.type === 'device').at(-1)!.data as { senders: string[]; receivers: string[] };
  assert.equal(lastDevice(intReg).receivers.length, 1);
  assert.equal(lastDevice(intReg).senders.length, 1);
  assert.equal(lastDevice(extReg).receivers.length, 1);
  assert.equal(lastDevice(extReg).senders.length, 1);
});

test('a registry left out of a bridge is not heartbeated for its node', async (t) => {
  // Heartbeating "every node of the domain" hit registries the bridge was deliberately
  // not registered in; each 404 read as a registry restart and re-registered
  // everything there every five seconds.
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const leftOut = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, cfg } = await buildEngine({ internal: intReg, partnerA: extReg }, dir);
  cfg.registries.push({ id: 'regB', label: 'Partner B', domainId: 'partnerA', mode: 'manual', ip: leftOut.ip, port: leftOut.port, version: 'v1.3', enabled: true });
  t.after(async () => {
    await engine.stop();
    for (const s of [intReg, extReg, leftOut]) s.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.start(); // the bridge lists only regA on the partner side
  assert.equal(leftOut.posts.length, 0, 'nothing registered in the left-out registry');
  const clients = (engine as unknown as { registries: Map<string, { heartbeat(): Promise<void> }> }).registries;
  await clients.get('regB')!.heartbeat();
  await clients.get('regA')!.heartbeat();
  assert.equal(leftOut.heartbeats, 0, 'no heartbeat for a node it does not hold');
  assert.equal(extReg.heartbeats, 1);
});
