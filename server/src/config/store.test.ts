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
  fabricSubnets: { red: null, blue: null },
  switchInterface: { red: 'Vlan1', blue: 'Vlan2' },
  pool: { base: kind === 'internal' ? '239.201.0.0' : '239.200.0.0', pairs: 8, sourceNat: null },
  ptpRefclk: null,
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
    devices: [
      {
        id: 'dev1',
        label: 'Federation OUT',
        sourceDomain: 'internal',
        targetDomain: 'partnerA',
        targetRegistries: ['regA'],
        nat: false,
        receiverIds: [],
      },
    ],
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

test('a save that reduces an existing error count is allowed through', async (t) => {
  const { store, cleanup } = await freshStore();
  t.after(cleanup);
  // Get into a state with two hard errors by writing the file behind the validator.
  const cfg = configWithDevice();
  cfg.devices.push({ ...cfg.devices[0]!, id: 'dev2', sourceDomain: 'internal', targetDomain: 'internal' });
  cfg.devices.push({ ...cfg.devices[0]!, id: 'dev3', sourceDomain: 'partnerA', targetDomain: 'partnerA' });
  await assert.rejects(() => store.save(cfg), /source and target domain are the same/);

  // Seed the broken state directly, as an edited config.json would.
  const seeded = new ConfigStore((await mkdtemp(join(tmpdir(), 'cfgstore-'))) as string);
  await seeded.load();
  // @ts-expect-error reaching into the private field is the point: simulate a bad file
  seeded.cfg = cfg;
  assert.equal(seeded.validate(seeded.current).filter((i) => i.level === 'error').length, 2);

  const better = structuredClone(cfg);
  better.devices = better.devices.filter((d) => d.id !== 'dev3');
  const issues = await seeded.save(better);
  assert.match(issues.map((i) => i.message).join(' '), /saved with 1 remaining problem/);
});
