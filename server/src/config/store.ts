import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG, migrateRegistry, normalizeConfig, registryUrl, type AppConfig } from './schema.js';
import { listInterfaces } from '../nmos/resources.js';
import { validatePool } from '../federation/pool.js';
import { overlappingPools } from '../federation/pools.js';
import { log } from '../util/log.js';

const DEFAULT_DIR = process.env.CONFIG_DIR ?? './config';

export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
}

/** Configuration and runtime state are kept apart so that resetting the settings
 *  does not take the channel bookkeeping with it. */
export class ConfigStore {
  private cfg: AppConfig = structuredClone(DEFAULT_CONFIG);

  /** Directory for config.json; overridable in tests. */
  constructor(private readonly dir: string = DEFAULT_DIR) {}

  get current(): AppConfig {
    return this.cfg;
  }

  async load(): Promise<AppConfig> {
    try {
      const raw = await readFile(join(this.dir, 'config.json'), 'utf8');
      this.cfg = { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(raw) };
      // Older files: registries carried a full URL, domains carried fields that are gone.
      this.cfg.registries = this.cfg.registries.map(migrateRegistry);
      normalizeConfig(this.cfg);
      log.info({ dir: this.dir, domains: this.cfg.domains.length, registries: this.cfg.registries.length }, 'configuration loaded');
    } catch {
      // First start: the default 127.0.0.1 would publish a node href no controller can
      // reach. Pick an address this host actually holds instead.
      const host = listInterfaces().find((i) => !i.internal);
      if (host) {
        const internal = this.cfg.domains.find((d) => d.kind === 'internal');
        if (internal) internal.iface = { name: host.name, address: host.address };
      }
      log.warn(
        { dir: this.dir, ...(host ? { address: `${host.name} ${host.address}` } : {}) },
        'no configuration found, using defaults',
      );
    }
    return this.cfg;
  }

  /** Back to defaults, including the first-start address detection. */
  async reset(): Promise<AppConfig> {
    this.cfg = structuredClone(DEFAULT_CONFIG);
    const host = listInterfaces().find((i) => !i.internal);
    const internal = this.cfg.domains.find((d) => d.kind === 'internal');
    if (host && internal) internal.iface = { name: host.name, address: host.address };
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, 'config.json.tmp');
    await writeFile(tmp, JSON.stringify(this.cfg, null, 2), 'utf8');
    await rename(tmp, join(this.dir, 'config.json'));
    log.warn({}, 'configuration reset to defaults');
    return this.cfg;
  }

  validate(cfg: AppConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const err = (message: string) => issues.push({ level: 'error', message });
    const warn = (message: string) => issues.push({ level: 'warning', message });

    const internal = cfg.domains.filter((d) => d.kind === 'internal');
    if (internal.length !== 1) err(`exactly one internal domain required, configured: ${internal.length}`);

    const domainIds = new Set<string>();
    for (const d of cfg.domains) {
      if (domainIds.has(d.id)) err(`duplicate domain ID ${d.id}`);
      domainIds.add(d.id);
      for (const e of validatePool(d.pool)) err(`domains.${d.id}.pool.${e.field}: ${e.message}`);
      // Half-filled is not incoherent. Blocking the save would mean an operator who
      // turned NAT on cannot save anything at all — not even deleting an unrelated
      // device — until every interface is typed in. The domain simply cannot carry a
      // channel until then, and says so.
      if (cfg.nat.enabled) {
        for (const fabric of ['red', 'blue'] as const) {
          if (!d.switchInterface[fabric]) {
            warn(`domain "${d.label || d.id}": no L3 interface for fabric ${fabric} — it cannot carry a channel`);
          }
        }
      }
    }

    // Overlapping pools are harmless only with genuinely separate networks.
    for (const [a, b] of overlappingPools(cfg.domains)) {
      issues.push({ level: 'warning', message: `pools of domains ${a} and ${b} overlap — only valid if these are separate networks` });
    }

    const registryIds = new Set<string>();
    for (const r of cfg.registries) {
      if (registryIds.has(r.id)) err(`duplicate registry ID ${r.id}`);
      registryIds.add(r.id);
        if (!domainIds.has(r.domainId)) warn(`registry "${r.label || r.id}" is detached: no domain ${r.domainId}`);
      if (r.mode === 'manual') {
        const label = r.label || r.id;
        if (!r.ip) warn(`registry "${label}": no address yet — it cannot be contacted`);
        if (r.port !== undefined && (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) {
          warn(`registry "${label}": ${r.port} is not a valid port`);
        }
        if (r.ip && !registryUrl(r)) warn(`registry "${label}": cannot assemble a URL from the address and port`);
      }
    }

    // A reference that no longer resolves — because a domain or registry was renamed or
    // removed — is a WARNING, not an error. Making it an error locks the operator out:
    // every write rewrites the whole configuration, so one dangling reference would also
    // block deleting the very device that carries it. A detached device simply does not
    // register until its domain exists again.
    for (const dev of cfg.devices) {
      const name = dev.label || dev.id;
      if (!domainIds.has(dev.sourceDomain)) warn(`device "${name}" is detached: no domain ${dev.sourceDomain}`);
      if (!domainIds.has(dev.targetDomain)) warn(`device "${name}" is detached: no domain ${dev.targetDomain}`);
      if (dev.sourceDomain === dev.targetDomain) err(`device "${name}": source and target domain are the same`);
      for (const rid of dev.targetRegistries) {
        const reg = cfg.registries.find((r) => r.id === rid);
        if (!reg) warn(`device "${name}": no registry ${rid} — that target is ignored`);
        else if (reg.domainId !== dev.targetDomain) {
          warn(`device "${name}": registry ${rid} is in domain ${reg.domainId}, not in ${dev.targetDomain} — that target is ignored`);
        }
      }
    }

    for (const m of cfg.mirrors) {
      if (!cfg.devices.some((d) => d.id === m.deviceId)) warn(`copy of "${m.originLabel}": its device is gone`);
      if (!registryIds.has(m.registryId)) warn(`copy of "${m.originLabel}": no registry ${m.registryId}`);
    }

    const capacity = cfg.nat.groupIdRange[1] - cfg.nat.groupIdRange[0] + 1;
    const totalPairs = cfg.domains.reduce((n, d) => n + d.pool.pairs, 0);
    if (cfg.nat.enabled && capacity < totalPairs) {
      issues.push({
        level: 'warning',
        message: `the NAT group range holds ${capacity} channels, the pools together ${totalPairs} — the group numbers are the limit`,
      });
    }

    return issues;
  }

  async save(cfg: AppConfig): Promise<ConfigIssue[]> {
    normalizeConfig(cfg);
    const issues = this.validate(cfg);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      // Only refuse what this save actually introduces. Every write rewrites the whole
      // configuration, so judging it as a whole means one unrelated problem blocks every
      // operation — including the delete that would resolve it. That is how an operator
      // ends up unable to remove a device because a different domain is half-configured.
      const existing = new Set(this.validate(this.cfg).filter((i) => i.level === 'error').map((i) => i.message));
      const introduced = errors.filter((e) => !existing.has(e.message));
      if (introduced.length) throw new Error(introduced.map((e) => e.message).join('; '));

      log.warn({ remaining: errors.length }, 'saved; pre-existing problems remain');
      issues.push({
        level: 'warning',
        message: `saved, but ${errors.length} earlier problem(s) are still there: ${errors.map((e) => e.message).join('; ')}`,
      });
    }
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, 'config.json.tmp');
    await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    await rename(tmp, join(this.dir, 'config.json')); // atomic
    this.cfg = cfg;
    log.info({ warnings: issues.length }, 'configuration saved');
    return issues;
  }
}
