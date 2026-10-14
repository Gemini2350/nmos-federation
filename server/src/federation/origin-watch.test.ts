import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { OriginWatcher, type WatchTarget, type WatchKind } from './origin-watch.js';

/** A registry's query API subscriptions: one WebSocket per resource path. */
async function startFeeds() {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  const sockets = new Map<string, { send(d: string): void }>();
  app.get<{ Params: { kind: string } }>('/ws/:kind', { websocket: true }, (socket, req) => {
    sockets.set(req.params.kind, socket);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const push = (kind: WatchKind, data: unknown[]) => sockets.get(kind)?.send(JSON.stringify({ grain_type: 'event', grain: { data } }));
  return { app, port, sockets, push };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), what);
};

test('the registry pushes changes of senders and receivers — nothing is polled', async (t) => {
  const feeds = await startFeeds();
  const targets: WatchTarget[] = [
    { registryId: 'r1', kind: 'sender', originId: 'tx1', version: '1:0' },
    { registryId: 'r1', kind: 'receiver', originId: 'rx1' },
  ];
  const events: string[] = [];
  const subscribed: string[] = [];
  const watcher = new OriginWatcher({
    targets: () => targets,
    subscribe: async (registryId, kind) => {
      subscribed.push(`${registryId}/${kind}`);
      return `ws://127.0.0.1:${feeds.port}/ws/${kind}`;
    },
    onChange: (tg, v) => events.push(`change ${tg.originId} ${v}`),
    onModified: (tg) => events.push(`modified ${tg.originId}`),
    onGone: (tg) => events.push(`gone ${tg.originId}`),
    onBack: (r) => events.push(`back ${r}`),
  });
  t.after(async () => {
    watcher.stop();
    await feeds.app.close();
  });
  watcher.sync();
  await until(() => feeds.sockets.size === 2, 'one feed for senders, one for receivers');
  assert.deepEqual(subscribed.sort(), ['r1/receiver', 'r1/sender']);

  // The registry's opening message: the current state. A baseline, not a change.
  feeds.push('sender', [{ path: 'tx1', pre: { id: 'tx1', version: '1:0' }, post: { id: 'tx1', version: '1:0' } }]);
  feeds.push('receiver', [{ path: 'rx1', pre: { id: 'rx1', version: '5:0' }, post: { id: 'rx1', version: '5:0' } }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, []);

  // The receiver's caps change: a new version — the pass is asked to run.
  feeds.push('receiver', [{ path: 'rx1', pre: { id: 'rx1', version: '5:0' }, post: { id: 'rx1', version: '6:0' } }]);
  await until(() => events.includes('modified rx1'), 'a modified receiver is reported');

  // The sender changes: its copy is told to follow, and the pass runs too.
  feeds.push('sender', [{ path: 'tx1', pre: { id: 'tx1', version: '1:0' }, post: { id: 'tx1', version: '2:0' } }]);
  await until(() => events.includes('change tx1 2:0') && events.includes('modified tx1'), 'a changed sender is followed');

  // The receiver's device goes offline.
  feeds.push('receiver', [{ path: 'rx1', pre: { id: 'rx1', version: '6:0' } }]);
  await until(() => events.includes('gone rx1'), 'its removal is reported');

  // Something appears while it is missing: maybe it is back.
  targets[1]!.missing = true;
  feeds.push('receiver', [{ path: 'rx9', post: { id: 'rx9', version: '1:0' } }]);
  await until(() => events.includes('back r1'), 'a possible return is reported');
});
