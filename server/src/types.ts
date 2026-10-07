/** Shared types. Terminology as in docs/ARCHITECTURE.md. */

export type Fabric = 'red' | 'blue';
export const FABRICS: Fabric[] = ['red', 'blue'];

/**
 * Reference to a domain — a network with its own interface, its own pool and its own
 * L3 interface on both switches. Exactly one domain is the internal one, plus any
 * number of external ones.
 */
export type DomainId = string;

export type ChannelState =
  | 'idle'
  | 'allocating'
  | 'programming'
  | 'publishing'
  | 'active'
  | 'withdrawing'
  | 'unprogramming'
  | 'releasing'
  | 'failed';

/** One leg of a (possibly ST 2022-7 redundant) stream. */
export interface Leg {
  fabric: Fabric;
  group: string;
  source: string | null;   // from a=source-filter or o=, null for ASM without a filter
  port: number;
}

/** What was reserved from the target domain's pool for a channel. */
export interface Allocation {
  /** Domain whose pool this came from. */
  domainId: DomainId;
  /** Index of the pair; blue = base+2i, red = base+2i+1. */
  index: number;
  groups: Record<Fabric, string>;
  /** Translated source addresses, only with source NAT enabled. */
  sources: Record<Fabric, string> | null;
  /** EOS NAT group number; a channel's source and destination rule share it. */
  natGroupId: number;
}

/** Complete instruction to the switch driver for one fabric. */
export interface FabricPlan {
  fabric: Fabric;
  origin: { group: string; source: string | null };
  translated: { group: string; source: string | null };
  natGroupId: number;
  /** Source domain's L3 interface on this switch — where the original arrives. */
  ingressInterface: string;
  /** Target domain's L3 interface on this switch — where the translated one leaves. */
  egressInterface: string;
  join: 'igmpStatic' | 'pim' | 'none';
}

export interface ChannelPlan {
  channelId: string;
  fabrics: FabricPlan[];
}

export interface Channel {
  id: string;
  receiverId: string;
  deviceId: string;
  /** Domain the virtual receiver is registered in. */
  sourceDomain: DomainId;
  /** Domain the virtual sender is created in. */
  targetDomain: DomainId;
  state: ChannelState;
  /** What was connected to the virtual receiver. */
  originSdp: string | null;
  originSenderId: string | null;
  /** For a sender copy: the original's IS-04 version this channel was built from. */
  originVersion?: string;
  legs: Leg[];
  allocation: Allocation | null;
  /** The virtual sender's SDP (rewritten, or copied verbatim when NAT is off). */
  senderSdp: string | null;
  /** Registry IDs the virtual sender is published in. */
  publishedIn: string[];
  /** Set for a direct sender copy: which MirrorEntry produced this channel. */
  mirrorId?: string;
  /** Set once a proxied remote receiver has been connected over IS-05. */
  remoteReceiver?: { registryId: string; receiverId: string; connected: boolean; error: string | null };
  error: string | null;
  updatedAt: string;
}

/**
 * A bridge between two domains — and the NMOS node everything under it belongs to.
 *
 * It has no direction. Each port on it does: a virtual receiver is offered in one of the
 * two domains and its stream flows to the other, a copy flows away from the domain it
 * was copied from. The bridge carries what both directions share — the node name, the
 * registries it appears in and the NAT setting. Fanning out into a third network is a
 * second bridge, because it is another NAT translation.
 */
export interface Bridge {
  id: string;
  /** The NMOS node's label, as every registry will show it. */
  label: string;
  /** The two domains it joins. The order only decides which side the GUI shows first. */
  domains: [DomainId, DomainId];
  /**
   * Registries the node appears in, from either domain. Per domain: the ones listed
   * here, or all enabled ones of that domain when none of its registries is listed.
   */
  registries: string[];
  /** NAT for everything on this bridge; false = SDPs are copied verbatim. */
  nat: boolean;
  /**
   * Natural grouping (BCP-002-01 group hints) on this bridge's ports. Missing = on.
   * Off publishes no group hints at all; the groups and roles set stay stored.
   */
  grouping?: boolean;
  enabled: boolean;
}

/** A group of ports on a bridge — one NMOS device under the bridge's node. */
export interface FederationDevice {
  id: string;
  label: string;
  bridgeId: string;
  receiverIds: string[];
}

export interface VirtualReceiver {
  id: string;
  label: string;
  deviceId: string;
  format: 'video' | 'audio' | 'data';
  enabled: boolean;
  /**
   * Domain this receiver is offered in — one of its bridge's two. A stream connected
   * here flows to the other one. Missing = the bridge's first domain.
   */
  side?: DomainId;
  /**
   * Natural group (BCP-002-01) the operator gave this receiver; the role is derived.
   * Empty = a proxy keeps its original's group, a free receiver has none.
   */
  group?: string;
  /** Role within the group, set by the operator; empty = the original's, or derived. */
  role?: string;
  /**
   * Set when this receiver is a proxy for a real receiver in the other domain: once
   * a stream is connected here, the original is driven over IS-05 so the essence
   * actually arrives there. Created through a receiver copy, see MirrorEntry.
   */
  proxyFor?: { registryId: string; receiverId: string; deviceId: string; mirrorId: string };
}
