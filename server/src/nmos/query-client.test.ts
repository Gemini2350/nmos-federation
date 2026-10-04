import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { QueryClient } from './query-client.js';
import type { RegistryConfig } from '../config/schema.js';

/**
 * A registry that behaves like the awkward ones found in the field:
 *  - caps a page at 10 and advertises that in X-Paging-Limit
 *  - serves most-recently-updated first, descending
 *  - returns a self-contradictory `X-Paging-Since: 0:0` for a parameterless request,
 *    and the correct cursor as soon as paging.limit is stated
 *  - emits a MALFORMED Link header, missing the `?` before its query string
 *  - treats the cursor as inclusive, so the boundary resource repeats on the next page
 */
interface PagingStub {
  server: Server;
  cfg: RegistryConfig;
  /** Raw query strings as received, to check cursor encoding. */
  queries: string[];
}

const TOTAL = 25;
const LIMIT = 10;

async function startPagingStub(opts: { total?: number; limitHeader?: boolean } = {}): Promise<PagingStub> {
  const total = opts.total ?? TOTAL;
  // Oldest first in storage; version 1000:0 .. 1000+total-1:0
  const all = Array.from({ length: total }, (_, i) => ({
    id: `s${String(i + 1).padStart(2, '0')}`,
    label: `Sender ${i + 1}`,
    version: `${1000 + i}:0`,
  }));
  const vnum = (v: string) => Number(v.split(':')[0]);
  const descending = [...all].sort((a, b) => vnum(b.version) - vnum(a.version));
  const queries: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    queries.push(url.search.replace(/^\?/, ''));
    if (!url.pathname.endsWith('/senders')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('[]');
    }
    const until = url.searchParams.get('paging.until');
    const since = url.searchParams.get('paging.since');
    const hasLimitParam = url.searchParams.has('paging.limit');

    let pool = descending;
    if (until) pool = descending.filter((r) => vnum(r.version) <= vnum(until)); // inclusive on purpose
    else if (since) pool = descending.filter((r) => vnum(r.version) >= vnum(since));

    const page = pool.slice(0, LIMIT);
    const oldestInPage = page.length ? page[page.length - 1]!.version : '0:0';
    const newestInPage = page.length ? page[0]!.version : '0:0';
    const olderExist = pool.length > page.length;
    const newerExist = page.length ? vnum(page[0]!.version) < vnum(descending[0]!.version) : false;

    const rels: string[] = [];
    if (olderExist) rels.push('prev');
    if (newerExist) rels.push('next');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.limitHeader !== false) headers['x-paging-limit'] = String(LIMIT);
    // The bogus cursor only appears when no paging parameter was given at all.
    headers['x-paging-since'] = !hasLimitParam && !until && !since ? '0:0' : oldestInPage;
    headers['x-paging-until'] = newestInPage;
    if (rels.length) {
      // Malformed on purpose: no "?" before the query string. Following this 404s.
      headers['link'] = rels.map((r) => `</x-nmos/query/v1.3/senderspaging.until=${oldestInPage}>; rel="${r}"`).join(', ');
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(page));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    queries,
    cfg: {
      id: 'stub',
      label: 'stub',
      domainId: 'internal',
      mode: 'manual',
      ip: '127.0.0.1',
      port,
      version: 'v1.3',
      enabled: true,
    },
  };
}

test('a capped page does not truncate the result — everything is collected', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());

  // Prove the stub really caps, so the assertion below cannot pass vacuously:
  // a single plain GET — what this client used to do — sees only one page.
  const plain = (await (await fetch(`http://${stub.cfg.ip}:${stub.cfg.port}/x-nmos/query/v1.3/senders`)).json()) as unknown[];
  assert.equal(plain.length, LIMIT, 'the stub must cap a plain GET');

  const result = await new QueryClient(stub.cfg).getAll<{ id: string }>('senders');
  assert.equal(result.limit, LIMIT);
  assert.equal(result.items.length, TOTAL, `expected all ${TOTAL}, a single page would give ${LIMIT}`);
  assert.equal(new Set(result.items.map((i) => i.id)).size, TOTAL);
  assert.equal(result.truncated, false);
});

test('the oldest resources are found, which only the prev direction reaches', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  const { items } = await new QueryClient(stub.cfg).getAll<{ id: string }>('senders');
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('s01'), 'the oldest resource must be in the list');
  assert.ok(ids.includes('s25'), 'and the newest too');
});

test('an inclusive cursor repeating the boundary resource does not duplicate it', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  const { items, pages } = await new QueryClient(stub.cfg).getAll<{ id: string }>('senders');
  assert.ok(pages >= 3, `expected several pages, got ${pages}`);
  // The stub serves the cursor inclusively, so s16 and s07 come twice over the wire.
  assert.equal(items.filter((i) => i.id === 's16').length, 1);
  assert.equal(items.filter((i) => i.id === 's07').length, 1);
});

test('cursors are sent unencoded — a percent-encoded colon breaks a real registry', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  await new QueryClient(stub.cfg).getAll('senders');
  const withCursor = stub.queries.filter((q) => q.includes('paging.until=') || q.includes('paging.since='));
  assert.ok(withCursor.length, 'the walk must have used a cursor');
  for (const q of withCursor) {
    assert.ok(!q.includes('%3A'), `cursor was percent-encoded: ${q}`);
    assert.match(q, /paging\.(until|since)=\d+:\d+/);
  }
});

test('the limit is restated on every request, so a bogus parameterless cursor is bypassed', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  await new QueryClient(stub.cfg).getAll('senders');
  // The first request is the bare probe; everything after it carries paging.limit.
  assert.equal(stub.queries[0], '');
  for (const q of stub.queries.slice(1)) assert.match(q, /paging\.limit=10/);
});

test('a registry without a page limit still works in one request', async (t) => {
  const stub = await startPagingStub({ total: 4, limitHeader: false });
  t.after(() => stub.server.close());
  const result = await new QueryClient(stub.cfg).getAll<{ id: string }>('senders');
  assert.equal(result.limit, null);
  assert.equal(result.items.length, 4);
});

test('an empty collection is not an error', async (t) => {
  const stub = await startPagingStub({ total: 0 });
  t.after(() => stub.server.close());
  const result = await new QueryClient(stub.cfg).getAll('senders');
  assert.deepEqual(result.items, []);
});

test('a failing collection surfaces the status instead of an empty list', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  await assert.rejects(() => new QueryClient(stub.cfg).getAll('flows'), /HTTP 404/);
});
