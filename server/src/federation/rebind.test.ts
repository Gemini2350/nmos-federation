import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRebind } from './rebind.js';

const mirror = { originId: 'old', originLabel: 'OtherSong', originDeviceLabel: 'AES67-TestSignal-Gen' };
const devices = new Map([
  ['devNew', 'AES67-TestSignal-Gen'],
  ['devX', 'Other box'],
]);

test('present: nothing to do', () => {
  assert.deepEqual(decideRebind(mirror, [{ id: 'old', label: 'OtherSong', device_id: 'devOld' }], devices, new Set()), { status: 'present' });
});

test('one resource with the same name on a device with the same name: re-bind', () => {
  const d = decideRebind(mirror, [
    { id: 'new', label: 'OtherSong', device_id: 'devNew' },
    { id: 'x', label: 'OtherSong', device_id: 'devX' }, // same name, other device: not it
  ], devices, new Set());
  assert.equal(d.status, 'rebind');
  assert.equal(d.status === 'rebind' && d.resource.id, 'new');
});

test('ambiguous, already taken, or unknown device: never guess', () => {
  const two = [
    { id: 'a', label: 'OtherSong', device_id: 'devNew' },
    { id: 'b', label: 'OtherSong', device_id: 'devNew' },
  ];
  assert.match((decideRebind(mirror, two, devices, new Set()) as { reason: string }).reason, /ambiguous/);
  const taken = decideRebind(mirror, two, devices, new Set(['a']));
  assert.equal(taken.status === 'rebind' && taken.resource.id, 'b', 'the other is bound to another copy');
  assert.equal(decideRebind({ ...mirror, originDeviceLabel: null }, two, devices, new Set()).status, 'missing');
});
