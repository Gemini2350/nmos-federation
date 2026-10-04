import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { ConfigStore } from './config/store.js';
import { registriesOf } from './config/schema.js';
import { StateStore } from './federation/state.js';
import { PoolManager } from './federation/pools.js';
import { Engine } from './federation/engine.js';
import { registerNodeApi } from './nmos/node-api.js';
import { registerRestApi } from './api/rest.js';
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
  for (const domain of cfg.domains.filter((d) => d.enabled)) {
    const app = Fastify({ logger: false });
    registerNodeApi(app, domain, engine, state);
    // If two domains share an IP (lab setup), the configured port is already
    // taken. Take the next free one and set the href accordingly — better than
    // leaving a domain without a node API.
    let bound = false;
    let lastError: Error | null = null;
    for (let offset = 0; offset < 10 && !bound; offset++) {
      const port = cfg.nmosPort + offset;
      try {
        await app.listen({ host: domain.iface.address, port });
        engine.setDomainPort(domain.id, port);
        nmosApps.push(app);
        bound = true;
        log.info(
          { domain: domain.id, address: `${domain.iface.address}:${port}`, ...(offset ? { note: 'configured port was taken' } : {}) },
          'node API bound',
        );
      } catch (e) {
        lastError = e as Error;
        if ((e as { code?: string }).code !== 'EADDRINUSE') {
          log.error({ domain: domain.id, address: domain.iface.address, err: String(e) }, 'node API could not bind');
          break;
        }
      }
    }
    if (!bound) {
      const code = (lastError as { code?: string } | null)?.code;
      const reason =
        code === 'EADDRNOTAVAIL'
          ? `${domain.iface.address} is not an address of this host`
          : (lastError?.message ?? 'could not bind');
      engine.markNodeApiUnavailable(domain.id, reason);
      log.error({ domain: domain.id, address: domain.iface.address, reason }, 'node API could not bind — domain stays without an API');
      await app.close();
    }
  }

  // --- GUI + REST ----------------------------------------------------------
  const gui = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
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
