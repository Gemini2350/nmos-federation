import type { Channel, ChannelPlan, FabricPlan } from '../types.js';
import { domainById, type AppConfig } from '../config/schema.js';

/**
 * Turns a channel into switch instructions.
 *
 * Ingress is the **source** domain's L3 interface, egress the **target** domain's —
 * both on the same switch for that fabric. This is what removes the old
 * internal/external special case: every domain brings its own interfaces.
 */
export function buildChannelPlan(channel: Channel, cfg: AppConfig): ChannelPlan {
  if (!channel.allocation) throw new Error(`channel ${channel.id}: no pool reservation`);
  if (channel.allocation.domainId !== channel.targetDomain) {
    throw new Error(`channel ${channel.id}: reservation came from domain ${channel.allocation.domainId}, target is ${channel.targetDomain}`);
  }

  const source = domainById(cfg, channel.sourceDomain);
  const target = domainById(cfg, channel.targetDomain);
  const seen = new Set<string>();
  const fabrics: FabricPlan[] = [];

  for (const leg of channel.legs) {
    if (seen.has(leg.fabric)) throw new Error(`channel ${channel.id}: two legs on fabric ${leg.fabric}`);
    seen.add(leg.fabric);

    fabrics.push({
      fabric: leg.fabric,
      origin: { group: leg.group, source: leg.source },
      translated: {
        group: channel.allocation.groups[leg.fabric],
        source: channel.allocation.sources?.[leg.fabric] ?? null,
      },
      natGroupId: channel.allocation.natGroupId,
      ingressInterface: source.switchInterface[leg.fabric],
      egressInterface: target.switchInterface[leg.fabric],
      join: cfg.nat.switches[leg.fabric].join,
    });
  }

  if (!fabrics.length) throw new Error(`channel ${channel.id}: no usable leg in the SDP`);
  return { channelId: channel.id, fabrics };
}

/*
 * The state machine itself lives in `engine.ts`, where pools, switch drivers and
 * registry clients come together. This file holds only the pure plan derivation so
 * that it stays testable without a network.
 */
