import { ref } from 'vue';
import type { Config, Status } from './api';

/**
 * Resolves the internal keys to the names an operator gave things.
 *
 * IDs are plain numbers now, so a view that prints one shows "1 → 2" where it used to
 * show something readable. They are keys, and keys belong in the configuration file and
 * the logs — never on screen.
 */
const domains = ref<Record<string, string>>({});
const registries = ref<Record<string, string>>({});

export function primeFromConfig(cfg: Config): void {
  domains.value = Object.fromEntries(cfg.domains.map((d) => [d.id, d.label || d.id]));
  registries.value = Object.fromEntries(cfg.registries.map((r) => [r.id, r.label || r.id]));
}

export function primeFromStatus(status: Status): void {
  domains.value = { ...domains.value, ...Object.fromEntries(status.domains.map((d) => [d.id, d.label || d.id])) };
  registries.value = { ...registries.value, ...Object.fromEntries(status.registries.map((r) => [r.id, r.label || r.id])) };
}

/** Falls back to the key itself, so a stale reference stays diagnosable. */
export const domainName = (id: string): string => domains.value[id] ?? id;
export const registryName = (id: string): string => registries.value[id] ?? id;
export const registryNames = (ids: string[]): string => ids.map(registryName).join(', ');
