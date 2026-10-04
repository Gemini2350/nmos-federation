import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressFromInstanceName, buildCandidate, discoverRegistries, hostSearchDomains, SERVICE_TYPES } from './discovery.js';

async function resolvConf(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'resolv-'));
  const path = join(dir, 'resolv.conf');
  await writeFile(path, body, 'utf8');
  return path;
}

test('the search domain is taken from the host resolv.conf', async () => {
  const path = await resolvConf('nameserver 10.0.0.1\nsearch studio.example.com example.com\n');
  assert.deepEqual(await hostSearchDomains(path), ['studio.example.com', 'example.com']);
});

test('a "domain" line counts as a search domain too', async () => {
  const path = await resolvConf('domain studio.example.com.\nnameserver 10.0.0.1\n');
  assert.deepEqual(await hostSearchDomains(path), ['studio.example.com']);
});

test('comments and the useless "." entry are ignored', async () => {
  const path = await resolvConf('# search commented.example\nsearch . local studio.example\n');
  assert.deepEqual(await hostSearchDomains(path), ['local', 'studio.example']);
});

test('a missing resolv.conf yields no search domains instead of throwing', async () => {
  assert.deepEqual(await hostSearchDomains('/nonexistent/resolv.conf'), []);
});

const TXT = { api_proto: 'http', api_ver: 'v1.2,v1.3', pri: '10' };

test('nmos-cpp puts the address in the instance name, which is the only way across a reflector', () => {
  assert.equal(
    addressFromInstanceName('nmos-cpp_registration_192-168-11-100_8010._nmos-registration._tcp.local'),
    '192.168.11.100',
  );
});

test('an instance name without an address yields nothing rather than a guess', () => {
  assert.equal(addressFromInstanceName('Studio Registry._nmos-register._tcp.local'), null);
  assert.equal(addressFromInstanceName('reg-1-2-3._nmos-register._tcp.local'), null);
});

test('an octet over 255 is rejected instead of producing a bogus address', () => {
  assert.equal(addressFromInstanceName('reg_192-168-300-1_8010._nmos-register._tcp.local'), null);
});

test('an address recovered from the name is marked as a guess', () => {
  const c = buildCandidate('reg_10-1-2-3_8010._x._tcp.local', 'h.local', 8010, TXT, 0, 'mdns', '_x._tcp', 'local', '10.1.2.3', 'instance-name');
  assert.equal(c.addressSource, 'instance-name');
  assert.equal(c.url, 'http://10.1.2.3:8010');
});

test('an address from a real A record is marked as such', () => {
  const c = buildCandidate('x', 'h.local', 8010, TXT, 0, 'mdns', '_x._tcp', 'local', '10.1.2.3');
  assert.equal(c.addressSource, 'a-record');
});

test('a .local target is replaced by its address — .local is unresolvable from here', () => {
  const c = buildCandidate('reg._nmos-register._tcp.local', 'registrar1.local', 8010, TXT, 0, 'mdns', '_nmos-register._tcp', 'local', '192.168.11.100');
  assert.equal(c.url, 'http://192.168.11.100:8010');
  assert.equal(c.host, 'registrar1.local', 'the announced name is kept for display');
  assert.equal(c.address, '192.168.11.100');
});

test('without an A record the .local name is kept, so the failure is visible', () => {
  const c = buildCandidate('reg._nmos-register._tcp.local', 'registrar1.local', 8010, TXT, 0, 'mdns', '_nmos-register._tcp', 'local', null);
  assert.equal(c.url, 'http://registrar1.local:8010');
  assert.equal(c.address, null);
});

test('a routable unicast target is used as announced', () => {
  const c = buildCandidate('reg._nmos-register._tcp.studio.example', 'registry.studio.example', 8010, TXT, 0, 'unicast', '_nmos-register._tcp', 'studio.example');
  assert.equal(c.url, 'http://registry.studio.example:8010');
});

test('api_proto drives the scheme and the default port is omitted', () => {
  const c = buildCandidate('x', 'registry.example', 443, { ...TXT, api_proto: 'https' }, 0, 'unicast', '_nmos-register._tcp', 'example');
  assert.equal(c.url, 'https://registry.example');
  assert.equal(c.proto, 'https');
});

test('TXT pri wins over the SRV priority, and api_ver is parsed', () => {
  const c = buildCandidate('x', 'h', 80, { ...TXT, pri: '5' }, 42, 'unicast', '_nmos-register._tcp', 'example');
  assert.equal(c.priority, 5);
  assert.deepEqual(c.versions, ['v1.2', 'v1.3']);
});

test('without pri the SRV priority is used', () => {
  const c = buildCandidate('x', 'h', 80, { api_proto: 'http' }, 42, 'unicast', '_nmos-register._tcp', 'example');
  assert.equal(c.priority, 42);
});

test('an IPv6 address is bracketed', () => {
  const c = buildCandidate('x', 'reg.local', 8010, TXT, 0, 'mdns', '_nmos-register._tcp', 'local', 'fd00::5');
  assert.equal(c.url, 'http://[fd00::5]:8010');
});

test('the same registry announced under both service types is listed once', async () => {
  // Unicast against a domain that resolves to nothing still proves the dedupe shape:
  // both service types are queried, and no duplicate survives an empty result.
  const result = await discoverRegistries({ domain: 'invalid.example', unicastOnly: true });
  assert.equal(new Set(result.found.map((f) => f.url)).size, result.found.length);
});

test('both the current and the legacy service type are queried', () => {
  assert.deepEqual(SERVICE_TYPES, ['_nmos-register._tcp', '_nmos-registration._tcp']);
});

test('without a search domain the unicast path is skipped and says so', async () => {
  const path = await resolvConf('nameserver 10.0.0.1\n');
  const result = await discoverRegistries({ resolvConfPath: path, unicastOnly: true });
  assert.deepEqual(result.found, []);
  assert.match(result.notes.join(' '), /no search domain configured/);
});

test('a domain that resolves to nothing reports the names it queried', async () => {
  const result = await discoverRegistries({
    domain: 'invalid.example',
    unicastOnly: true,
  });
  assert.deepEqual(result.found, []);
  // Both service types, so a failure shows exactly what was asked for.
  assert.deepEqual(result.tried, [
    'PTR _nmos-register._tcp.invalid.example',
    'PTR _nmos-registration._tcp.invalid.example',
  ]);
});

test('a configured domain wins over the host search list', async () => {
  const path = await resolvConf('search from-dhcp.example\n');
  const result = await discoverRegistries({ domain: 'configured.example', resolvConfPath: path, unicastOnly: true });
  assert.ok(result.tried.every((t) => t.includes('configured.example')));
  assert.ok(!result.tried.some((t) => t.includes('from-dhcp.example')));
});

test('a leading or trailing dot on the configured domain is tolerated', async () => {
  const result = await discoverRegistries({ domain: '.configured.example.', unicastOnly: true });
  assert.ok(result.tried.every((t) => t.endsWith('.configured.example')));
});
