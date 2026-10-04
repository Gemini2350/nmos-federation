import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager } from './pools.js';
import type { DomainConfig } from '../config/schema.js';

const domain = (id: string, kind: 'internal' | 'external', base: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: 'eth0', address: '10.0.0.1' },
  firstLeg: 'red',
  switchInterface: { red: 'Vlan101', blue: 'Vlan102' },
  pool: { base, pairs: 2, sourceNat: null },
  enabled: true,
});

const domains = [
  domain('internal', 'internal', '239.201.0.0'),
  domain('partnerA', 'external', '239.200.0.0'),
  domain('partnerB', 'external', '239.210.0.0'),
];

test('every domain has its own pool', () => {
  const pools = new PoolManager(domains, [100, 999]);
  assert.equal(pools.allocate('partnerA').groups.blue, '239.200.0.0');
  assert.equal(pools.allocate('partnerB').groups.blue, '239.210.0.0');
  assert.equal(pools.allocate('internal').groups.blue, '239.201.0.0');
});

test('NAT group numbers do not collide across domains — they are per switch', () => {
  const pools = new PoolManager(domains, [100, 999]);
  const ids = [
    pools.allocate('partnerA').natGroupId,
    pools.allocate('partnerB').natGroupId,
    pools.allocate('internal').natGroupId,
  ];
  assert.equal(new Set(ids).size, 3);
});

test('an exhausted NAT group range releases the pair again', () => {
  const pools = new PoolManager(domains, [100, 100]);
  pools.allocate('partnerA');
  assert.throws(() => pools.allocate('partnerA'), /NAT group/);
  assert.equal(pools.status()['partnerA']!.free, 1); // the pair is not orphaned
});

test('an unknown domain is rejected', () => {
  const pools = new PoolManager(domains, [100, 999]);
  assert.throws(() => pools.allocate('partnerC'), /no domain/);
});

test('releasing returns both the pair and the NAT group', () => {
  const pools = new PoolManager(domains, [100, 999]);
  const a = pools.allocate('partnerA');
  pools.release(a);
  const b = pools.allocate('partnerA');
  assert.deepEqual(b.groups, a.groups);
  assert.equal(b.natGroupId, a.natGroupId);
});

test('recovery restores pair and NAT group from the state', () => {
  const pools = new PoolManager(domains, [100, 999]);
  pools.reserve({ domainId: 'partnerA', index: 1, groups: { red: '', blue: '' }, sources: null, natGroupId: 500 });
  assert.deepEqual(pools.status()['partnerA'], { free: 1, total: 2, used: [1] });
  assert.equal(pools.allocate('partnerA').index, 0);
});
