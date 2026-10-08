import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passableControls, translateIds } from './passthrough.js';

const ORIG_RX = '1b2c3d4e-0000-4000-8000-00000000aaaa';
const OUR_RX = '9f8e7d6c-0000-5000-8000-00000000bbbb';
const OTHER = '55555555-0000-4000-8000-000000000000';

test('ids are swapped in both directions, unknown ones untouched', () => {
  const toOurs = new Map([[ORIG_RX, OUR_RX]]);
  // A BCP-008 touchpoint as IS-12 sends it.
  const msg = JSON.stringify({ value: [{ contextNamespace: 'x-nmos', resource: { resourceType: 'receiver', id: ORIG_RX } }, { resource: { id: OTHER } }] });
  const out = translateIds(msg, toOurs);
  assert.ok(out.includes(OUR_RX) && !out.includes(ORIG_RX));
  assert.ok(out.includes(OTHER), 'an id we have no copy of passes');
  assert.equal(translateIds(out, new Map([[OUR_RX, ORIG_RX]])), msg, 'and back');
});

test('ids match regardless of case', () => {
  assert.equal(translateIds(ORIG_RX.toUpperCase(), new Map([[ORIG_RX, OUR_RX]])), OUR_RX);
});

test('only IS-12 and IS-08 controls pass, one of each', () => {
  const picked = passableControls([
    { type: 'urn:x-nmos:control:sr-ctrl/v1.1', href: 'http://a/x-nmos/connection/v1.1/' },
    { type: 'urn:x-nmos:control:ncp/v1.0', href: 'ws://a/x-nmos/ncp/v1.0/connect' },
    { type: 'urn:x-nmos:control:ncp/v1.0', href: 'ws://b/x-nmos/ncp/v1.0/connect' },
    { type: 'urn:x-nmos:control:cm-ctrl/v1.0', href: 'http://a/x-nmos/channelmapping/v1.0' },
    { type: 'urn:x-nmos:control:events/v1.0', href: 'http://a/x-nmos/events/v1.0' },
  ]);
  assert.deepEqual(picked.map((c) => c.href), ['ws://a/x-nmos/ncp/v1.0/connect', 'http://a/x-nmos/channelmapping/v1.0']);
});
