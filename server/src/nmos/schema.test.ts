import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import {
  MEDIA_TYPES,
  buildDevice,
  buildFlow,
  buildNode,
  buildReceiver,
  buildSender,
  buildSource,
  essenceFromSdp,
  syntheticMac,
} from './resources.js';

/**
 * Validates every resource we register against the **official IS-04 v1.3 schemas**.
 *
 * This exists because the end-to-end tests pass against a stub registry that accepts
 * anything, so they proved our behaviour and nothing about our payloads. A real
 * schema-strict registry (nmos-cpp) rejected every single resource with HTTP 400 while
 * the suite was green.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(here, '..', '..', 'schemas', 'is-04-v1.3');

function makeValidator() {
  // The IS-04 schemas are draft-04; ajv's base class handles them with strict mode off.
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith('.json')) continue;
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as Record<string, unknown>;
    delete schema['$schema']; // draft-04 meta-schema is not bundled; the rules still apply
    ajv.addSchema(schema, file);
  }
  return ajv;
}

const ajv = makeValidator();

function check(schemaFile: string, data: unknown): void {
  const validate = ajv.getSchema(schemaFile);
  assert.ok(validate, `schema ${schemaFile} not loaded`);
  const ok = validate(data);
  if (!ok) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    assert.fail(`${schemaFile}: ${errors}\n${JSON.stringify(data, null, 1)}`);
  }
}

const VIDEO_SDP = [
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

const AUDIO_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.1.1.60',
  's=MIC01',
  't=0 0',
  'm=audio 5004 RTP/AVP 97',
  'c=IN IP4 239.10.1.9/64',
  'a=rtpmap:97 L24/48000/2',
  '',
].join('\r\n');

const identity = {
  id: 'f1f1f1f1-1111-5111-8111-111111111111',
  href: 'http://10.1.0.10:8081/',
  address: '10.1.0.10',
  port: 8081,
  interfaceName: 'eth0',
};

test('the node validates', () => {
  check('node.json', buildNode(identity, 'Federation internal', { refclk: null }));
});

test('the node validates with a PTP clock', () => {
  check('node.json', buildNode(identity, 'Federation internal', { refclk: 'ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0' }));
});

test('the node has no null hostname — a strict validator rejects that outright', () => {
  const node = buildNode(identity, 'x', { refclk: null }) as Record<string, unknown>;
  assert.ok(!('hostname' in node) || typeof node['hostname'] === 'string');
});

test('interfaces[].port_id is an EUI-48, never null and never the interface name', () => {
  const node = buildNode(identity, 'x', { refclk: null }) as { interfaces: { port_id: string }[] };
  for (const iface of node.interfaces) {
    assert.match(iface.port_id, /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/);
  }
});

test('a synthesised MAC is stable, locally administered and unicast', () => {
  const a = syntheticMac('node-a:eth0');
  assert.equal(a, syntheticMac('node-a:eth0'), 'must not change between restarts');
  assert.notEqual(a, syntheticMac('node-b:eth0'));
  assert.match(a, /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/);
  const first = parseInt(a.slice(0, 2), 16);
  assert.equal(first & 0x01, 0, 'unicast bit');
  assert.equal(first & 0x02, 2, 'locally administered bit');
});

test('a real MAC from the OS is used when it resolves', () => {
  const node = buildNode({ ...identity, mac: 'aa-bb-cc-dd-ee-ff' }, 'x', { refclk: null }) as {
    interfaces: { port_id: string; chassis_id: string | null }[];
  };
  assert.equal(node.interfaces[0]!.port_id, 'aa-bb-cc-dd-ee-ff');
  assert.equal(node.interfaces[0]!.chassis_id, 'aa-bb-cc-dd-ee-ff');
});

test('the device validates', () => {
  check('device.json', buildDevice('d1d1d1d1-1111-5111-8111-111111111111', identity.id, 'Federation OUT', 'http://10.1.0.10:8081/x-nmos/connection/v1.1/', [], []));
});

test('a video source validates (source_generic needs grain_rate)', () => {
  const essence = essenceFromSdp(VIDEO_SDP);
  check('source_generic.json', buildSource('a1a1a1a1-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'CAM01', essence));
});

test('an audio source validates', () => {
  const essence = essenceFromSdp(AUDIO_SDP);
  check('source_audio.json', buildSource('a2a2a2a2-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'MIC01', essence));
});

test('a raw video flow validates', () => {
  const essence = essenceFromSdp(VIDEO_SDP);
  check('flow_video_raw.json', buildFlow('b1b1b1b1-1111-5111-8111-111111111111', 'a1a1a1a1-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'CAM01', essence));
});

test('a raw audio flow validates', () => {
  const essence = essenceFromSdp(AUDIO_SDP);
  check('flow_audio_raw.json', buildFlow('b2b2b2b2-1111-5111-8111-111111111111', 'a2a2a2a2-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'MIC01', essence));
});

test('the sender validates', () => {
  check(
    'sender.json',
    buildSender(
      'c1c1c1c1-1111-5111-8111-111111111111',
      'b1b1b1b1-1111-5111-8111-111111111111',
      'd1d1d1d1-1111-5111-8111-111111111111',
      'CAM01',
      'http://10.1.0.10:8081/x-nmos/connection/v1.1/single/senders/c1c1c1c1-1111-5111-8111-111111111111/transportfile',
      ['eth0'],
    ),
  );
});

test('the receiver validates for every format we offer', () => {
  for (const [kind, caps] of Object.entries(MEDIA_TYPES)) {
    const schema = kind === 'audio' ? 'receiver_audio.json' : kind === 'data' ? 'receiver_data.json' : 'receiver_video.json';
    check(
      schema,
      buildReceiver(
        'e1e1e1e1-1111-5111-8111-111111111111',
        'd1d1d1d1-1111-5111-8111-111111111111',
        `RX ${kind}`,
        caps.format,
        caps.mediaTypes,
        ['eth0'],
        { sender_id: null, active: false },
      ),
    );
  }
});

test('a connected receiver validates too', () => {
  check(
    'receiver_video.json',
    buildReceiver(
      'e1e1e1e1-1111-5111-8111-111111111111',
      'd1d1d1d1-1111-5111-8111-111111111111',
      'RX',
      MEDIA_TYPES.video.format,
      MEDIA_TYPES.video.mediaTypes,
      ['eth0'],
      { sender_id: 'c1c1c1c1-1111-5111-8111-111111111111', active: true },
    ),
  );
});

// A Matrox IPMX sender exactly as a controller PATCHed it — the activation that failed
// with "unsupported essence: m=video rtpmap=jxsv".
const JXSV_SDP = [
  'v=0',
  'o=- 37248276889600 37248276889600 IN IP4 10.1.1.65',
  's=Matrox5 IPMX - DA21508 Video Sender 0',
  't=0 0',
  'm=video 5004 RTP/AVP 112',
  'c=IN IP4 239.111.0.43/128',
  'b=AS:199750',
  'a=rtcp:5005',
  'a=source-filter: incl IN IP4 239.111.0.43 10.1.1.65',
  'a=rtpmap:112 jxsv/90000',
  'a=fmtp:112 packetmode=0; profile=High444.12; level=2k-1; sublevel=Sublev4bpp; transmode=1; sampling=YCbCr-4:4:4; width=1920; height=1080; exactframerate=24995/1000; depth=8; PM=2110GPM; interlace; TROFF=2809; IPMX; colorimetry=BT709; TCS=SDR; RANGE=NARROW; measuredpixclk=74237000; htotal=2640; vtotal=1125; SSN=ST2110-22:2019; TP=2110TPW',
  'a=mediaclk:sender',
  'a=ts-refclk:ptp=IEEE1588-2008:EC-46-70-FF-FE-0D-19-57:0',
  '',
].join('\r\n');

test('a JPEG XS (ST 2110-22) SDP is described as BCP-006-01 asks', () => {
  const essence = essenceFromSdp(JXSV_SDP);
  assert.equal(essence.mediaType, 'video/jxsv');
  assert.equal(essence.video!.frameWidth, 1920);
  assert.equal(essence.video!.interlaceMode, 'interlaced_tff');
  assert.deepEqual(essence.video!.grainRate, { numerator: 24995, denominator: 1000 });
  assert.deepEqual(essence.coded, { profile: 'High444.12', level: '2k-1', sublevel: 'Sublev4bpp' });
  assert.deepEqual(essence.sender, { bitRate: 199750, st2110_21SenderType: '2110TPW' });
});

test('a JPEG XS flow, source and sender validate', () => {
  const essence = essenceFromSdp(JXSV_SDP);
  check('source_generic.json', buildSource('a3a3a3a3-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'JXS', essence));
  const flow = buildFlow('b3b3b3b3-1111-5111-8111-111111111111', 'a3a3a3a3-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'JXS', essence);
  check('flow_video_coded.json', flow);
  assert.equal(flow.media_type, 'video/jxsv');
  const sender = buildSender(
    'c3c3c3c3-1111-5111-8111-111111111111',
    'b3b3b3b3-1111-5111-8111-111111111111',
    'd1d1d1d1-1111-5111-8111-111111111111',
    'JXS',
    'http://10.1.0.10:8081/x-nmos/connection/v1.1/single/senders/c3c3c3c3-1111-5111-8111-111111111111/transportfile',
    ['eth0'],
    essence,
  );
  check('sender.json', sender);
  assert.equal(sender.bit_rate, 199750);
  assert.equal(sender.st2110_21_sender_type, 'urn:x-nmos:st2110_21_sender_type:2110TPW');
});

test('receivers and senders carrying a group hint validate', () => {
  const tags = { 'urn:x-nmos:tag:grouphint/v1.0': ['Cam 1:Video 1'] };
  check(
    'receiver_video.json',
    buildReceiver('e2e2e2e2-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'RX', 'urn:x-nmos:format:video', ['video/raw'], ['eth0'], { sender_id: null, active: false }, tags),
  );
  check(
    'sender.json',
    buildSender('c4c4c4c4-1111-5111-8111-111111111111', 'b1b1b1b1-1111-5111-8111-111111111111', 'd1d1d1d1-1111-5111-8111-111111111111', 'TX', 'http://10.1.0.10:8081/x', ['eth0'], undefined, tags),
  );
});

test('a device passing IS-12 and IS-08 through validates', () => {
  check(
    'device.json',
    buildDevice('d2d2d2d2-1111-5111-8111-111111111111', identity.id, 'Copies', 'http://10.1.0.10:8081/x-nmos/connection/v1.1/', [], [], [
      { type: 'urn:x-nmos:control:ncp/v1.0', href: 'ws://10.1.0.10:8081/x-nmos-proxy/d2d2d2d2-1111-5111-8111-111111111111/ncp' },
      { type: 'urn:x-nmos:control:cm-ctrl/v1.0', href: 'http://10.1.0.10:8081/x-nmos-proxy/d2d2d2d2-1111-5111-8111-111111111111/cm/' },
    ]),
  );
});
