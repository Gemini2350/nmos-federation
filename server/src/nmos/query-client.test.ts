import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { QueryClient, REQUESTED_PAGE_LIMIT } from './query-client.js';
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

/**
 * Like nmos-cpp: a default page of 10, a requested paging.limit honoured up to the
 * registry's own maximum, and the applied value reported in X-Paging-Limit. `maxLimit`
 * defaults to 10 so the walk itself stays exercised; `rejectLimit` simulates a registry
 * that answers an unwanted limit with 400 instead of capping it.
 */
async function startPagingStub(
  opts: { total?: number; limitHeader?: boolean; maxLimit?: number; rejectLimit?: boolean; linkNextOnNewest?: boolean } = {},
): Promise<PagingStub> {
  const total = opts.total ?? TOTAL;
  const maxLimit = opts.maxLimit ?? LIMIT;
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
    if (hasLimitParam && opts.rejectLimit) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"code":400,"error":"paging.limit not accepted"}');
    }
    const requested = hasLimitParam ? Number(url.searchParams.get('paging.limit')) : LIMIT;
    const applied = Math.min(requested, maxLimit);

    let pool = descending;
    if (until) pool = descending.filter((r) => vnum(r.version) <= vnum(until)); // inclusive on purpose
    else if (since) pool = descending.filter((r) => vnum(r.version) >= vnum(since));

    const page = pool.slice(0, applied);
    const oldestInPage = page.length ? page[page.length - 1]!.version : '0:0';
    const newestInPage = page.length ? page[0]!.version : '0:0';
    const olderExist = pool.length > page.length;
    const newerExist = page.length ? vnum(page[0]!.version) < vnum(descending[0]!.version) : false;

    const rels: string[] = [];
    if (olderExist) rels.push('prev');
    if (newerExist || (opts.linkNextOnNewest && !until && !since)) rels.push('next');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.limitHeader !== false) headers['x-paging-limit'] = String(applied);
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

test('no request goes out without a limit, so a bogus parameterless cursor never appears', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  await new QueryClient(stub.cfg).getAll('senders');
  assert.ok(stub.queries.length > 0);
  for (const q of stub.queries) {
    assert.match(q, new RegExp(`paging\\.limit=${REQUESTED_PAGE_LIMIT}`), `request without the large limit: "${q}"`);
  }
});

test('a registry that allows larger pages answers the whole collection in one request', async (t) => {
  // nmos-cpp caps at 100: everything here fits, so there is nothing to walk.
  const stub = await startPagingStub({ maxLimit: 100 });
  t.after(() => stub.server.close());
  const result = await new QueryClient(stub.cfg).getAll<{ id: string }>('senders');
  assert.equal(result.items.length, TOTAL);
  assert.equal(result.limit, 100, 'the applied limit is what the registry reports, not what we asked for');
  assert.equal(stub.queries.length, 1, `expected one request, got ${stub.queries.length}: ${stub.queries.join(' | ')}`);
});

test('the newest page is not followed forwards, even when the registry links rel="next"', async (t) => {
  // nmos-cpp links rel="next" on the newest page; following it always returned nothing.
  const stub = await startPagingStub({ maxLimit: 100, linkNextOnNewest: true });
  t.after(() => stub.server.close());
  await new QueryClient(stub.cfg).getAll('senders');
  assert.ok(stub.queries.every((q) => !q.includes('paging.since')), `walked forwards: ${stub.queries.join(' | ')}`);
  assert.equal(stub.queries.length, 1);
});

test('a registry that rejects the limit is asked again without one', async (t) => {
  const stub = await startPagingStub({ total: 6, rejectLimit: true });
  t.after(() => stub.server.close());
  const client = new QueryClient(stub.cfg);
  const result = await client.getAll<{ id: string }>('senders');
  assert.equal(result.items.length, 6);
  // And it remembers: the next collection does not try the limit again.
  stub.queries.length = 0;
  await client.getAll('senders');
  assert.ok(stub.queries.every((q) => !q.includes('paging.limit')));
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

test('a DNS-SD registry is browsed at the address discovery found for it', async (t) => {
  const stub = await startPagingStub({ total: 3 });
  t.after(() => stub.server.close());
  // No ip/port at all — exactly the shape of a discovered registry, which used to fail
  // with "no IP configured" because the query client only ever looked at ip/port.
  const cfg: RegistryConfig = { ...stub.cfg, mode: 'dnssd', ip: undefined, port: undefined };
  const resolved = `http://${stub.cfg.ip}:${stub.cfg.port}`;
  const client = new QueryClient(cfg, async () => resolved);
  assert.equal(await client.base(), `${resolved}/x-nmos/query/v1.3`);
  assert.equal((await client.getAll('senders')).items.length, 3);
});

test('a DNS-SD registry without a resolver says so instead of blaming a missing IP', async (t) => {
  const stub = await startPagingStub({ total: 1 });
  t.after(() => stub.server.close());
  const client = new QueryClient({ ...stub.cfg, mode: 'dnssd', ip: undefined, port: undefined });
  await assert.rejects(() => client.base(), /no resolver available/);
});

test('queryPort overrides the port, for a registry that does not share one', async (t) => {
  const stub = await startPagingStub({ total: 1 });
  t.after(() => stub.server.close());
  const manual = new QueryClient({ ...stub.cfg, queryPort: 4242 });
  assert.equal(await manual.base(), 'http://127.0.0.1:4242/x-nmos/query/v1.3');
  const discovered = new QueryClient(
    { ...stub.cfg, mode: 'dnssd', ip: undefined, port: undefined, queryPort: 4242 },
    async () => 'http://registry.example:8010',
  );
  assert.equal(await discovered.base(), 'http://registry.example:4242/x-nmos/query/v1.3');
});

test('a failing collection surfaces the status instead of an empty list', async (t) => {
  const stub = await startPagingStub();
  t.after(() => stub.server.close());
  await assert.rejects(() => new QueryClient(stub.cfg).getAll('flows'), /HTTP 404/);
});
