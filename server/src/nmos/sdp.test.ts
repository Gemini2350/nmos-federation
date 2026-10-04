import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSdp, rewriteSdp, assignFabrics, essenceCount } from './sdp.js';

/** Typical ST 2110-20 SDP with 2022-7 redundancy. */
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

test('a redundant SDP is parsed with both legs', () => {
  const p = parseSdp(DUP_SDP);
  assert.equal(p.dup, true);
  assert.equal(p.media.length, 2);
  assert.equal(p.media[0]!.group, '239.10.1.5');
  assert.equal(p.media[1]!.group, '239.10.2.5');
  assert.equal(p.media[0]!.sourceFilter, '10.1.1.50');
  assert.equal(p.media[0]!.port, 5004);
  assert.equal(p.originAddress, '10.1.1.50');
});

test('media without its own c= inherits the session connection', () => {
  const p = parseSdp(SINGLE_SDP);
  assert.equal(p.media.length, 1);
  assert.equal(p.media[0]!.group, '239.10.1.9');
  assert.equal(p.dup, false);
});

test('legs are assigned positionally, in the configured order', () => {
  const legs = assignFabrics(parseSdp(DUP_SDP), ['red', 'blue']);
  assert.deepEqual(legs.map((l) => [l.fabric, l.group]), [
    ['red', '239.10.1.5'],
    ['blue', '239.10.2.5'],
  ]);
});

test('a plant that counts the other way round just flips the order', () => {
  const legs = assignFabrics(parseSdp(DUP_SDP), ['blue', 'red']);
  assert.deepEqual(legs.map((l) => [l.fabric, l.group]), [
    ['blue', '239.10.1.5'],
    ['red', '239.10.2.5'],
  ]);
});

test('a=group:DUP decides which leg is first, not the order of the m= lines', () => {
  // Same SDP with the group naming SECONDARY first: that is what defines the primary.
  const swapped = DUP_SDP.replace('a=group:DUP PRIMARY SECONDARY', 'a=group:DUP SECONDARY PRIMARY');
  const legs = assignFabrics(parseSdp(swapped), ['red', 'blue']);
  assert.deepEqual(legs.map((l) => [l.fabric, l.group]), [
    ['red', '239.10.2.5'],
    ['blue', '239.10.1.5'],
  ]);
});

test('a single-leg source takes the first fabric only', () => {
  const legs = assignFabrics(parseSdp(SINGLE_SDP), ['red', 'blue']);
  assert.equal(legs.length, 1);
  assert.equal(legs[0]!.fabric, 'red');
});

test('a redundant pair counts as one essence, a video+audio SDP as two', () => {
  assert.equal(essenceCount(parseSdp(DUP_SDP)), 1);
  assert.equal(essenceCount(parseSdp(SINGLE_SDP)), 1);
  const multi = SINGLE_SDP.replace(
    'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0\r\n',
    'a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-22-04-00:0\r\nm=video 5006 RTP/AVP 96\r\nc=IN IP4 239.10.1.10/64\r\na=rtpmap:96 raw/90000\r\n',
  );
  assert.equal(essenceCount(parseSdp(multi)), 2, 'two essences cannot be one sender');
});

test('the rewrite replaces group and source in c=, source-filter and o=', () => {
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

test('the rewrite leaves essence description, ports and mediaclk alone', () => {
  const out = rewriteSdp(DUP_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.1', source: null }]]),
  });
  assert.ok(out.includes('a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25;'));
  assert.ok(out.includes('m=video 5004 RTP/AVP 96'));
  assert.ok(out.includes('a=mediaclk:direct=0'));
  assert.ok(out.includes('a=group:DUP PRIMARY SECONDARY'));
  // the second leg without a mapping stays as it is
  assert.ok(out.includes('c=IN IP4 239.10.2.5/64'));
});

test('without a mapping entry the source-filter is unchanged', () => {
  const out = rewriteSdp(DUP_SDP, { byMediaIndex: new Map() });
  assert.ok(out.includes('a=source-filter: incl IN IP4 239.10.1.5 10.1.1.50'));
});

test('a session-level c= is rewritten from the first leg', () => {
  const out = rewriteSdp(SINGLE_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.0', source: '10.9.2.100' }]]),
  });
  assert.match(out, /^c=IN IP4 239\.200\.0\.0\/64$/m);
  assert.ok(!out.includes('239.10.1.9'));
});

test('ts-refclk can be mapped to the target domain', () => {
  const out = rewriteSdp(SINGLE_SDP, {
    byMediaIndex: new Map([[0, { group: '239.200.0.0', source: null }]]),
    tsRefclk: 'ptp=IEEE1588-2008:AA-BB-CC-FF-FE-DD-EE-FF:127',
  });
  assert.match(out, /a=ts-refclk:ptp=IEEE1588-2008:AA-BB-CC-FF-FE-DD-EE-FF:127/);
});

test('CRLF stays CRLF', () => {
  const out = rewriteSdp(DUP_SDP, { byMediaIndex: new Map() });
  assert.ok(out.includes('\r\n'));
});
