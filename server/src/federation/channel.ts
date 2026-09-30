import type { Channel, ChannelPlan, FabricPlan } from '../types.js';
import { domainById, type AppConfig } from '../config/schema.js';

/**
 * Übersetzt einen Channel in Switch-Anweisungen.
 *
 * Ingress ist das L3-Interface der **Quell**-Domäne, Egress das der **Ziel**-Domäne —
 * beides auf demselben Switch der jeweiligen Fabric. Damit fällt die alte
 * intern/extern-Sonderbehandlung weg: jede Domäne bringt ihre Interfaces mit.
 */
export function buildChannelPlan(channel: Channel, cfg: AppConfig): ChannelPlan {
  if (!channel.allocation) throw new Error(`Channel ${channel.id}: keine Pool-Reservierung`);
  if (channel.allocation.domainId !== channel.targetDomain) {
    throw new Error(`Channel ${channel.id}: Reservierung stammt aus Domäne ${channel.allocation.domainId}, Ziel ist ${channel.targetDomain}`);
  }

  const source = domainById(cfg, channel.sourceDomain);
  const target = domainById(cfg, channel.targetDomain);
  const seen = new Set<string>();
  const fabrics: FabricPlan[] = [];

  for (const leg of channel.legs) {
    if (seen.has(leg.fabric)) throw new Error(`Channel ${channel.id}: zwei Beine auf Fabric ${leg.fabric}`);
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

  if (!fabrics.length) throw new Error(`Channel ${channel.id}: kein verwertbares Bein im SDP`);
  return { channelId: channel.id, fabrics };
}

/*
 * Die Statemachine selbst liegt in `engine.ts` — dort, wo Pools, Switch-Treiber und
 * Registry-Clients zusammenkommen. Hier steht nur die reine Plan-Ableitung, damit sie
 * ohne Netzwerk testbar bleibt.
 */
