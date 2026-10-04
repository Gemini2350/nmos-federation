import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
