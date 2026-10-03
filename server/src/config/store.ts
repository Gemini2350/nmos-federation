import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG, migrateRegistry, registryUrl, type AppConfig } from './schema.js';
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
      // Registries used to carry a full URL; keep those configurations working.
      this.cfg.registries = this.cfg.registries.map(migrateRegistry);
      log.info({ dir: this.dir, domains: this.cfg.domains.length, registries: this.cfg.registries.length }, 'configuration loaded');
    } catch {
      log.warn({ dir: this.dir }, 'no configuration found, using defaults');
    }
    return this.cfg;
  }

  validate(cfg: AppConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const err = (message: string) => issues.push({ level: 'error', message });

    const internal = cfg.domains.filter((d) => d.kind === 'internal');
    if (internal.length !== 1) err(`exactly one internal domain required, configured: ${internal.length}`);

    const domainIds = new Set<string>();
    for (const d of cfg.domains) {
      if (domainIds.has(d.id)) err(`duplicate domain ID ${d.id}`);
      domainIds.add(d.id);
      for (const e of validatePool(d.pool)) err(`domains.${d.id}.pool.${e.field}: ${e.message}`);
      if (cfg.nat.enabled) {
        for (const fabric of ['red', 'blue'] as const) {
          if (!d.switchInterface[fabric]) err(`domains.${d.id}: no L3 interface for fabric ${fabric}`);
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
      if (!domainIds.has(r.domainId)) err(`registries.${r.id}: unknown domain ${r.domainId}`);
      if (r.mode === 'manual') {
        if (!r.ip) err(`registries.${r.id}: IP or hostname missing`);
        if (r.port !== undefined && (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) {
          err(`registries.${r.id}: port ${r.port} is not a valid port`);
        }
        if (r.ip && !registryUrl(r)) err(`registries.${r.id}: cannot assemble a URL from ip/port`);
      }
    }

    for (const dev of cfg.devices) {
      if (!domainIds.has(dev.sourceDomain)) err(`devices.${dev.id}: unknown source domain ${dev.sourceDomain}`);
      if (!domainIds.has(dev.targetDomain)) err(`devices.${dev.id}: unknown target domain ${dev.targetDomain}`);
      if (dev.sourceDomain === dev.targetDomain) err(`devices.${dev.id}: source and target domain are the same`);
      for (const rid of dev.targetRegistries) {
        const reg = cfg.registries.find((r) => r.id === rid);
        if (!reg) err(`devices.${dev.id}: unknown registry ${rid}`);
        else if (reg.domainId !== dev.targetDomain) {
          err(`devices.${dev.id}: registry ${rid} is in domain ${reg.domainId}, not in ${dev.targetDomain}`);
        }
      }
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
    const issues = this.validate(cfg);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, 'config.json.tmp');
    await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    await rename(tmp, join(this.dir, 'config.json')); // atomic
    this.cfg = cfg;
    log.info({ warnings: issues.length }, 'configuration saved');
    return issues;
  }
}
