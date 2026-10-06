import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { ConfigStore } from './config/store.js';
import { registriesOf, type DomainConfig } from './config/schema.js';
import { StateStore } from './federation/state.js';
import { PoolManager } from './federation/pools.js';
import { Engine } from './federation/engine.js';
import { registerNodeApi } from './nmos/node-api.js';
import { registerRestApi } from './api/rest.js';
import { acceptEmptyJson } from './api/http.js';
import { AristaEapiDriver } from './switch/arista-eapi.js';
import { MockSwitchDriver } from './switch/mock.js';
import type { SwitchDriver } from './switch/driver.js';
import { FABRICS } from './types.js';
import { log } from './util/log.js';

const here = dirname(fileURLToPath(import.meta.url));


async function main() {
  const store = new ConfigStore();
  const cfg = await store.load();
  for (const issue of store.validate(cfg)) {
    (issue.level === 'error' ? log.error : log.warn)({}, `configuration: ${issue.message}`);
  }

  const state = new StateStore();
  await state.load();

  const drivers: Record<string, SwitchDriver> = {};
  for (const fabric of FABRICS) {
    const sw = cfg.nat.switches[fabric];
    drivers[fabric] = cfg.nat.driver === 'arista-eapi' ? new AristaEapiDriver(fabric, sw) : new MockSwitchDriver(fabric, sw);
  }

  const buildDrivers = (): Record<string, SwitchDriver> => {
    const out: Record<string, SwitchDriver> = {};
    for (const fabric of FABRICS) {
      const sw = store.current.nat.switches[fabric];
      out[fabric] = store.current.nat.driver === 'arista-eapi' ? new AristaEapiDriver(fabric, sw) : new MockSwitchDriver(fabric, sw);
    }
    return out;
  };

  const pools = new PoolManager(cfg.domains, cfg.nat.groupIdRange);
  const engine = new Engine({ config: () => store.current, state, pools, drivers });

  // --- NMOS APIs: one listener per domain on that domain's IP ---------------
  const nmosApps: FastifyInstance[] = [];
  /** Domains whose address is not (yet) on this host, retried until it is. */
  const waitingForAddress = new Map<string, DomainConfig>();

  const bindNodeApi = async (domain: DomainConfig): Promise<void> => {
    // Controllers differ in whether they add or strip a trailing slash, and the hrefs
    // we publish must resolve either way — see nmos/node-api.ts.
    const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });
    acceptEmptyJson(app);
    registerNodeApi(app, domain, engine, state);
    // If two domains share an IP (lab setup), the configured port is already
    // taken. Take the next free one and set the href accordingly — better than
    // leaving a domain without a node API.
    let lastError: Error | null = null;
    for (let offset = 0; offset < 10; offset++) {
      const port = cfg.nmosPort + offset;
      try {
        await app.listen({ host: domain.iface.address, port });
        engine.setDomainPort(domain.id, port);
        nmosApps.push(app);
        waitingForAddress.delete(domain.id);
        log.info(
          { domain: domain.id, address: `${domain.iface.address}:${port}`, ...(offset ? { note: 'configured port was taken' } : {}) },
          'node API bound',
        );
        return;
      } catch (e) {
        lastError = e as Error;
        if ((e as { code?: string }).code !== 'EADDRINUSE') break;
      }
    }
    await app.close();
    const code = (lastError as { code?: string } | null)?.code;
    if (code === 'EADDRNOTAVAIL') {
      // Typically a boot race: Docker starts the container before DHCP has handed the
      // interface its address. Binding once and giving up left the domain without a
      // node API until someone restarted the container by hand.
      engine.markNodeApiUnavailable(domain.id, `${domain.iface.address} is not an address of this host (yet) — retrying`);
      if (!waitingForAddress.has(domain.id)) {
        log.warn({ domain: domain.id, address: domain.iface.address }, 'address not on this host — node API retries until it appears');
      }
      waitingForAddress.set(domain.id, domain);
      return;
    }
    const reason = lastError?.message ?? 'could not bind';
    engine.markNodeApiUnavailable(domain.id, reason);
    log.error({ domain: domain.id, address: domain.iface.address, reason }, 'node API could not bind — domain stays without an API');
  };

  for (const domain of cfg.domains.filter((d) => d.enabled)) await bindNodeApi(domain);

  const ADDRESS_RETRY_MS = 5_000;
  let retrying = false;
  const addressRetry = setInterval(async () => {
    if (retrying || waitingForAddress.size === 0) return;
    retrying = true;
    try {
      const before = waitingForAddress.size;
      // In configuration order, so domains sharing an address get the same ports as
      // they would have at a clean start.
      for (const domain of [...waitingForAddress.values()]) await bindNodeApi(domain);
      // The published hrefs carry the bound port, which may differ from the default —
      // re-register so the registries point at a listener that exists.
      if (waitingForAddress.size < before) await engine.syncRegistries();
    } catch (e) {
      log.error({ err: String(e) }, 'node API retry failed');
    } finally {
      retrying = false;
    }
  }, ADDRESS_RETRY_MS);
  addressRetry.unref();

  // --- GUI + REST ----------------------------------------------------------
  const gui = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, routerOptions: { ignoreTrailingSlash: true } });
  acceptEmptyJson(gui);
  await gui.register(fastifyWebsocket);
  registerRestApi(gui, store, engine, state, async () => {
    // Configuration changes take effect immediately: rebuild the drivers (hosts and
    // credentials), rebuild the pools only while nothing is running — live
    // reservations must not vanish.
    engine.setDrivers(buildDrivers());
    if (engine.channels().length === 0) {
      engine.setPools(new PoolManager(store.current.domains, store.current.nat.groupIdRange));
    } else {
      log.warn({ channels: engine.channels().length }, 'pool changes take effect once no channel is active any more');
    }
    await engine.restartRegistries();
  });
  const uiDir = join(here, '..', 'public');
  if (existsSync(uiDir)) {
    await gui.register(fastifyStatic, { root: uiDir });
    gui.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'unknown endpoint' });
      return reply.sendFile('index.html');
    });
  }
  await gui.listen({ host: '0.0.0.0', port: cfg.port });

  await engine.start();

  log.info(
    {
      gui: `http://0.0.0.0:${cfg.port}`,
      nmosPort: cfg.nmosPort,
      driver: cfg.nat.driver,
      nat: cfg.nat.enabled,
      domains: cfg.domains.map((d) => ({ id: d.id, kind: d.kind, registries: registriesOf(cfg, d.id).map((r) => r.id) })),
      channels: engine.channels().length,
    },
    'nmos-federation running',
  );

  const shutdown = async () => {
    log.info({}, 'shutting down');
    clearInterval(addressRetry);
    await engine.stop();
    await Promise.allSettled([gui.close(), ...nmosApps.map((a) => a.close())]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'startup failed');
  process.exit(1);
});
