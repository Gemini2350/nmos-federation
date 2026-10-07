import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, DEFAULT_REGISTRY_PORT, migrateRegistry, normalizeConfig, proxyLabel, registryUrl, type RegistryConfig } from './schema.js';

const base: RegistryConfig = {
  id: 'r1',
  label: 'Registry',
  domainId: 'internal',
  mode: 'manual',
  version: 'v1.3',
  enabled: true,
};

test('the URL is assembled from ip and port', () => {
  assert.equal(registryUrl({ ...base, ip: '192.168.11.100', port: 8010 }), 'http://192.168.11.100:8010');
});

test('without a port it falls back to the HTTP default, which is left out of the URL', () => {
  assert.equal(DEFAULT_REGISTRY_PORT, 80);
  assert.equal(registryUrl({ ...base, ip: '10.0.0.5' }), 'http://10.0.0.5');
});

test('an explicit nmos-cpp port is kept', () => {
  assert.equal(registryUrl({ ...base, ip: '192.168.11.100', port: 8010 }), 'http://192.168.11.100:8010');
});

test('tls switches the scheme', () => {
  assert.equal(registryUrl({ ...base, ip: '10.0.0.5', port: 8443, tls: true }), 'https://10.0.0.5:8443');
});

test('the default port of the scheme is left out', () => {
  assert.equal(registryUrl({ ...base, ip: 'registry.example', port: 80 }), 'http://registry.example');
  assert.equal(registryUrl({ ...base, ip: 'registry.example', port: 443, tls: true }), 'https://registry.example');
});

test('an IPv6 literal is bracketed', () => {
  assert.equal(registryUrl({ ...base, ip: 'fd00::1', port: 8010 }), 'http://[fd00::1]:8010');
});

test('without an ip there is no URL', () => {
  assert.equal(registryUrl(base), null);
});

test('a legacy url is migrated to ip, port and tls', () => {
  const migrated = migrateRegistry({ ...base, url: 'https://10.9.0.20:8443' });
  assert.equal(migrated.ip, '10.9.0.20');
  assert.equal(migrated.port, 8443);
  assert.equal(migrated.tls, true);
  assert.equal(migrated.url, undefined);
  assert.equal(registryUrl(migrated), 'https://10.9.0.20:8443');
});

test('a legacy url without a port gets the scheme default', () => {
  assert.equal(migrateRegistry({ ...base, url: 'http://registry.example' }).port, 80);
});

test('migration leaves an already converted entry alone and drops the stale url', () => {
  const migrated = migrateRegistry({ ...base, ip: '10.0.0.9', port: 8010, url: 'http://wrong:1' });
  assert.equal(migrated.ip, '10.0.0.9');
  assert.equal(migrated.port, 8010);
  assert.equal(migrated.url, undefined);
});

test('an unparseable url survives for validation to reject', () => {
  const migrated = migrateRegistry({ ...base, url: 'not a url' });
  assert.equal(migrated.ip, undefined);
});

test('receiver proxies carry "Proxy" in front, so the number stays at the end', () => {
  assert.equal(proxyLabel('Monitor 3'), 'Proxy Monitor 3');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.mirrors = [
    { id: 'm1', kind: 'receiver', deviceId: 'd', registryId: '1', originId: 'o1', originDeviceId: 'od', originLabel: 'Monitor 3', enabled: true },
    { id: 'm2', kind: 'receiver', deviceId: 'd', registryId: '1', originId: 'o2', originDeviceId: 'od', originLabel: 'Monitor 4', enabled: true },
  ];
  cfg.receivers = [
    { id: 'r1', label: 'Monitor 3 (proxy)', deviceId: 'd', format: 'video', enabled: true, proxyFor: { registryId: '1', receiverId: 'o1', deviceId: 'od', mirrorId: 'm1' } },
    // Renamed by the operator: not ours to touch.
    { id: 'r2', label: 'Gallery right', deviceId: 'd', format: 'video', enabled: true, proxyFor: { registryId: '1', receiverId: 'o2', deviceId: 'od', mirrorId: 'm2' } },
  ];
  normalizeConfig(cfg);
  assert.equal(cfg.receivers[0]!.label, 'Proxy Monitor 3');
  assert.equal(cfg.receivers[1]!.label, 'Gallery right');
});

test('a directed bridge from an older file becomes undirected, every port keeping its direction', () => {
  const cfg = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown> & typeof DEFAULT_CONFIG;
  (cfg as any).bridges = [{ id: '1', label: 'Out', sourceDomain: 'a', targetDomain: 'b', targetRegistries: ['rb2'], nat: true, enabled: true }];
  cfg.devices = [{ id: 'd1', label: 'D', bridgeId: '1', receiverIds: ['r1'] }];
  cfg.receivers = [{ id: 'r1', label: 'R', deviceId: 'd1', format: 'video', enabled: true }];
  normalizeConfig(cfg);
  const b = cfg.bridges[0] as unknown as Record<string, unknown>;
  assert.deepEqual(b['domains'], ['a', 'b']);
  // Only a registry of the old target was listed, so the old source side stays "all".
  assert.deepEqual(b['registries'], ['rb2']);
  assert.ok(!('sourceDomain' in b) && !('targetDomain' in b) && !('targetRegistries' in b));
  assert.equal(cfg.receivers[0]!.side, 'a', 'offered where it always was');
});
