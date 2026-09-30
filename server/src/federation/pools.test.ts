import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager } from './pools.js';
import type { DomainConfig } from '../config/schema.js';

const domain = (id: string, kind: 'internal' | 'external', base: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: 'eth0', address: '10.0.0.1' },
  fabricSubnets: { red: null, blue: null },
  switchInterface: { red: 'Vlan101', blue: 'Vlan102' },
  pool: { base, pairs: 2, sourceNat: null },
  ptpRefclk: null,
  enabled: true,
});

const domains = [
  domain('internal', 'internal', '239.201.0.0'),
  domain('partnerA', 'external', '239.200.0.0'),
  domain('partnerB', 'external', '239.210.0.0'),
];

test('jede Domäne hat ihren eigenen Pool', () => {
  const pools = new PoolManager(domains, [100, 999]);
  assert.equal(pools.allocate('partnerA').groups.blue, '239.200.0.0');
  assert.equal(pools.allocate('partnerB').groups.blue, '239.210.0.0');
  assert.equal(pools.allocate('internal').groups.blue, '239.201.0.0');
});

test('NAT-Group-Nummern kollidieren nicht zwischen Domänen — sie gelten pro Switch', () => {
  const pools = new PoolManager(domains, [100, 999]);
  const ids = [
    pools.allocate('partnerA').natGroupId,
    pools.allocate('partnerB').natGroupId,
    pools.allocate('internal').natGroupId,
  ];
  assert.equal(new Set(ids).size, 3);
});

test('erschöpfte NAT-Group-Nummern geben das Pärchen wieder frei', () => {
  const pools = new PoolManager(domains, [100, 100]);
  pools.allocate('partnerA');
  assert.throws(() => pools.allocate('partnerA'), /NAT-Group/);
  assert.equal(pools.status()['partnerA']!.free, 1); // Pärchen ist nicht verwaist
});

test('unbekannte Domäne wird abgewiesen', () => {
  const pools = new PoolManager(domains, [100, 999]);
  assert.throws(() => pools.allocate('partnerC'), /keine Domäne/);
});

test('Freigabe gibt Pärchen und NAT-Group zurück', () => {
  const pools = new PoolManager(domains, [100, 999]);
  const a = pools.allocate('partnerA');
  pools.release(a);
  const b = pools.allocate('partnerA');
  assert.deepEqual(b.groups, a.groups);
  assert.equal(b.natGroupId, a.natGroupId);
});

test('Recovery stellt Pärchen und NAT-Group aus dem State wieder her', () => {
  const pools = new PoolManager(domains, [100, 999]);
  pools.reserve({ domainId: 'partnerA', index: 1, groups: { red: '', blue: '' }, sources: null, natGroupId: 500 });
  assert.deepEqual(pools.status()['partnerA'], { free: 1, total: 2, used: [1] });
  assert.equal(pools.allocate('partnerA').index, 0);
});
