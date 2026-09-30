import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSdp, rewriteSdp, assignFabrics } from './sdp.js';

/** Typisches ST-2110-20-SDP mit 2022-7-Redundanz. */
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
  'a=mid:PRIMARY',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.10.2.5/64',
  'a=source-filter: incl IN IP4 239.10.2.5 10.1.2.50',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; TP=2110TPN;',
  'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0',
  'a=mediaclk:direct=0',
  'a=mid:SECONDARY',
  '',
].join('\r\n');

const SINGLE_SDP = [
  'v=0',
  'o=- 12345 12345 IN IP4 10.1.1.60',
  's=MIC01 Audio',
  'c=IN IP4 239.10.1.9/64',
  't=0 0',
  'm=audio 5004 RTP/AVP 97',
  'a=rtpmap:97 L24/48000/2',
  'a=fmtp:97 channel-order=SMPTE2110.(ST)',
  'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0',
  '',
].join('\r\n');

test('redundantes SDP wird mit beiden Beinen erkannt', () => {
  const p = parseSdp(DUP_SDP);
  assert.equal(p.dup, true);
  assert.equal(p.media.length, 2);
  assert.equal(p.media[0]!.group, '239.10.1.5');
  assert.equal(p.media[1]!.group, '239.10.2.5');
  assert.equal(p.media[0]!.sourceFilter, '10.1.1.50');
  assert.equal(p.media[0]!.port, 5004);
  assert.equal(p.originAddress, '10.1.1.50');
});

test('Media ohne eigenes c= erbt die Session-Connection', () => {
  const p = parseSdp(SINGLE_SDP);
  assert.equal(p.media.length, 1);
  assert.equal(p.media[0]!.group, '239.10.1.9');
  assert.equal(p.dup, false);
});

test('Fabric-Zuordnung folgt dem Quell-Subnetz', () => {
  const p = parseSdp(DUP_SDP);
  const legs = assignFabrics(p, { red: '10.1.1.0/24', blue: '10.1.2.0/24' });
  assert.deepEqual(legs.map((l) => l.fabric), ['red', 'blue']);
});

test('ohne passende Subnetze zählt die Reihenfolge der m=-Zeilen', () => {
  const p = parseSdp(DUP_SDP);
  const legs = assignFabrics(p, { red: null, blue: null });
  assert.deepEqual(legs.map((l) => l.fabric), ['red', 'blue']);
});

test('Rewrite ersetzt Gruppe und Quelle in c=, source-filter und o=', () => {
  const out = rewriteSdp(DUP_SDP, {
    byMediaIndex: new Map([
      [0, { group: '239.200.0.1', source: '10.9.1.100' }],
      [1, { group: '239.200.0.0', source: '10.9.2.100' }],
    ]),
  });
  assert.match(out, /c=IN IP4 239\.200\.0\.1\/64/);
  assert.match(out, /c=IN IP4 239\.200\.0\.0\/64/);
  assert.match(out, /a=source-filter: incl IN IP4 239\.200\.0\.1 10\.9\.1\.100/);
  assert.match(out, /a=source-filter: incl IN IP4 239\.200\.0\.0 10\.9\.2\.100/);
  assert.match(out, /^o=- 1443716955 1443716956 IN IP4 10\.9\.1\.100$/m);
  assert.ok(!out.includes('239.10.1.5'));
  assert.ok(!out.includes('10.1.1.50'));
});

test('Rewrite lässt Essence-Beschreibung, Ports und mediaclk unberührt', () => {
  const out = rewriteSdp(DUP_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.1', source: null }]]),
  });
  assert.ok(out.includes('a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25;'));
  assert.ok(out.includes('m=video 5004 RTP/AVP 96'));
  assert.ok(out.includes('a=mediaclk:direct=0'));
  assert.ok(out.includes('a=group:DUP PRIMARY SECONDARY'));
  // zweites Bein ohne Mapping bleibt stehen
  assert.ok(out.includes('c=IN IP4 239.10.2.5/64'));
});

test('ohne Mapping-Eintrag bleibt source-filter unverändert', () => {
  const out = rewriteSdp(DUP_SDP, { byMediaIndex: new Map() });
  assert.ok(out.includes('a=source-filter: incl IN IP4 239.10.1.5 10.1.1.50'));
});

test('Session-Level c= wird über das erste Bein umgeschrieben', () => {
  const out = rewriteSdp(SINGLE_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.0', source: '10.9.2.100' }]]),
  });
  assert.match(out, /^c=IN IP4 239\.200\.0\.0\/64$/m);
  assert.ok(!out.includes('239.10.1.9'));
});

test('ts-refclk kann auf die Zieldomäne umgesetzt werden', () => {
  const out = rewriteSdp(SINGLE_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.0', source: null }]]),
    tsRefclk: 'ptp=IEEE1588-2008:AA-BB-CC-FF-FE-DD-EE-FF:127',
  });
  assert.match(out, /a=ts-refclk:ptp=IEEE1588-2008:AA-BB-CC-FF-FE-DD-EE-FF:127/);
});

test('CRLF bleibt CRLF', () => {
  const out = rewriteSdp(DUP_SDP, { byMediaIndex: new Map() });
  assert.ok(out.includes('\r\n'));
});
