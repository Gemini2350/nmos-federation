/** Gemeinsame Typen. Begriffe wie in docs/ARCHITECTURE.md. */

export type Fabric = 'red' | 'blue';
export const FABRICS: Fabric[] = ['red', 'blue'];

/**
 * Referenz auf eine Domäne — ein Netz mit eigenem Interface, eigenem Pool und
 * eigenem L3-Interface auf den beiden Switches. Genau eine Domäne ist die interne,
 * dazu kommen beliebig viele externe.
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

/** Ein Bein eines (evtl. ST-2022-7-redundanten) Streams. */
export interface Leg {
  fabric: Fabric;
  group: string;
  source: string | null;   // aus a=source-filter oder o=, null wenn ASM ohne Filter
  port: number;
}

/** Was aus dem Pool der Ziel-Domäne für einen Channel reserviert wurde. */
export interface Allocation {
  /** Domäne, aus deren Pool reserviert wurde. */
  domainId: DomainId;
  /** Index des Pärchens im Pool; blue = base+2i, red = base+2i+1. */
  index: number;
  groups: Record<Fabric, string>;
  /** Übersetzte Quelladressen, nur bei aktivem Source-NAT. */
  sources: Record<Fabric, string> | null;
  /** EOS NAT-Group-Nummer; Source- und Destination-Regel eines Channels teilen sie. */
  natGroupId: number;
}

/** Vollständige Anweisung an den Switch-Treiber für eine Fabric. */
export interface FabricPlan {
  fabric: Fabric;
  origin: { group: string; source: string | null };
  translated: { group: string; source: string | null };
  natGroupId: number;
  /** L3-Interface der Quell-Domäne auf diesem Switch — hier kommt der Original rein. */
  ingressInterface: string;
  /** L3-Interface der Ziel-Domäne auf diesem Switch — hier geht der Übersetzte raus. */
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
  /** Domäne, in der der virtuelle Receiver registriert ist. */
  sourceDomain: DomainId;
  /** Domäne, in der der virtuelle Sender entsteht. */
  targetDomain: DomainId;
  state: ChannelState;
  /** Was der vRX geschaltet bekommen hat. */
  originSdp: string | null;
  originSenderId: string | null;
  legs: Leg[];
  allocation: Allocation | null;
  /** SDP des virtuellen Senders (transformiert oder 1:1 kopiert). */
  senderSdp: string | null;
  /** Registry-IDs, in denen der vTX veröffentlicht ist. */
  publishedIn: string[];
  error: string | null;
  updatedAt: string;
}

export interface FederationDevice {
  id: string;
  label: string;
  /** Domäne, in der die virtuellen Receiver dieses Devices leben. */
  sourceDomain: DomainId;
  /** Domäne, in die übersetzt wird. Eine Domäne — Fan-out in zwei getrennte Netze
   *  braucht zwei NAT-Übersetzungen und damit zwei Devices. */
  targetDomain: DomainId;
  /** Registry-IDs innerhalb der Ziel-Domäne, in denen der vTX veröffentlicht wird.
   *  Leer = alle aktiven Registries der Ziel-Domäne. */
  targetRegistries: string[];
  /** NAT für dieses Device; false = SDP wird 1:1 kopiert. */
  nat: boolean;
  /** Name des Spiegel-Devices in der Ziel-Domäne; leer = abgeleitet. */
  mirrorLabel?: string;
  receiverIds: string[];
}

export interface VirtualReceiver {
  id: string;
  label: string;
  deviceId: string;
  format: 'video' | 'audio' | 'data';
  enabled: boolean;
}
