import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from './store.js';
import { DEFAULT_CONFIG, type AppConfig, type DomainConfig } from './schema.js';

const domain = (id: string, kind: 'internal' | 'external'): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: 'eth0', address: '10.0.0.1' },
  firstLeg: 'red',
  switchInterface: { red: 'Vlan1', blue: 'Vlan2' },
  pool: { base: kind === 'internal' ? '239.201.0.0' : '239.200.0.0', pairs: 8, sourceNat: null },
  enabled: true,
});

function configWithDevice(): AppConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    domains: [domain('internal', 'internal'), domain('partnerA', 'external')],
    registries: [
      { id: 'int', label: 'Internal', domainId: 'internal', mode: 'manual', ip: '10.0.0.2', port: 80, version: 'v1.3', enabled: true },
      { id: 'regA', label: 'Partner A', domainId: 'partnerA', mode: 'manual', ip: '10.9.0.2', port: 80, version: 'v1.3', enabled: true },
    ],
    bridges: [
      {
        id: 'b1',
        label: 'NMOS Federation',
        sourceDomain: 'internal',
        targetDomain: 'partnerA',
        targetRegistries: ['regA'],
        nat: false,
        enabled: true,
      },
    ],
    devices: [{ id: 'dev1', label: 'Federation OUT', bridgeId: 'b1', receiverIds: [] }],
    receivers: [],
    mirrors: [],
  };
}

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'cfgstore-'));
  const store = new ConfigStore(dir);
  await store.load();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a clean configuration saves without complaint', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  const issues = await store.save(configWithDevice());
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
});

test('renaming a domain does not lock the operator out of deleting the device', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  await store.save(configWithDevice());

  // Exactly what happened in the field: the domain and registry IDs were edited, so
  // every reference on the device went stale.
  const renamed = structuredClone(store.current);
  renamed.domains[1]!.id = 'partner1';
  renamed.registries[1]!.domainId = 'partner1';
  renamed.registries[1]!.id = 'reg1';

  const issues = await store.save(renamed);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), [], 'a stale reference must not be a hard error');
  assert.match(
    issues.map((i) => i.message).join(' | '),
    /detached/,
    'but it must be reported',
  );

  // And now the part that was impossible before: removing the device.
  const pruned = structuredClone(store.current);
  pruned.devices = [];
  await store.save(pruned);
  assert.equal(store.current.devices.length, 0);
});

test('a genuinely invalid change is still refused', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  await store.save(configWithDevice());
  const broken = structuredClone(store.current);
  broken.domains[1]!.pool.base = '239.200.0.1'; // odd base
  await assert.rejects(() => store.save(broken), /must be even/);
});

test('two domains with the same ID stay a hard error', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  const cfg = configWithDevice();
  cfg.domains[1]!.id = 'internal';
  await assert.rejects(() => store.save(cfg), /duplicate domain ID/);
});

test('an unrelated half-configured domain does not block deleting a device', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  const cfg = configWithDevice();
  // Exactly the field report: NAT switched on before the switch interfaces were filled
  // in. That used to make every save fail — including the delete meant to fix things.
  cfg.nat.enabled = true;
  cfg.domains[1]!.switchInterface = { red: '', blue: '' };
  const issues = await store.save(cfg);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), [], 'half-configured is not an error');
  assert.match(issues.map((i) => i.message).join(' '), /cannot carry a channel/);

  const pruned = structuredClone(store.current);
  pruned.devices = [];
  await store.save(pruned);
  assert.equal(store.current.devices.length, 0);
});

test('a domain without an address is flagged, because its href would be unusable', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  const cfg = configWithDevice();
  cfg.domains[1]!.iface.address = '';
  const issues = await store.save(cfg);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  assert.match(issues.map((i) => i.message).join(' '), /unusable URL/);
});

test('a registry without an address yet is a warning, not a refusal', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  const cfg = configWithDevice();
  cfg.registries.push({ id: 'new', label: 'Just added', domainId: 'internal', mode: 'manual', version: 'v1.3', enabled: true });
  const issues = await store.save(cfg);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  assert.match(issues.map((i) => i.message).join(' '), /no address yet/);
});

test('a save is refused only for what it introduces', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  await store.save(configWithDevice());

  // Get one hard error in place, then try an unrelated change.
  const broken = structuredClone(store.current);
  broken.domains.push({ ...broken.domains[0]!, id: 'second-internal', label: 'Another home' });
  await assert.rejects(() => store.save(broken), /exactly one internal domain/);

  // Force that state in, as a hand-edited config.json would.
  // @ts-expect-error reaching into the private field is the point
  store.cfg = broken;
  const unrelated = structuredClone(broken);
  unrelated.devices = [];
  const issues = await store.save(unrelated);
  assert.match(issues.map((i) => i.message).join(' '), /earlier problem/);

  // But a new problem on top of the old one is still refused.
  const worse = structuredClone(store.current);
  worse.domains[1]!.pool.base = '239.200.0.1';
  await assert.rejects(() => store.save(worse), /must be even/);
});
