import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTRY_PORT, migrateRegistry, registryUrl, type RegistryConfig } from './schema.js';

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

test('without a port the nmos-cpp default is used', () => {
  assert.equal(registryUrl({ ...base, ip: '10.0.0.5' }), `http://10.0.0.5:${DEFAULT_REGISTRY_PORT}`);
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
