# NMOS Federation — Architecture

This document is the reference for the data model, the workflows and the open
questions. The code follows its structure one to one.

---

## 1. The problem

Two or more separate ST 2110 systems, each with **its own NMOS registry, its own
multicast address plan and its own PTP domain**, need to exchange individual signals.
No trunk, no merged network — only single, deliberately released streams.

The software is a **broker, not a media path**:

| Task | Who does it |
|---|---|
| Signalling (IS-04/IS-05) | nmos-federation |
| Address allocation from the federation pool | nmos-federation |
| Multicast NAT, IGMP/PIM | the switch, configured over eAPI |
| Essence transport | switch hardware, at wire speed |

## 2. Terms

- **Domain** — a network with its own registry view: its own interface, its own
  federation pool, its own L3 interface on both switches. Exactly one domain is the
  internal one, plus **any number of external ones**.
- **Registry** — belongs to exactly one domain. Several registries per domain are
  possible and are the normal case when several partners share a network.
- **Virtual receiver (vRX)** — an NMOS receiver the software registers in a domain.
  It is the ordering point: the operator uses their usual controller (for example
  NMOS Crosspoint) to connect a real source to it.
- **Virtual sender (vTX)** — the sender that connection produces in the target
  domain. It exists only while the vRX is actively connected.
- **Federation channel** — the (vRX, vTX) pair together with its pool reservation and
  switch programming. The channel is the central unit of state.
- **Fabric** — `red` or `blue`, the two ST 2022-7 paths. Two separate switches, two
  separate NAT configurations, one shared addressing rule.

### Why domains rather than "internal/external"

A single pair of terms only works while every partner sits in the same network. As
soon as two partner systems are in **separate** networks, each needs its own
interface, its own address pool and its own egress interface on the switches. The
domain model collapses both cases into one:

| Situation | Modelled as |
|---|---|
| Several partner registries in the same network | **one** external domain, several registries |
| Partners in separate networks | **several** external domains, 1..n registries each |

## 3. Direction of a channel

A channel always runs from a **source domain** into a **target domain**. The vRX
lives in the source domain, the vTX appears in the target domain, and the addresses
come from the target domain's pool.

```
internal → partnerA     release an internal source to partner A
partnerA → internal     bring a signal from partner A into the building
partnerA → partnerB     transit, technically the same case
```

A **federation device** has exactly one source and one target domain, and within that
target domain any selection of registries. Fanning out into two **separate networks**
is deliberately not a device feature: it needs two NAT translations, two pool
reservations and two senders — so two devices. Fanning out to several registries **in
the same network** is only a multiple registration of the same vTX and is supported
directly.

## 4. NMOS resource model

The software is one NMOS **node per domain**.

```
Node(internal)                        Node(partnerA)              Node(partnerB)
  href = http://<int-ip>:8081           href = http://<extA>:8081   …
  ├─ Device "Federation IN"             ├─ Device "Federation IN ▸ mirror"
  │    └─ vRX 1..n                      │    └─ vTX 1..n
  └─ Device "Federation OUT ▸ mirror"   └─ Device "Federation OUT"
       └─ vTX 1..n                           └─ vRX 1..n
```

Why one node per domain rather than a single node UUID in every registry: `node.href`,
`api.endpoints` and `interfaces` must be **reachable from the respective domain**. An
external controller has to fetch the vTX manifest (`/transportfile`), so over that
domain's IP. Several registries **within** one domain do share a node — they see the
same network.

### Devices

The operator creates devices (name, source domain, target domain, target registries,
NAT on/off) and assigns individual vRX to them. For every device the software
automatically creates a **mirror device in the target domain** carrying the matching
vTX; its name is derived and can be overridden. That keeps it visible in the foreign
system which signals belong together.

### Resources per channel

An active channel creates `source` → `flow` → `sender` in the target domain. The
parameters (`format`, `media_type`, `frame_width/height`, `exactframerate`,
`sampling`, `depth`, `colorimetry`; for audio `channels`/`sample_rate`) are derived
from the incoming SDP, not guessed. If parsing fails the channel goes to `failed`
rather than publishing a wrongly described sender.

### Registration

- IS-04 registration API v1.3, POST `/x-nmos/registration/v1.3/resource`, heartbeat
  every 5 s on `/health/nodes/<id>`.
- Registry address per entry: **manual URL** (the normal case externally) or unicast
  DNS-SD (the normal case internally).
- Every registry gets **its own client with its own heartbeat**. If one of three
  external registries fails, the others carry on; the channel stays active and the
  GUI shows which registry it is currently not published in.
- Heartbeat 404 → that registry restarted → re-register everything there only.
- At startup: orphan cleanup per registry — resources carrying our node UUID that are
  not in the persisted state are deleted.
- IDs are **deterministic and persistent** (UUIDv5 from the node UUID plus a logical
  key) so that controller bindings survive a container restart. A vTX carries the
  same ID in every registry **of the same domain**.

### IS-05

- **vRX**: full connection API v1.1 (`staged`, `active`, `constraints`,
  `transporttype`, `bulk`). Activation takes a `transport_file` (SDP) — that is the
  trigger for the whole federation chain. `master_enable=false` tears it down.
  Only `activate_immediate` is implemented; scheduled modes answer 501.
- **vTX**: `active`/`staged` are read-only, plus `/transportfile` with the rewritten
  SDP. A foreign controller must not reconfigure the vTX; PATCH answers 423.

## 5. Multicast pools

**One pool per domain** — it describes the addresses handed out when a sender is
created *in that domain*. Every external domain brings its own.

Allocation is **always in pairs**, even when the source is not ST 2022-7 redundant:

```
pool base 239.200.0.0, pair index i
  blue = base + 2i        (even)
  red  = base + 2i + 1    (odd)
```

- The pool base must be even; this is validated when the settings are saved.
- Releasing returns the whole pair; the next allocation takes the **lowest free
  index** ("the next free address").
- For a single-leg source only the address of the fabric the source is on is used;
  the other stays reserved and unused.
- Fabric assignment of an SDP leg: primarily from the source domain's subnets, else
  from the order of the `m=` lines (leg 0 = red, leg 1 = blue).
- Overlapping pools of two domains are a **warning**, not an error: with genuinely
  separate networks that is legitimate, and the software cannot tell.

### Source NAT pool (optional, but recommended)

If only the group is translated, the stream keeps the source IP from the foreign
network. For SSM (`a=source-filter`) and for RPF/routing on the target side that is
usually unusable. Hence a **unicast pool per domain and fabric** from which one
translated source address is handed out per channel — deterministically at the same
index as the group pair.

### NAT group numbers

EOS requires that the source and destination rule of a translation pair carry the same
`group` number. These numbers are **per switch, not per domain** — every domain hangs
off the same pair of switches. They therefore come from a global allocator, not from
the domain pool. The configured range is the hard upper bound on the number of
simultaneous channels across all domains.

## 6. Switch control (Arista EOS over eAPI)

Two switches, `red` and `blue`, each with a host and credentials. The L3 interfaces
live **on the domains**, not on the switch: every domain names its interface per
fabric. For a channel that makes

- **ingress** = the source domain's interface on that switch,
- **egress** = the target domain's interface on that switch.

This is why direction needs no special handling any more.

Transport: JSON-RPC POST to `https://<switch>/command-api`, method `runCmds`
(`version: 1`, `format: json`), the command list starting with `enable`, `configure`.
If a command fails EOS does not execute the rest — the error response carries the
index and message, which is what the rollback builds on.

Three things are programmed per channel and fabric:

1. **Ingress join** — the switch has to pull the original stream at all:
   `ip igmp static-group <origGroup> [source <origSrc>]` on the ingress interface.
   Alternatively over PIM when the switch is last hop anyway — hence the
   `join: igmpStatic | pim | none` setting.
2. **NAT** — group translation, optionally source translation as well:
   ```
   ip nat destination static <origGroup> <fedGroup> group <N>
   ip nat source      static <origSrc>   <fedSrc>   group <N>
   ```
3. **Egress** — the translated group has to be emitted towards the target domain:
   `ip igmp static-group <fedGroup>` on the egress interface, or PIM/mroute when the
   far side joins by itself.

The driver interface (`switch/driver.ts`) only knows `program(fabricPlan)`,
`unprogram(fabricPlan)` and `readState()`. Next to `arista-eapi` there is a `mock`
driver that only logs the commands — which makes the entire federation logic testable
without hardware.

### ⚠ Platform prerequisite

**Multicast NAT is probably not a feature of every Arista platform.** The TOI series
consistently names only the Trident3 family — although the EOS manual itself contains
*no* platform list for NAT, so this is circumstantial:

| Feature | since EOS | Platforms |
|---|---|---|
| Static NAT | 4.21.6F | 7050X3, 720XP, 720D |
| **Multicast NAT** | **4.25.1F** | **7050X3, 720XP, 720D** |
| NAT VRF | 4.27.0F | 7050X3, 720XP, 720D |
| Static NAT | 4.35.0F | 7050X4, 7358X4 |
| NAT flow | 4.28.1F | 7170 |

The **7060 series (Tomahawk/Tomahawk+) appears in no NAT TOI**.

### Measurements on a DCS-7060SX2-48YC6 (EOS 4.35.1F)

| Check | Result |
|---|---|
| `ip nat destination static 239.10.1.5 239.200.0.1 group 100` on an SVI | **accepted**, no error |
| `show ip nat translation` straight afterwards | **empty** — headers, no rows |
| programmed in hardware? | **open** |
| traffic test | **not done yet** |

The CLI accepting it refutes "the 7060 cannot do NAT at all" as a blanket statement.
Conversely, an empty translation table after a static rule is the typical picture for
"configuration accepted, hardware not programmed" — only a traffic test decides. See
open point 1.

### Idempotence and the reconciler

The software keeps a persisted desired state (`state.json` in the volume). A
reconciler loop (interval plus triggers) compares desired against actual:

- switch actual state from `show running-config section ip nat`,
- registry actual state per registry from our own bookkeeping plus heartbeat replies.

Deviations are corrected, not just logged. That is what lets the system survive a
container restart, a switch reload and a registry restart without hand-holding.

## 7. SDP transformation

Input: the `transport_file` from the vRX's IS-05 activation.

| SDP element | Handling |
|---|---|
| `o=` origin address | set to the translated source, bump `sess-version` |
| `c=IN IP4 <grp>/<ttl>` | replace the group, keep the TTL |
| `a=source-filter:incl IN IP4 <grp> <src>` | replace **both** group and source |
| `m=` port/payload | unchanged |
| `a=fmtp:` | unchanged (essence description) |
| `a=group:DUP` / several `m=` | every leg gets its counterpart from the pool |
| `a=ts-refclk:ptp=…` | passed through by default, optionally overridden with the target domain's `ptpRefclk` |
| `a=mediaclk:` | unchanged |

With **NAT disabled** there is no transformation: the SDP is copied verbatim and the
vTX points at the original addresses. That is the case for networks that are already
routed between the two houses.

> The PTP question is real: both houses must be locked to the same time (TAI),
> otherwise the stream arrives on the target side but its timestamps do not match the
> local grandmaster. The override only rescues the receiver's SDP plausibility check,
> not the physics.

## 8. Channel lifecycle

```
        IS-05 activate (master_enable=true, transport_file)
idle ──────────────► allocating ──► programming ──► publishing ──► active
 ▲                       │              │               │            │
 │                       └──────────────┴───────────────┴──► failed  │
 │                                                                   │
 └── releasing ◄── unprogramming ◄── withdrawing ◄────────────────────┘
                IS-05 deactivate / vRX disabled / source gone
```

- **allocating** — a pair from the target domain's pool, source NAT addresses, a NAT
  group number from the global allocator.
- **programming** — both fabrics; if one fails the other is rolled back.
- **publishing** — `source`/`flow`/`sender` into all of the device's target
  registries. If one of several registries fails, the channel stays active and the
  missing registration is caught up by the reconciler.
- **active** — heartbeats running, reconciler watching.
- **failed** — the reason is surfaced in the GUI (and later over BCP-008-01); any
  reserved resources are released.

Teardown is strictly the reverse: **unregister the vTX first** (so no controller can
still connect to a stream that is about to die), then remove NAT and joins, then
release the pool.

## 9. Configuration overview

```jsonc
{
  "port": 8080,        // GUI + REST, bound to 0.0.0.0
  "nmosPort": 8081,    // node/connection API, one listener per domain IP

  "domains": [
    { "id": "internal", "label": "Own facility", "kind": "internal",
      "iface": { "name": "eth0", "address": "10.1.0.10" },
      "fabricSubnets": { "red": "10.1.1.0/24", "blue": "10.1.2.0/24" },
      "switchInterface": { "red": "Vlan101", "blue": "Vlan102" },
      "pool": { "base": "239.201.0.0", "pairs": 64,
                "sourceNat": { "red": "10.1.1.100", "blue": "10.1.2.100" } },
      "ptpRefclk": null, "enabled": true },

    { "id": "partnerA", "label": "Partner A", "kind": "external",
      "iface": { "name": "eth1", "address": "10.9.0.10" },
      "fabricSubnets": { "red": "10.9.1.0/24", "blue": "10.9.2.0/24" },
      "switchInterface": { "red": "Vlan901", "blue": "Vlan902" },
      "pool": { "base": "239.200.0.0", "pairs": 64,
                "sourceNat": { "red": "10.9.1.100", "blue": "10.9.2.100" } },
      "ptpRefclk": null, "enabled": true },

    { "id": "partnerB", "label": "Partner B", "kind": "external", "…": "…" }
  ],

  // Several registries per domain is the normal case when partners share a network.
  "registries": [
    { "id": "int",   "label": "Internal registry", "domainId": "internal",
      "mode": "dnssd",  "version": "v1.3", "enabled": true },
    { "id": "regA1", "label": "Partner A primary", "domainId": "partnerA",
      "mode": "manual", "url": "http://10.9.0.20:8235", "version": "v1.3", "enabled": true },
    { "id": "regA2", "label": "Partner A backup",  "domainId": "partnerA",
      "mode": "manual", "url": "http://10.9.0.21:8235", "version": "v1.3", "enabled": true }
  ],

  "nat": {
    "enabled": true,               // global switch; false = every SDP copied verbatim
    "driver": "arista-eapi",       // or "mock" — logs commands instead of sending them
    "switches": {
      "red":  { "host": "10.0.0.11", "user": "…", "password": "…", "tls": true, "join": "igmpStatic" },
      "blue": { "host": "10.0.0.12", "user": "…", "password": "…", "tls": true, "join": "igmpStatic" }
    },
    "groupIdRange": [100, 999]
  },

  "devices": [
    { "id": "…", "label": "Federation OUT ▸ Partner A",
      "sourceDomain": "internal", "targetDomain": "partnerA",
      "targetRegistries": ["regA1", "regA2"],   // empty = all enabled ones of the domain
      "nat": true,                              // per-device switch, on top of the global one
      "receiverIds": ["…"] }
  ]
}
```

### The NAT switch

NAT can be turned off at two levels, and both are live in the GUI:

- **globally** (`nat.enabled`) — nothing is programmed on any switch, every SDP is
  copied verbatim;
- **per device** (`devices[].nat`) — only that device's channels bypass NAT.

Changing either invalidates the affected channels: their addresses, switch rules and
published sender were all derived from the old setting. The backend tears those
channels down and rebuilds them from the stored IS-05 state, and reports how many
were rebuilt and which failed.

Running without NAT is a legitimate mode, not a degraded one — it is the right choice
when the address plans of the houses involved do not collide and the networks are
already routed.

## 10. Stack and operation

- **Backend** Node 22+/TypeScript, HTTP through `fastify`. No database server; state
  is JSON in the volume, written atomically.
- **Frontend** Vue 3 + Vite + TypeScript, built into the image and served by the
  backend.
- **Two ports:** `port` (GUI/REST/WebSocket on 0.0.0.0) and `nmosPort`
  (node/connection API). The NMOS API runs **one listener per domain**, bound to that
  domain's IP, which is what makes the same port usable several times. If two domains
  share an IP (lab setup), the second takes the next free port and `node.href`
  follows.
- **Docker** `network_mode: host` is required: the software needs one interface with
  a real IP per domain (node href, manifest fetch, mDNS). The alternative would be
  macvlan with several networks.
- Configuration and state live under `/config` (a volume).

## 11. Roadmap

1. ✅ Core: pools per domain, NAT groups, SDP, channel plan
2. ✅ NMOS node per domain: IS-04 registration, node API, IS-05 vRX/vTX
3. ⏳ Switch driver: the mock is done, arista-eapi is written but **not verified
   against hardware** — blocked by open point 1
4. ✅ Persistence, recovery and reconciler (in `engine.ts`, 30 s interval)
5. ✅ Web GUI: domains/registries/switches, devices, live channel dashboard
6. BCP-008-01 (`NcReceiverMonitor` per vRX)
7. The external→external transit case in production, failover across several
   registries
8. Optional: IS-09 system API, authentication (IS-10) for the external domains

## 12. Open points

1. **NAT platform.** State of verification on the DCS-7060SX2-48YC6 (EOS 4.35.1F):
   the CLI **accepts** the rule but it does **not** appear in
   `show ip nat translation`. Next steps, in this order:
   - `show running-config interfaces Vlan101` — does the rule persist at all?
   - `show logging last 10 minutes | grep -i nat` — does the NAT agent complain?
   - `show ip nat access-list interface` / `show ip nat pool` — does the box know it?
   - **traffic test** (decisive): send to 239.10.1.5 in Vlan101, join 239.200.0.1 on
     the egress interface, check the counters.

   If the traffic test is negative, three ways out:
   a) hang a small 7050X3 / 720XP pair between the fabrics as a dedicated federation
      NAT stage — the main switches stay untouched;
   b) run the federation without NAT (`nat: false`) when the address plans of the
      houses involved do not collide — already a supported mode;
   c) a Linux gateway (nftables + smcroute) as a software NAT, with a clear
      throughput limit.

   This blocks roadmap item 3.
2. **The exact EOS syntax and interface placement** (ingress vs. egress/twice NAT)
   needs verifying against the platform actually used.
3. **PTP across domain boundaries** — pass `ts-refclk` through or override it? An
   operational decision; both are prepared technically.
4. **IS-05 activation modes**: only `activate_immediate`; `activate_scheduled_*`
   answers 501. To be added for planned switchovers.
5. **Collisions in the target network** — a domain's federation pool has to be
   exclusive there; the software cannot verify that, it can only document it and warn
   about overlapping pools.
6. **Capacity limit** — how many channels per fabric? Bounded by the platform's NAT
   TCAM and by the NAT group range.
7. **Security of the external domains** — today the HTTP APIs are open on every
   interface. At minimum separate the bind addresses per domain; IS-10 in the medium
   term.
