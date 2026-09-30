import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolAllocator, NatGroupAllocator, validatePool, poolsOverlap, ipToInt, intToIp } from './pool.js';

const cfg = {
  base: '239.200.0.0',
  pairs: 4,
  sourceNat: { red: '10.9.1.100', blue: '10.9.2.100' },
};

test('gerade Adresse ist blue, ungerade ist red', () => {
  const pool = new PoolAllocator(cfg);
  const a = pool.allocate();
  assert.equal(a.groups.blue, '239.200.0.0');
  assert.equal(a.groups.red, '239.200.0.1');
  assert.equal(ipToInt(a.groups.blue) % 2, 0);
  assert.equal(ipToInt(a.groups.red) % 2, 1);
});

test('Pärchen werden auch für einbeinige Quellen komplett belegt', () => {
  const pool = new PoolAllocator(cfg);
  pool.allocate();               // Index 0, nur blue genutzt
  const second = pool.allocate();
  assert.equal(second.groups.blue, '239.200.0.2');  // nicht .1
  assert.equal(second.index, 1);
});

test('Freigabe gibt das Pärchen zurück, Neuvergabe nimmt den niedrigsten freien Index', () => {
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

test('Source-NAT-Adressen laufen am selben Index mit', () => {
  const pool = new PoolAllocator(cfg);
  pool.allocate();
  const second = pool.allocate();
  assert.deepEqual(second.sources, { red: '10.9.1.101', blue: '10.9.2.101' });
});

test('NAT-Group-Nummern kommen aus einem gemeinsamen Bereich — sie gelten pro Switch', () => {
  const groups = new NatGroupAllocator([500, 502]);
  assert.equal(groups.allocate(), 500);
  assert.equal(groups.allocate(), 501);
  assert.equal(groups.allocate(), 502);
  assert.throws(() => groups.allocate(), /erschöpft/);
  groups.release(501);
  assert.equal(groups.allocate(), 501);
});

test('NAT-Group-Reservierung nach Neustart erkennt Doppelbelegung', () => {
  const groups = new NatGroupAllocator([100, 199]);
  groups.reserve(142);
  assert.throws(() => groups.reserve(142), /bereits belegt/);
  assert.throws(() => groups.reserve(200), /außerhalb/);
});

test('überlappende Pools zweier Domänen werden erkannt', () => {
  const a = { base: '239.200.0.0', pairs: 8, sourceNat: null };
  const b = { base: '239.200.0.8', pairs: 8, sourceNat: null };
  const c = { base: '239.201.0.0', pairs: 8, sourceNat: null };
  assert.equal(poolsOverlap(a, b), true);
  assert.equal(poolsOverlap(a, c), false);
});

test('erschöpfter Pool meldet sich, statt Adressen doppelt zu vergeben', () => {
  const pool = new PoolAllocator({ ...cfg, pairs: 2 });
  pool.allocate();
  pool.allocate();
  assert.throws(() => pool.allocate(), /erschöpft/);
});

test('reserve() stellt den State nach Neustart wieder her', () => {
  const pool = new PoolAllocator(cfg);
  const restored = pool.reserve(2);
  assert.equal(restored.groups.blue, '239.200.0.4');
  assert.equal(pool.allocate().index, 0);
  assert.throws(() => pool.reserve(2), /bereits belegt/);
});

test('ungerade Pool-Basis wird abgelehnt', () => {
  const errors = validatePool({ ...cfg, base: '239.200.0.1' });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /gerade/);
});

test('Unicast-Basis wird abgelehnt', () => {
  const errors = validatePool({ ...cfg, base: '10.0.0.0' });
  assert.match(errors[0]!.message, /Multicast/);
});

test('IP-Konvertierung ist verlustfrei', () => {
  for (const ip of ['0.0.0.0', '239.255.255.255', '10.1.2.3', '255.255.255.255']) {
    assert.equal(intToIp(ipToInt(ip)), ip);
  }
});
