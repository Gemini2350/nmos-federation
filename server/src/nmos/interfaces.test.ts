import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInterfaces, resolveInterface } from './resources.js';

test('a physical NIC outranks a container bridge and loopback', () => {
  const list = listInterfaces();
  assert.ok(list.length, 'this host must have at least one interface');
  const names = list.map((i) => i.name);
  const firstVirtual = names.findIndex((n) => /^(docker|br-|bridge|veth|virbr|vmnet|utun)/i.test(n));
  const firstPhysical = names.findIndex((n) => !/^(docker|br-|bridge|veth|virbr|vmnet|utun|lo)/i.test(n));
  if (firstVirtual >= 0 && firstPhysical >= 0) {
    assert.ok(firstPhysical < firstVirtual, `physical ${names[firstPhysical]} must come before ${names[firstVirtual]}`);
  }
  // Loopback last.
  const lo = list.findIndex((i) => i.internal);
  if (lo >= 0) assert.equal(lo, list.length - 1);
});

test('every entry is IPv4 with a usable shape', () => {
  for (const i of listInterfaces()) {
    assert.match(i.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(typeof i.name, 'string');
    if (i.mac !== null) assert.match(i.mac, /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/);
  }
});

test('resolveInterface finds the NIC carrying an address and falls back cleanly', () => {
  const real = listInterfaces().find((i) => !i.internal);
  if (real) {
    const found = resolveInterface(real.address, 'wrong-name');
    assert.equal(found.name, real.name, 'the configured name must not win over the real one');
  }
  const missing = resolveInterface('203.0.113.77', 'eth9');
  assert.deepEqual(missing, { name: 'eth9', mac: null });
});
