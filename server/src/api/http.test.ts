import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { acceptEmptyJson } from './http.js';
import { registerRestApi } from './rest.js';
import { ConfigStore } from '../config/store.js';
import { StateStore } from '../federation/state.js';
import { PoolManager } from '../federation/pools.js';
import { Engine } from '../federation/engine.js';
import { MockSwitchDriver } from '../switch/mock.js';

/**
 * Exactly what a browser sends from a generic fetch helper: a JSON content-type on a
 * POST that carries no body. Every curl-based check skipped the header and passed,
 * while every action button in the GUI failed with 400.
 */
const browserPost = { method: 'POST' as const, headers: { 'content-type': 'application/json' }, payload: '' };

test('an empty JSON body is an empty object, not a 400', async () => {
  const app = Fastify();
  acceptEmptyJson(app);
  app.post('/x', async (req) => ({ got: req.body }));
  const res = await app.inject({ ...browserPost, url: '/x' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { got: {} });
});

test('a real JSON body is still parsed', async () => {
  const app = Fastify();
  acceptEmptyJson(app);
  app.post('/x', async (req) => ({ got: req.body }));
  const res = await app.inject({ ...browserPost, url: '/x', payload: '{"a":1}' });
  assert.deepEqual(res.json(), { got: { a: 1 } });
});

test('malformed JSON is still a 400', async () => {
  const app = Fastify();
  acceptEmptyJson(app);
  app.post('/x', async () => ({ ok: true }));
  const res = await app.inject({ ...browserPost, url: '/x', payload: '{nope' });
  assert.equal(res.statusCode, 400);
});

test('every bodyless action of the GUI answers as the browser calls it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nmos-http-'));
  const store = new ConfigStore(dir);
  await store.load();
  const state = new StateStore(dir);
  await state.load();
  const sw = { host: '', user: '', password: '', tls: true, join: 'igmpStatic' as const };
  const drivers = { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) };
  const engine = new Engine({
    config: () => store.current,
    state,
    pools: new PoolManager(store.current.domains, store.current.nat.groupIdRange),
    drivers,
  });

  const app = Fastify();
  acceptEmptyJson(app);
  await app.register(fastifyWebsocket);
  registerRestApi(app, store, engine, state, async () => undefined);
  t.after(async () => {
    await app.close();
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });

  for (const url of ['/api/reconcile', '/api/cleanup', '/api/discovery/refresh', '/api/switch/red/probe', '/api/reset']) {
    const res = await app.inject({ ...browserPost, url });
    assert.notEqual(res.statusCode, 400, `${url} answered 400: ${res.body}`);
    assert.ok(res.statusCode < 500, `${url} answered ${res.statusCode}: ${res.body}`);
  }
});

test('renames sent in quick succession all survive — writes do not overwrite each other', async (t) => {
  // Tabbing through name fields fires one PUT per field without waiting for the last.
  // Every write handler copies the configuration, changes it and saves it; run side by
  // side, each saved its own copy and only the last rename survived.
  const dir = await mkdtemp(join(tmpdir(), 'nmos-http-'));
  const store = new ConfigStore(dir);
  await store.load();
  const cfg = structuredClone(store.current);
  cfg.domains.push({ ...structuredClone(cfg.domains[0]!), id: '2', label: 'Partner', kind: 'external' });
  cfg.domains[1]!.pool.base = '239.202.0.0';
  cfg.bridges = [{ id: '1', label: 'Bridge', domains: ['1', '2'], registries: [], nat: false, enabled: true }];
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
  cfg.devices = [{ id: 'd1', label: 'D', bridgeId: '1', receiverIds: ids }];
  cfg.receivers = ids.map((id) => ({ id, label: `old ${id}`, deviceId: 'd1', format: 'video' as const, enabled: true }));
  await store.save(cfg);
  const state = new StateStore(dir);
  await state.load();
  const sw = { host: '', user: '', password: '', tls: true, join: 'igmpStatic' as const };
  const engine = new Engine({
    config: () => store.current,
    state,
    pools: new PoolManager(store.current.domains, store.current.nat.groupIdRange),
    drivers: { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) },
  });
  const app = Fastify();
  acceptEmptyJson(app);
  await app.register(fastifyWebsocket);
  // The real hook re-registers with every registry; a short await stands in for it and
  // is what widens the window in which a parallel write can slip in.
  registerRestApi(app, store, engine, state, () => new Promise((r) => setTimeout(r, 20)));
  t.after(async () => {
    await app.close();
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const results = await Promise.all(
    ids.map((id) =>
      app.inject({ method: 'PUT', url: `/api/receivers/${id}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ label: `new ${id}` }) }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200, 200, 200]);
  assert.deepEqual(store.current.receivers.map((r) => r.label), ids.map((id) => `new ${id}`));
});

test('a receiver deleted in the GUI leaves the registry too, not only the configuration', async (t) => {
  // Every settings save rebuilt the registry clients, which threw away their record of
  // what they had registered — so a removal never reached the registry and the
  // receiver stayed there, heartbeated by its node, until the next restart.
  const deletes: string[] = [];
  const reg = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'DELETE') {
        deletes.push(req.url ?? '');
        res.writeHead(204);
        return res.end();
      }
      if (req.url?.includes('/query/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('[]');
      }
      res.writeHead(req.method === 'POST' && req.url?.endsWith('/resource') ? 201 : 200, { 'content-type': 'application/json' });
      res.end(body || '{}');
    });
  });
  await new Promise<void>((r) => reg.listen(0, '127.0.0.1', r));
  const port = (reg.address() as { port: number }).port;

  const dir = await mkdtemp(join(tmpdir(), 'nmos-http-'));
  const store = new ConfigStore(dir);
  await store.load();
  const cfg = structuredClone(store.current);
  cfg.domains.push({ ...structuredClone(cfg.domains[0]!), id: '2', label: 'Partner', kind: 'external' });
  cfg.domains[1]!.pool.base = '239.202.0.0';
  cfg.registries = [{ id: '1', label: 'R', domainId: '1', mode: 'manual', ip: '127.0.0.1', port, version: 'v1.3', enabled: true }];
  cfg.bridges = [{ id: '1', label: 'Bridge', domains: ['1', '2'], registries: [], nat: false, enabled: true }];
  cfg.devices = [{ id: 'd1', label: 'D', bridgeId: '1', receiverIds: ['r1', 'r2'] }];
  cfg.receivers = ['r1', 'r2'].map((id) => ({ id, label: id, deviceId: 'd1', format: 'video' as const, enabled: true }));
  await store.save(cfg);
  const state = new StateStore(dir);
  await state.load();
  const sw = { host: '', user: '', password: '', tls: true, join: 'igmpStatic' as const };
  const engine = new Engine({
    config: () => store.current,
    state,
    pools: new PoolManager(store.current.domains, store.current.nat.groupIdRange),
    drivers: { red: new MockSwitchDriver('red', sw), blue: new MockSwitchDriver('blue', sw) },
  });
  await engine.start();
  const app = Fastify();
  acceptEmptyJson(app);
  await app.register(fastifyWebsocket);
  // Exactly what index.ts hands in after a settings change.
  registerRestApi(app, store, engine, state, () => engine.restartRegistries());
  t.after(async () => {
    await app.close();
    await engine.stop();
    reg.close();
    await rm(dir, { recursive: true, force: true });
  });

  const res = await app.inject({ method: 'DELETE', url: '/api/receivers/r1' });
  assert.equal(res.statusCode, 200);
  const r1 = engine.receiverNmosId('r1');
  assert.ok(deletes.some((u) => u.endsWith(`/receivers/${r1}`)), `not unregistered: ${deletes.join(', ') || 'no DELETE at all'}`);
  assert.ok(!deletes.some((u) => u.endsWith(`/receivers/${engine.receiverNmosId('r2')}`)), 'the other one stays');
});
