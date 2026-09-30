import type { Fabric } from '../types.js';

/** IPv4 <-> uint32. Throws on anything that is not a dotted quad. */
export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${ip}`);
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new Error(`not an IPv4 address: ${ip}`);
    const n = Number(p);
    if (n > 255) throw new Error(`not an IPv4 address: ${ip}`);
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isMulticast(ip: string): boolean {
  return ((ipToInt(ip) >>> 24) & 0xf0) === 0xe0; // 224.0.0.0/4
}

export interface PoolConfig {
  /** First address of the pool. Must be even — it is pair 0's blue address. */
  base: string;
  /** Number of pairs; 2 * pairs addresses are consumed. */
  pairs: number;
  /** Source NAT base address per fabric, or null when only the group is translated. */
  sourceNat: Record<Fabric, string> | null;
}

export interface PoolValidationError {
  field: string;
  message: string;
}

/** Validates a pool configuration before it is saved. */
export function validatePool(cfg: PoolConfig): PoolValidationError[] {
  const errors: PoolValidationError[] = [];
  let base: number | null = null;
  try {
    base = ipToInt(cfg.base);
    if (!isMulticast(cfg.base)) {
      errors.push({ field: 'base', message: 'pool base is not a multicast address (224.0.0.0/4)' });
    }
    if (base % 2 !== 0) {
      errors.push({ field: 'base', message: 'pool base must be even (even = blue, odd = red)' });
    }
  } catch (e) {
    errors.push({ field: 'base', message: (e as Error).message });
  }
  if (!Number.isInteger(cfg.pairs) || cfg.pairs < 1) {
    errors.push({ field: 'pairs', message: 'pair count must be at least 1' });
  }
  if (base !== null && Number.isInteger(cfg.pairs) && cfg.pairs > 0) {
    if (base + cfg.pairs * 2 - 1 > ipToInt('239.255.255.255')) {
      errors.push({ field: 'pairs', message: 'pool runs past the end of the multicast range' });
    }
  }
  if (cfg.sourceNat) {
    for (const f of ['red', 'blue'] as Fabric[]) {
      try {
        ipToInt(cfg.sourceNat[f]);
      } catch (e) {
        errors.push({ field: `sourceNat.${f}`, message: (e as Error).message });
      }
    }
  }
  return errors;
}

/** A pool's address range as [first, last] uint32 — for overlap checks. */
export function poolRange(cfg: PoolConfig): [number, number] {
  const base = ipToInt(cfg.base);
  return [base, base + cfg.pairs * 2 - 1];
}

export function poolsOverlap(a: PoolConfig, b: PoolConfig): boolean {
  const [aStart, aEnd] = poolRange(a);
  const [bStart, bEnd] = poolRange(b);
  return aStart <= bEnd && bStart <= aEnd;
}

export interface PoolPair {
  /** Index of the pair; blue = base+2i, red = base+2i+1. */
  index: number;
  groups: Record<Fabric, string>;
  /** Translated source addresses, only with source NAT enabled. */
  sources: Record<Fabric, string> | null;
}

/**
 * Hands out address pairs from **one domain's** federation pool.
 *
 * Rule from the concept: always reserve in pairs, even when the source is not
 * ST 2022-7 redundant. Even address = blue, odd = red.
 */
export class PoolAllocator {
  readonly cfg: PoolConfig;
  private readonly baseInt: number;
  private readonly taken = new Set<number>();

  constructor(cfg: PoolConfig) {
    const errors = validatePool(cfg);
    if (errors.length) {
      throw new Error(`invalid pool configuration: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    }
    this.cfg = cfg;
    this.baseInt = ipToInt(cfg.base);
  }

  /** A pair's addresses, whether or not it is taken. */
  pairAt(index: number): PoolPair {
    if (index < 0 || index >= this.cfg.pairs) throw new Error(`pair index ${index} is outside the pool`);
    const blue = this.baseInt + index * 2;
    const sources = this.cfg.sourceNat
      ? {
          red: intToIp(ipToInt(this.cfg.sourceNat.red) + index),
          blue: intToIp(ipToInt(this.cfg.sourceNat.blue) + index),
        }
      : null;
    return { index, groups: { blue: intToIp(blue), red: intToIp(blue + 1) }, sources };
  }

  /** Takes the lowest free pair — "the next free address". */
  allocate(): PoolPair {
    for (let i = 0; i < this.cfg.pairs; i++) {
      if (!this.taken.has(i)) {
        this.taken.add(i);
        return this.pairAt(i);
      }
    }
    throw new Error(`federation pool exhausted (${this.cfg.pairs} pairs in use)`);
  }

  /** Takes a specific pair — used when recovering from persisted state. */
  reserve(index: number): PoolPair {
    if (this.taken.has(index)) throw new Error(`pair index ${index} is already taken`);
    const pair = this.pairAt(index);
    this.taken.add(index);
    return pair;
  }

  /** Returns the whole pair. Releasing twice is harmless. */
  release(index: number): void {
    this.taken.delete(index);
  }

  get usedIndices(): number[] {
    return [...this.taken].sort((a, b) => a - b);
  }

  get free(): number {
    return this.cfg.pairs - this.taken.size;
  }
}

/**
 * NAT group numbers are per switch, not per domain — several target domains share
 * the same two switches. Hence one allocator across all domains.
 */
export class NatGroupAllocator {
  private readonly taken = new Set<number>();

  constructor(private readonly range: [number, number]) {
    if (range[1] < range[0]) throw new Error(`invalid NAT group range ${range.join('..')}`);
  }

  allocate(): number {
    for (let id = this.range[0]; id <= this.range[1]; id++) {
      if (!this.taken.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
    throw new Error(`NAT group range ${this.range.join('..')} exhausted`);
  }

  reserve(id: number): number {
    if (id < this.range[0] || id > this.range[1]) {
      throw new Error(`NAT group ${id} is outside ${this.range.join('..')}`);
    }
    if (this.taken.has(id)) throw new Error(`NAT group ${id} is already taken`);
    this.taken.add(id);
    return id;
  }

  release(id: number): void {
    this.taken.delete(id);
  }

  get used(): number[] {
    return [...this.taken].sort((a, b) => a - b);
  }
}
