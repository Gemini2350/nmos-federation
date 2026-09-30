import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolAllocator, NatGroupAllocator, validatePool, poolsOverlap, ipToInt, intToIp } from './pool.js';

const cfg = {
  base: '239.200.0.0',
  pairs: 4,
  sourceNat: { red: '10.9.1.100', blue: '10.9.2.100' },
};

test('even address is blue, odd is red', () => {
  const pool = new PoolAllocator(cfg);
  const a = pool.allocate();
  assert.equal(a.groups.blue, '239.200.0.0');
  assert.equal(a.groups.red, '239.200.0.1');
  assert.equal(ipToInt(a.groups.blue) % 2, 0);
  assert.equal(ipToInt(a.groups.red) % 2, 1);
});

test('pairs are fully reserved even for single-leg sources', () => {
  const pool = new PoolAllocator(cfg);
  pool.allocate();               // index 0, only blue used
  const second = pool.allocate();
  assert.equal(second.groups.blue, '239.200.0.2');  // nicht .1
  assert.equal(second.index, 1);
});

test('releasing returns the pair, the next allocation takes the lowest free index', () => {
  const pool = new PoolAllocator(cfg);
  const a = pool.allocate();
  const b = pool.allocate();
  pool.allocate();
  pool.release(a.index);
  const next = pool.allocate();
  assert.equal(next.index, a.index);
  assert.equal(next.groups.blue, '239.200.0.0');
  assert.deepEqual(pool.usedIndices, [0, 1, 2]);
  assert.equal(b.index, 1);
});

test('source NAT addresses follow the same index', () => {
  const pool = new PoolAllocator(cfg);
  pool.allocate();
  const second = pool.allocate();
  assert.deepEqual(second.sources, { red: '10.9.1.101', blue: '10.9.2.101' });
});

test('NAT group numbers come from a shared range — they are per switch', () => {
  const groups = new NatGroupAllocator([500, 502]);
  assert.equal(groups.allocate(), 500);
  assert.equal(groups.allocate(), 501);
  assert.equal(groups.allocate(), 502);
  assert.throws(() => groups.allocate(), /exhausted/);
  groups.release(501);
  assert.equal(groups.allocate(), 501);
});

test('reserving a NAT group after a restart detects a double booking', () => {
  const groups = new NatGroupAllocator([100, 199]);
  groups.reserve(142);
  assert.throws(() => groups.reserve(142), /already taken/);
  assert.throws(() => groups.reserve(200), /outside/);
});

test('overlapping pools of two domains are detected', () => {
  const a = { base: '239.200.0.0', pairs: 8, sourceNat: null };
  const b = { base: '239.200.0.8', pairs: 8, sourceNat: null };
  const c = { base: '239.201.0.0', pairs: 8, sourceNat: null };
  assert.equal(poolsOverlap(a, b), true);
  assert.equal(poolsOverlap(a, c), false);
});

test('an exhausted pool says so instead of handing out an address twice', () => {
  const pool = new PoolAllocator({ ...cfg, pairs: 2 });
  pool.allocate();
  pool.allocate();
  assert.throws(() => pool.allocate(), /exhausted/);
});

test('reserve() restores the state after a restart', () => {
  const pool = new PoolAllocator(cfg);
  const restored = pool.reserve(2);
  assert.equal(restored.groups.blue, '239.200.0.4');
  assert.equal(pool.allocate().index, 0);
  assert.throws(() => pool.reserve(2), /already taken/);
});

test('an odd pool base is rejected', () => {
  const errors = validatePool({ ...cfg, base: '239.200.0.1' });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /even/);
});

test('a unicast base is rejected', () => {
  const errors = validatePool({ ...cfg, base: '10.0.0.0' });
  assert.match(errors[0]!.message, /multicast/);
});

test('IP conversion is lossless', () => {
  for (const ip of ['0.0.0.0', '239.255.255.255', '10.1.2.3', '255.255.255.255']) {
    assert.equal(intToIp(ipToInt(ip)), ip);
  }
});
