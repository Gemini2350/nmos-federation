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

/** Stub-Registry: nimmt Registrierungen an und protokolliert sie. */
interface StubRegistry {
  server: Server;
  url: string;
  posts: { type: string; id: string; data: Record<string, unknown> }[];
  deletes: string[];
  heartbeats: number;
}

async function startStubRegistry(): Promise<StubRegistry> {
  const stub: Partial<StubRegistry> = { posts: [], deletes: [], heartbeats: 0 };
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.includes('/health/nodes/')) {
      stub.heartbeats!++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ health: String(Math.floor(Date.now() / 1000)) }));
    }
    if (req.method === 'POST' && url.endsWith('/resource')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const parsed = JSON.parse(body) as { type: string; data: Record<string, unknown> };
        stub.posts!.push({ type: parsed.type, id: String(parsed.data.id), data: parsed.data });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(parsed.data));
      });
    }
    if (req.method === 'DELETE') {
      stub.deletes!.push(url);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { ...(stub as StubRegistry), server, url: `http://127.0.0.1:${port}` };
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
  fabricSubnets: { red: kind === 'internal' ? '10.1.1.0/24' : '10.9.1.0/24', blue: kind === 'internal' ? '10.1.2.0/24' : '10.9.2.0/24' },
  switchInterface: { red, blue },
  pool: {
    base,
    pairs: 8,
    sourceNat: kind === 'internal' ? { red: '10.1.1.200', blue: '10.1.2.200' } : { red: '10.9.1.200', blue: '10.9.2.200' },
  },
  ptpRefclk: null,
  enabled: true,
});

const sw = (): AristaConfig => ({ host: '10.0.0.11', user: 'x', password: 'y', tls: true, join: 'igmpStatic' });

async function buildEngine(registryUrls: { internal: string; partnerA: string }, dir: string) {
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    nat: { enabled: true, driver: 'mock', groupIdRange: [100, 199], switches: { red: sw(), blue: sw() } },
    domains: [
      domain('internal', 'internal', '127.0.0.1', 'Vlan101', 'Vlan102', '239.201.0.0'),
      domain('partnerA', 'external', '127.0.0.1', 'Vlan901', 'Vlan902', '239.200.0.0'),
    ],
    registries: [
      { id: 'int', label: 'intern', domainId: 'internal', mode: 'manual', url: registryUrls.internal, version: 'v1.3', enabled: true },
      { id: 'regA', label: 'Partner A', domainId: 'partnerA', mode: 'manual', url: registryUrls.partnerA, version: 'v1.3', enabled: true },
    ],
    devices: [
      {
        id: 'dev1',
        label: 'Federation OUT',
        sourceDomain: 'internal',
        targetDomain: 'partnerA',
        targetRegistries: ['regA'],
        nat: true,
        receiverIds: ['vrx1'],
      },
    ],
    receivers: [{ id: 'vrx1', label: 'Fed RX 1', deviceId: 'dev1', format: 'video', enabled: true }],
  };

  const state = new StateStore(dir);
  await state.load();
  const drivers = { red: new MockSwitchDriver('red', sw()), blue: new MockSwitchDriver('blue', sw()) };
  const pools = new PoolManager(cfg.domains, cfg.nat.groupIdRange);
  const engine = new Engine({ config: () => cfg, state, pools, drivers });
  return { engine, state, drivers, cfg };
}

test('Ende-zu-Ende: Schaltung auf virtuellen Receiver erzeugt NAT und veröffentlichten Sender', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, state } = await buildEngine({ internal: intReg.url, partnerA: extReg.url }, dir);

  t.after(async () => {
    await engine.stop();
    intReg.server.close();
    extReg.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  await engine.start();

  // Der virtuelle Receiver ist sofort registriert — ohne Schaltung.
  assert.ok(intReg.posts.some((p) => p.type === 'node'));
  assert.ok(intReg.posts.some((p) => p.type === 'device'));
  const rx = intReg.posts.find((p) => p.type === 'receiver');
  assert.ok(rx, 'Receiver muss in der internen Registry stehen');
  assert.equal(rx!.data.label, 'Fed RX 1');
  // Vor der Schaltung gibt es keinen Sender.
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);

  // --- Anwender schaltet eine echte Quelle auf den virtuellen Receiver ------
  const channel = await engine.activate('vrx1', {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });

  assert.equal(channel.state, 'active');
  assert.equal(channel.targetDomain, 'partnerA');
  assert.deepEqual(channel.legs.map((l) => l.fabric), ['red', 'blue']);

  // Pool: gerade = blue, ungerade = red, aus dem Pool der ZIEL-Domäne.
  assert.equal(channel.allocation!.groups.blue, '239.200.0.0');
  assert.equal(channel.allocation!.groups.red, '239.200.0.1');
  assert.deepEqual(channel.allocation!.sources, { red: '10.9.1.200', blue: '10.9.2.200' });

  // Switch: beide Fabrics programmiert, Ingress intern, Egress extern.
  const redCmds = drivers.red.applied.get(`${channel.id}:red`);
  const blueCmds = drivers.blue.applied.get(`${channel.id}:blue`);
  assert.ok(redCmds, 'rote Fabric muss programmiert sein');
  assert.ok(blueCmds, 'blaue Fabric muss programmiert sein');
  assert.ok(redCmds!.includes('ip nat destination static 239.10.1.5 239.200.0.1 group 100'));
  assert.ok(redCmds!.includes('ip igmp static-group 239.10.1.5 source 10.1.1.50'));
  assert.ok(redCmds!.includes('ip nat source static 10.1.1.50 10.9.1.200 group 100'));
  assert.ok(redCmds!.includes('interface Vlan101'));
  assert.ok(redCmds!.includes('interface Vlan901'));
  assert.ok(blueCmds!.includes('ip nat destination static 239.10.2.5 239.200.0.0 group 100'));

  // Registry: Sender ist in der Ziel-Registry, mit abgeleiteter Essence.
  const sender = extReg.posts.find((p) => p.type === 'sender');
  const flow = extReg.posts.find((p) => p.type === 'flow');
  assert.ok(sender, 'Sender muss in der Partner-Registry stehen');
  assert.equal(flow!.data.frame_width, 1920);
  assert.equal(flow!.data.frame_height, 1080);
  assert.deepEqual(flow!.data.grain_rate, { numerator: 25, denominator: 1 });
  assert.equal(flow!.data.media_type, 'video/raw');
  assert.match(String(sender!.data.manifest_href), /\/transportfile$/);
  // …und nicht in der internen.
  assert.equal(intReg.posts.filter((p) => p.type === 'sender').length, 0);

  // SDP des virtuellen Senders trägt die Pool-Adressen, nicht die Originale.
  assert.match(channel.senderSdp!, /c=IN IP4 239\.200\.0\.1\/64/);
  assert.match(channel.senderSdp!, /c=IN IP4 239\.200\.0\.0\/64/);
  assert.match(channel.senderSdp!, /a=source-filter: incl IN IP4 239\.200\.0\.1 10\.9\.1\.200/);
  assert.ok(!channel.senderSdp!.includes('239.10.1.5'));
  assert.ok(!channel.senderSdp!.includes('10.1.1.50'));
  // Essence-Beschreibung bleibt unangetastet.
  assert.ok(channel.senderSdp!.includes('width=1920; height=1080; exactframerate=25'));

  // --- Receiver wird abgeschaltet ------------------------------------------
  extReg.deletes.length = 0;
  await engine.deactivate('vrx1');

  assert.equal(state.current.channels.length, 0);
  assert.equal(drivers.red.applied.size, 0, 'NAT muss abgeräumt sein');
  assert.equal(drivers.blue.applied.size, 0);
  assert.ok(
    extReg.deletes.some((u) => u.includes('/senders/')),
    'der virtuelle Sender muss abgemeldet sein',
  );
  // Der Sender wird vor Source und Flow abgemeldet — niemand soll auf einen
  // Strom schalten, den wir gleich abräumen.
  const senderIdx = extReg.deletes.findIndex((u) => u.includes('/senders/'));
  const flowIdx = extReg.deletes.findIndex((u) => u.includes('/flows/'));
  assert.ok(senderIdx < flowIdx, 'Sender zuerst, dann Flow');

  // Pool ist wieder frei und wird als nächstes erneut vergeben.
  const again = await engine.activate('vrx1', {
    sender_id: 'real-sender-uuid',
    master_enable: true,
    transport_file: { data: DUP_SDP, type: 'application/sdp' },
    transport_params: [{}, {}],
  });
  assert.equal(again.allocation!.groups.blue, '239.200.0.0');
  assert.equal(again.allocation!.natGroupId, 100);
});

test('NAT aus: SDP wird 1:1 kopiert, der Switch bleibt unberührt', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, cfg } = await buildEngine({ internal: intReg.url, partnerA: extReg.url }, dir);
  cfg.devices[0]!.nat = false;

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

test('unbrauchbares SDP scheitert, bevor der Switch angefasst wird', async (t) => {
  const intReg = await startStubRegistry();
  const extReg = await startStubRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'nmos-fed-'));
  const { engine, drivers, state } = await buildEngine({ internal: intReg.url, partnerA: extReg.url }, dir);

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
      // fmtp ohne width/height -> Essence nicht ableitbar
      transport_file: {
        data: 'v=0\r\no=- 1 1 IN IP4 10.1.1.50\r\ns=x\r\nm=video 5004 RTP/AVP 96\r\nc=IN IP4 239.10.1.5/64\r\na=rtpmap:96 raw/90000\r\na=fmtp:96 sampling=YCbCr-4:2:2;\r\n',
        type: 'application/sdp',
      },
      transport_params: [{}],
    }),
    /width\/height/,
  );

  assert.equal(drivers.red.applied.size, 0, 'Switch darf nicht angefasst worden sein');
  assert.equal(state.current.channels[0]!.state, 'failed');
  assert.equal(state.current.channels[0]!.allocation, null, 'Pool muss freigegeben sein');
  assert.equal(extReg.posts.filter((p) => p.type === 'sender').length, 0);
});
