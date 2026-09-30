import type { Fabric } from '../types.js';

/** IPv4 <-> uint32. Wirft bei allem, was keine dotted-quad ist. */
export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error(`keine IPv4-Adresse: ${ip}`);
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new Error(`keine IPv4-Adresse: ${ip}`);
    const n = Number(p);
    if (n > 255) throw new Error(`keine IPv4-Adresse: ${ip}`);
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
  /** Erste Adresse des Pools. Muss gerade sein — sie ist die blue-Adresse von Pärchen 0. */
  base: string;
  /** Anzahl Pärchen; belegt werden 2 * pairs Adressen. */
  pairs: number;
  /** Basisadressen für Source-NAT je Fabric, oder null wenn nur die Gruppe übersetzt wird. */
  sourceNat: Record<Fabric, string> | null;
}

export interface PoolValidationError {
  field: string;
  message: string;
}

/** Prüft eine Pool-Konfiguration, bevor sie gespeichert wird. */
export function validatePool(cfg: PoolConfig): PoolValidationError[] {
  const errors: PoolValidationError[] = [];
  let base: number | null = null;
  try {
    base = ipToInt(cfg.base);
    if (!isMulticast(cfg.base)) {
      errors.push({ field: 'base', message: 'Pool-Basis ist keine Multicast-Adresse (224.0.0.0/4)' });
    }
    if (base % 2 !== 0) {
      errors.push({ field: 'base', message: 'Pool-Basis muss gerade sein (gerade = blue, ungerade = red)' });
    }
  } catch (e) {
    errors.push({ field: 'base', message: (e as Error).message });
  }
  if (!Number.isInteger(cfg.pairs) || cfg.pairs < 1) {
    errors.push({ field: 'pairs', message: 'Anzahl Pärchen muss mindestens 1 sein' });
  }
  if (base !== null && Number.isInteger(cfg.pairs) && cfg.pairs > 0) {
    if (base + cfg.pairs * 2 - 1 > ipToInt('239.255.255.255')) {
      errors.push({ field: 'pairs', message: 'Pool läuft über den Multicast-Bereich hinaus' });
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

/** Adressbereich eines Pools als [erste, letzte] uint32 — für Überlappungsprüfung. */
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
  /** Index des Pärchens; blue = base+2i, red = base+2i+1. */
  index: number;
  groups: Record<Fabric, string>;
  /** Übersetzte Quelladressen, nur bei aktivem Source-NAT. */
  sources: Record<Fabric, string> | null;
}

/**
 * Vergibt Adress-Pärchen aus dem Federation-Pool **einer Domäne**.
 *
 * Regel aus dem Konzept: immer paarweise reservieren, auch wenn die Quelle kein
 * ST 2022-7 macht. Gerade Adresse = blue, ungerade = red.
 */
export class PoolAllocator {
  readonly cfg: PoolConfig;
  private readonly baseInt: number;
  private readonly taken = new Set<number>();

  constructor(cfg: PoolConfig) {
    const errors = validatePool(cfg);
    if (errors.length) {
      throw new Error(`ungültige Pool-Konfiguration: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    }
    this.cfg = cfg;
    this.baseInt = ipToInt(cfg.base);
  }

  /** Adressen eines Pärchens, unabhängig davon ob es belegt ist. */
  pairAt(index: number): PoolPair {
    if (index < 0 || index >= this.cfg.pairs) throw new Error(`Pärchen-Index ${index} liegt außerhalb des Pools`);
    const blue = this.baseInt + index * 2;
    const sources = this.cfg.sourceNat
      ? {
          red: intToIp(ipToInt(this.cfg.sourceNat.red) + index),
          blue: intToIp(ipToInt(this.cfg.sourceNat.blue) + index),
        }
      : null;
    return { index, groups: { blue: intToIp(blue), red: intToIp(blue + 1) }, sources };
  }

  /** Nimmt das niedrigste freie Pärchen — "die nächste freie Adresse". */
  allocate(): PoolPair {
    for (let i = 0; i < this.cfg.pairs; i++) {
      if (!this.taken.has(i)) {
        this.taken.add(i);
        return this.pairAt(i);
      }
    }
    throw new Error(`Federation-Pool erschöpft (${this.cfg.pairs} Pärchen belegt)`);
  }

  /** Belegt ein bestimmtes Pärchen — für Recovery aus dem persistierten State. */
  reserve(index: number): PoolPair {
    if (this.taken.has(index)) throw new Error(`Pärchen-Index ${index} ist bereits belegt`);
    const pair = this.pairAt(index);
    this.taken.add(index);
    return pair;
  }

  /** Gibt das komplette Pärchen zurück. Doppelte Freigabe ist harmlos. */
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
 * NAT-Group-Nummern gelten pro Switch, nicht pro Domäne — mehrere Ziel-Domänen
 * teilen sich dieselben zwei Switches. Deshalb ein Allokator für alle Domänen.
 */
export class NatGroupAllocator {
  private readonly taken = new Set<number>();

  constructor(private readonly range: [number, number]) {
    if (range[1] < range[0]) throw new Error(`ungültiger NAT-Group-Bereich ${range.join('..')}`);
  }

  allocate(): number {
    for (let id = this.range[0]; id <= this.range[1]; id++) {
      if (!this.taken.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
    throw new Error(`NAT-Group-Bereich ${this.range.join('..')} erschöpft`);
  }

  reserve(id: number): number {
    if (id < this.range[0] || id > this.range[1]) {
      throw new Error(`NAT-Group ${id} liegt außerhalb von ${this.range.join('..')}`);
    }
    if (this.taken.has(id)) throw new Error(`NAT-Group ${id} ist bereits belegt`);
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
