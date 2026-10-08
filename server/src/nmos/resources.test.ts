import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nmosVersion } from './resources.js';

const ns = (v: string) => {
  const [s, n] = v.split(':');
  return BigInt(s!) * 1_000_000_000n + BigInt(n!);
};

test('versions issued within one millisecond still differ and increase', () => {
  // Two changes to a resource in the same millisecond used to get the same version,
  // and the second registration was skipped as "already registered".
  const at = new Date(1_791_000_000_123);
  const a = nmosVersion(at);
  const b = nmosVersion(at);
  const c = nmosVersion(new Date(1_791_000_000_000)); // even a clock going back
  assert.ok(ns(b) > ns(a) && ns(c) > ns(b), `${a} < ${b} < ${c}`);
  assert.match(b, /^\d+:\d{1,9}$/, 'still <seconds>:<nanoseconds>');
});
