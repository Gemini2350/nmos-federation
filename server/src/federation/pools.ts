import type { Allocation, DomainId } from '../types.js';
import type { DomainConfig } from '../config/schema.js';
import { NatGroupAllocator, PoolAllocator, poolsOverlap } from './pool.js';

/**
 * Hält je Domäne einen Pool. Vergeben wird immer aus dem Pool der **Ziel**-Domäne:
 * die Adressen müssen im Netz gültig sein, in dem der virtuelle Sender entsteht.
 *
 * Die NAT-Group-Nummern kommen aus einem gemeinsamen Allokator — sie gelten pro
 * Switch, und alle Domänen hängen an demselben Switch-Paar.
 */
export class PoolManager {
  private readonly pools = new Map<DomainId, PoolAllocator>();
  private readonly natGroups: NatGroupAllocator;

  constructor(domains: DomainConfig[], natGroupRange: [number, number]) {
    this.natGroups = new NatGroupAllocator(natGroupRange);
    for (const d of domains) this.pools.set(d.id, new PoolAllocator(d.pool));
  }

  private poolFor(domainId: DomainId): PoolAllocator {
    const pool = this.pools.get(domainId);
    if (!pool) throw new Error(`keine Domäne ${domainId} konfiguriert`);
    return pool;
  }

  allocate(targetDomain: DomainId): Allocation {
    const pool = this.poolFor(targetDomain);
    const pair = pool.allocate();
    let natGroupId: number;
    try {
      natGroupId = this.natGroups.allocate();
    } catch (e) {
      pool.release(pair.index); // Pärchen nicht verwaisen lassen
      throw e;
    }
    return { domainId: targetDomain, ...pair, natGroupId };
  }

  /** Recovery aus dem persistierten State. */
  reserve(alloc: Allocation): Allocation {
    const pair = this.poolFor(alloc.domainId).reserve(alloc.index);
    this.natGroups.reserve(alloc.natGroupId);
    return { domainId: alloc.domainId, ...pair, natGroupId: alloc.natGroupId };
  }

  release(alloc: Allocation): void {
    this.pools.get(alloc.domainId)?.release(alloc.index);
    this.natGroups.release(alloc.natGroupId);
  }

  status(): Record<DomainId, { free: number; total: number; used: number[] }> {
    const out: Record<DomainId, { free: number; total: number; used: number[] }> = {};
    for (const [id, pool] of this.pools) {
      out[id] = { free: pool.free, total: pool.cfg.pairs, used: pool.usedIndices };
    }
    return out;
  }
}

/**
 * Zwei Domänen mit überlappendem Pool sind nur dann harmlos, wenn es wirklich
 * getrennte Netze sind — prüfen kann das die Software nicht, warnen schon.
 */
export function overlappingPools(domains: DomainConfig[]): [string, string][] {
  const hits: [string, string][] = [];
  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const a = domains[i]!;
      const b = domains[j]!;
      if (poolsOverlap(a.pool, b.pool)) hits.push([a.id, b.id]);
    }
  }
  return hits;
}
