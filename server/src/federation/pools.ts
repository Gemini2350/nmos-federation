import type { Allocation, DomainId } from '../types.js';
import type { DomainConfig } from '../config/schema.js';
import { NatGroupAllocator, PoolAllocator, poolsOverlap } from './pool.js';
import { log } from '../util/log.js';

/**
 * Keeps one pool per domain. Allocation always comes from the **target** domain's
 * pool: the addresses must be valid in the network where the virtual sender appears.
 *
 * NAT group numbers come from a shared allocator — they are per switch, and every
 * domain hangs off the same pair of switches.
 */
export class PoolManager {
  private readonly pools = new Map<DomainId, PoolAllocator>();
  /** Every configured domain, so an unusable pool can be told from an unknown domain. */
  private readonly known = new Set<DomainId>();
  private readonly natGroups: NatGroupAllocator;

  constructor(domains: DomainConfig[], natGroupRange: [number, number]) {
    this.natGroups = new NatGroupAllocator(natGroupRange);
    for (const d of domains) {
      this.known.add(d.id);
      try {
        this.pools.set(d.id, new PoolAllocator(d.pool));
      } catch (e) {
        // A pool that does not validate must not take the process down on startup. The
        // domain simply cannot hand out addresses, and says so when something asks.
        log.error({ domain: d.id, err: String(e) }, 'pool unusable — this domain cannot allocate');
      }
    }
  }

  private poolFor(domainId: DomainId): PoolAllocator {
    const pool = this.pools.get(domainId);
    if (!pool) {
      throw new Error(
        this.known.has(domainId)
          ? `domain ${domainId} has no usable pool — check its base address`
          : `no domain ${domainId} configured`,
      );
    }
    return pool;
  }

  allocate(targetDomain: DomainId): Allocation {
    const pool = this.poolFor(targetDomain);
    const pair = pool.allocate();
    let natGroupId: number;
    try {
      natGroupId = this.natGroups.allocate();
    } catch (e) {
      pool.release(pair.index); // don't orphan the pair
      throw e;
    }
    return { domainId: targetDomain, ...pair, natGroupId };
  }

  /** Recovery from persisted state. */
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
 * Two domains with overlapping pools are harmless only if they really are separate
 * networks — the software cannot verify that, but it can warn.
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
