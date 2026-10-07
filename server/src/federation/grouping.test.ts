import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGroupHint, groupHints, grouphintTags, parseGroupHint, GROUPHINT } from './grouping.js';

test('group hints parse in all the forms found in a real registry', () => {
  assert.deepEqual(parseGroupHint('Service 01:Video 1'), { group: 'Service 01', role: 'Video 1' });
  assert.deepEqual(parseGroupHint('Receive2:Audio:device'), { group: 'Receive2', role: 'Audio', scope: 'device' });
  assert.deepEqual(parseGroupHint('[1,1,1]:vis02'), { group: '[1,1,1]', role: 'vis02' });
  assert.equal(parseGroupHint('no-role'), null);
  assert.equal(parseGroupHint(''), null);
  assert.equal(formatGroupHint({ group: 'A', role: 'B', scope: 'node' }), 'A:B:node');
});

test('a copy keeps its original grouping', () => {
  const hints = groupHints([
    { key: 'p1', format: 'video', origin: { hint: 'Service 01:Video 1', deviceId: 'vb' } },
    { key: 'p2', format: 'audio', origin: { hint: 'Service 01:Audio 1', deviceId: 'vb' } },
    { key: 'p3', format: 'video', origin: { hint: null, deviceId: 'x' } },
  ]);
  assert.deepEqual(hints.get('p1'), { group: 'Service 01', role: 'Video 1' });
  assert.deepEqual(hints.get('p2'), { group: 'Service 01', role: 'Audio 1' });
  assert.equal(hints.has('p3'), false, 'nothing to inherit, nothing invented');
});

test('the same group name from two original devices does not merge', () => {
  // "Receive0" exists on every SDI card; copied into one federation device they would
  // otherwise form one group of two unrelated signals.
  const hints = groupHints([
    { key: 'a', format: 'video', origin: { hint: 'Receive0:Video:device', deviceId: 'cardA', deviceLabel: 'SDI A' } },
    { key: 'b', format: 'video', origin: { hint: 'Receive0:Video:device', deviceId: 'cardB', deviceLabel: 'SDI B' } },
    { key: 'c', format: 'audio', origin: { hint: 'Receive0:Audio:device', deviceId: 'cardA', deviceLabel: 'SDI A' } },
  ]);
  assert.equal(hints.get('a')!.group, 'SDI A / Receive0');
  assert.equal(hints.get('b')!.group, 'SDI B / Receive0');
  assert.equal(hints.get('c')!.group, 'SDI A / Receive0', 'still together with its own video');
});

test('a group typed by the operator wins, roles derived per format for free receivers', () => {
  const hints = groupHints([
    { key: 'v', format: 'video', group: 'Cam 1' },
    { key: 'a1', format: 'audio', group: 'Cam 1' },
    { key: 'a2', format: 'audio', group: 'Cam 1' },
    { key: 'd', format: 'data', group: 'Cam 2' },
    { key: 'copy', format: 'video', group: 'Gallery', origin: { hint: 'Service 01:Video 1', deviceId: 'vb' } },
    { key: 'none', format: 'video', group: '  ' },
  ]);
  assert.deepEqual(hints.get('v'), { group: 'Cam 1', role: 'Video 1' });
  assert.deepEqual(hints.get('a1'), { group: 'Cam 1', role: 'Audio 1' });
  assert.deepEqual(hints.get('a2'), { group: 'Cam 1', role: 'Audio 2' });
  assert.deepEqual(hints.get('d'), { group: 'Cam 2', role: 'Data 1' });
  assert.deepEqual(hints.get('copy'), { group: 'Gallery', role: 'Video 1' }, 'the original role is kept');
  assert.equal(hints.has('none'), false);
});

test('tags carry the hint in the registered form', () => {
  assert.deepEqual(grouphintTags({ group: 'Cam 1', role: 'Video 1' }), { [GROUPHINT]: ['Cam 1:Video 1'] });
  assert.deepEqual(grouphintTags(undefined), {});
});
