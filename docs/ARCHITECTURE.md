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

The direction belongs to the **port**, not to the bridge. A bridge joins two domains
and carries streams both ways: each virtual receiver is offered in one of the two (its
`side`) and its stream flows to the other; a copy runs away from the domain it was
copied from. So `internal → partnerA` and `partnerA → internal` can sit side by side on
one bridge, in one device, under one node.

Fanning out into two **separate networks** is deliberately not a port feature: it needs
two NAT translations, two pool reservations and two senders — so two bridges. Fanning
out to several registries **in the same network** is only a multiple registration of
the same vTX and is supported directly.

## 4. NMOS resource model

A **bridge** joins two domains and *is* an NMOS node. Every registry of either domain
shows that node under the bridge's name, and everything else hangs off it:

```
Bridge "Eigenes Haus ⇄ Partner A"        ← the NMOS node, named by the operator
  ├─ Device "Kameras"                     ← one NMOS device
  │    ├─ virtual receiver, offered internally  → its sender appears at Partner A
  │    └─ virtual receiver, offered at Partner A → its sender appears internally
  └─ Device "Ton"
```

The bridge carries what both directions share: the node name, the registries it
appears in, and the NAT setting. Its `registries` list works per domain — the listed
registries of a domain, or all enabled ones of that domain when none of them is
listed. A device has nothing to decide: it is a group of ports on the bridge, in either
direction. Fanning out into a third network is a second bridge, because it is another
NAT translation.

The same node id is registered in each of the bridge's two domains, each time carrying
*that* domain's address in `href` and `api.endpoints`. A registry only ever receives
resources of its own domain, so the address is always locally correct while the identity
stays one. The same goes for a device: one id, appearing in each domain with the
receivers offered there and the senders that streams from the other side became —
there is no separate mirror.

A registry therefore shows **one node per bridge touching its domain**, each with one
device per device. A registry serving a domain with two bridges holds two nodes, which is
the honest picture: they are two separate crossings.

Since a domain can carry several nodes, `/x-nmos/node/v1.3/self` answers with the first
and all of them are listed under `/nodes`.

### Devices

The operator creates devices under a bridge and adds virtual receivers to them, each
with the domain it is offered in. The device appears in both domains under the same id,
so a foreign system sees which signals belong together.

### Natural grouping

Ports carry the BCP-002-01 tag `urn:x-nmos:tag:grouphint/v1.0` (`<group>:<role>[:<scope>]`),
so a controller shows the video, audio and ancillary of one source together
(`federation/grouping.ts`). Where a port's hint comes from, in order:

1. a group the operator typed for it — the role is then the original's, or derived
   from the format for a free virtual receiver ("Video 1", "Audio 1", "Audio 2");
2. for a copy, the original's own hint, read when the copy is made (copies older than
   this feature get it once after startup, `POST /api/mirrors/origins`);
3. nothing.

The role can be overridden the same way, on top of whichever group applies; empty
means the original's or the derived one. A role alone makes no group.

Grouping is a per-bridge switch (`bridge.grouping`, missing = on), like NAT. Off
publishes no group hints at all; the groups and roles set stay stored and return when
it is switched back on. Switching it changes registrations only, no channel is rebuilt.

The sender a channel publishes on the other side carries the same hint as the port it
came from, so the grouping holds across the bridge. Group names are only unique per
device ("Receive0" exists on every SDI card), and one federation device can hold copies
of several original devices — an inherited name that comes from more than one original
device therefore gets that device's label in front ("SDI A / Receive0").

### Resources per channel

An active channel creates `source` → `flow` → `sender` in the target domain. The
parameters (`format`, `media_type`, `frame_width/height`, `exactframerate`,
`sampling`, `depth`, `colorimetry`; for audio `channels`/`sample_rate`) are derived
from the incoming SDP, not guessed. If parsing fails the channel goes to `failed`
rather than publishing a wrongly described sender.

Supported essences: ST 2110-20 (`video/raw`), ST 2110-22 JPEG XS (`video/jxsv`),
ST 2110-30/31 PCM (`audio/L16`, `L24`, `L32`) and ST 2110-40 (`video/smpte291`). For
JPEG XS the flow also carries `profile`/`level`/`sublevel` and the sender `bit_rate`
(from `b=AS`) and `st2110_21_sender_type` (from `TP=`), as BCP-006-01 asks — copied
from the SDP, never computed. Video receivers advertise `video/raw` and `video/jxsv`.
Other codecs (H.264, H.265, …) are refused: their SDP does not carry frame size and
rate, so the flow could not be described honestly.

### Schema conformance

Every resource is validated against the **official IS-04 v1.3 schemas** in the test
suite (`schemas/is-04-v1.3/`, checked by ajv in `nmos/schema.test.ts`). That is not
belt-and-braces: the end-to-end tests run against a stub registry that accepts
anything, so they proved the behaviour and nothing about the payloads. A schema-strict
registry rejected every resource with HTTP 400 while the suite was green.

Four things a strict validator refuses that are easy to get wrong:

| Field | Requirement |
|---|---|
| `hostname` | optional, `format: hostname` — an IP address is invalid there and `null` is invalid outright, so it is omitted |
| `interfaces[].port_id` | must match `^([0-9a-f]{2}-){5}[0-9a-f]{2}$`. `null` is refused, and the interface name is not an acceptable substitute |
| `interfaces[].chassis_id` | may be `null`; the MAC is published when known so a controller can correlate the node with LLDP/SNMP on the same NIC |
| `href`, `controls[].href`, `manifest_href` | canonical URI — a spelled-out default port is rejected |

`endpoints[].authorization` and `controls[].authorization` are optional; stating them
explicitly as `false` sits better with strict validators.

The MAC requirement needs a fallback: inside a container without host networking there
may be no OS interface carrying the configured address. A deterministic
locally-administered EUI-48 is derived from the node UUID, so it is stable across
restarts and marked as not globally unique.

One more trap, from the same family: **a registry rejects a re-POST that carries the
same `version` with different content.** Resources are therefore versioned from the
moment they are built, and nothing re-registers an altered body under an old stamp.

### Registration

- IS-04 registration API v1.3, POST `/x-nmos/registration/v1.3/resource`, heartbeat
  every 5 s on `/health/nodes/<id>`.
- Registry address per entry: **IP and port** (the normal case externally) or
  **DNS-SD** (the normal case internally). The URL is assembled from ip, port and a tls
  flag rather than typed in; the port defaults to 80. A configuration that still
  carries a full `url` is migrated on load. See "Discovery" below.
- Every registry gets **its own client with its own heartbeat**. If one of three
  external registries fails, the others carry on; the channel stays active and the
  GUI shows which registry it is currently not published in.
- The GUI shows a **status per registry**: resolved address, state, how much of ours
  that registry holds broken down by resource type, the age of the last successful
  heartbeat, and the last error. `GET /api/registries` returns the same data, and
  `POST /api/registries/<id>/probe` runs an on-demand reachability test — that is the
  Test button, and it changes nothing on the registry.

  | State | Meaning |
  |---|---|
  | `ok` | reachable, heartbeat current |
  | `degraded` | reachable, but the heartbeat is overdue (3 intervals) or has failed |
  | `down` | the last contact attempt failed |
  | `unknown` | nothing tried yet |
  | `disabled` | switched off in the configuration |

  A registry that is configured but has no client yet — disabled, or added since the
  last restart — is reported as such rather than omitted, so the GUI never silently
  hides one.
- Heartbeat 404 → that registry restarted → re-register everything there only.
- A fresh or just-reset configuration has its registry **disabled**. A container that
  has only just started must not announce itself into whatever registry it happens to
  discover; the operator enables it once the domain's address is right.
- At startup and after every settings change: **orphan cleanup** per registry. The
  record of what was registered lives only in memory, so after a restart the software
  cannot unregister what an earlier run left behind — it has to ask the query API for
  everything belonging to one of our nodes and delete whatever the current plan does not
  contain. Only resources under our own node ids are ever touched. Those ids derive from
  the persisted seed and survive a restart; if the state file itself is deleted they are
  unknowable, and the registry's own garbage collection takes over once the heartbeat
  stops.
- **The node of a domain is registered as soon as a registry is enabled for it**, with
  or without a federation device. Without that, an installation that has registries but
  no devices yet registers nothing, its heartbeat 404s every five seconds forever, and
  the status cannot tell "unreachable" from "we never put anything there".
- A heartbeat 404 is **successful contact** — the registry answered, it just does not
  know this node. Recording it as nothing at all is what made the status sit on "not
  contacted yet" while the registry was perfectly healthy.
- IDs are **deterministic and persistent** (UUIDv5 from the node UUID plus a logical
  key) so that controller bindings survive a container restart. A vTX carries the
  same ID in every registry **of the same domain**.

### Every published href must answer

`node.href`, each device's `controls[].href` and each sender's `manifest_href` are
addresses other systems follow. Two of them used to return 404: `node.href` points at the
root, which had no route, and the control href lacked the trailing slash its route was
registered with. Fastify treats `/x` and `/x/` as different paths by default.

The NMOS APIs now run with `ignoreTrailingSlash`, since controllers differ in whether they
add or strip a slash, and the root answers. The control href ends in a slash, as the IS-04
examples and other implementations write it — a controller appends `single/receivers/…`
to it, which without the slash produced `…/v1.1single/…`. A test follows every published
href, including what a controller builds from the control href, and checks every base path
in both forms.

### IS-05

- **vRX**: full connection API v1.1 (`staged`, `active`, `constraints`,
  `transporttype`, `bulk`). Activation takes a `transport_file` (SDP) — that is the
  trigger for the whole federation chain. `master_enable=false` tears it down.
  Only `activate_immediate` is implemented; scheduled modes answer 501.
- **vTX**: `active`/`staged` are read-only, plus `/transportfile` with the rewritten
  SDP. A foreign controller must not reconfigure the vTX; PATCH answers 423.

## 4a. Direct copies between registries

Next to federation there is a second operating mode: copying a resource that already
exists in one registry straight into another, without a virtual receiver to connect to.
A copy is created on request rather than by waiting for an IS-05 activation.

Both kinds hang off a device, and through it off its **bridge**, which supplies the
registries and the NAT setting. The direction comes from the registry the original is
copied from: a copy always runs into the bridge's other domain. Internally a copy is
the same thing as a federation channel, only with a different trigger.

### Sender copy

```
sender S in one of the bridge's domains (the origin)
  → read S's SDP from its manifest_href
  → allocate a pair from the OTHER domain's pool, program NAT on both fabrics
  → publish source/flow/sender with the rewritten SDP in the other domain's registries
```

The origin SDP comes from the sender's own manifest instead of a controller's PATCH;
everything after that is the ordinary channel path. `POST /api/mirrors/<id>/refresh`
re-reads the manifest and rebuilds — that is how a changed origin SDP is picked up,
since nothing notifies us.

### A published sender over IS-05

Our senders report what they send to in `/active`: with NAT the channel's group and
source, without NAT the original's own group, source and port (the SDP is passed
through, so that is what is on the wire — it used to be reported as null, and a
controller showed copies without a multicast). `/constraints` says what is fixed.

A controller may change `destination_ip` of a **NATted** sender: the new group is
simply the NAT's egress, so the switch is reprogrammed and the SDP rewritten
(`Engine.setSenderGroups`). Refused, with the reason in the IS-05 error: any group
change without NAT (the stream is the original's), a non-multicast address, an address
inside a federation pool (the pool would hand it out again), one used by another
federated sender, a port or source change, and `master_enable: false`. A PATCH that
re-states the current values succeeds. The pool pair stays reserved; an in-place
update from the original keeps the chosen group, a full rebuild returns to the pool's.

### Name and sharing per copy

Every copy can be renamed and shared individually, without touching its stream:

- a **sender copy** is published, and a **receiver proxy** offered, in the registries
  of the domain opposite its origin — by default the bridge's registries there, but any
  subset of that domain's registries can be chosen per copy, including ones the bridge
  does not list (such a registry then gets the node and only the devices that have
  something there).

Changing either only moves registrations: the NAT and the multicast groups stay as
they are, and a deselected registry has the copy removed. At least one registry is
always kept; chosen registries that are later disabled drop out, and if none is left
the default applies again.

### Passing an original's control APIs through

When **every** port of a federation device is a copy of the same original device (same
registry, no free virtual receiver among them), that device's IS-12 (BCP-008 status)
and IS-08 (channel mapping) belong to our copies too. Our device then advertises them
itself, in the domain the copies appear in — pointing at a proxy on this software's
node API there (`/x-nmos-proxy/<device>/ncp` over WebSocket, `/x-nmos-proxy/<device>/cm/`
over HTTP), which forwards to the original (`nmos/control-proxy.ts`).

Two reasons it is a proxy and not the original's href copied over:

- **Reachability.** The original's address lives in its own network; this software has
  one in both. No unicast routing between the domains is needed.
- **Identity.** Both APIs name IS-04 resources by id — a BCP-008 monitor's touchpoint
  (which is how a controller such as NMOS-Crosspoint ties a monitor to a receiver), an
  IS-08 input's parent, an output's source. Every message is translated: original ids
  to ours on the way out, ours to the original's on the way in. Ids we hold no copy of
  pass unchanged.

The original's controls and, for sender copies, its source id are read with the copy
(older copies once after startup). The target of the proxy is always a control the
original advertised itself, never something a client names. Verified read-only against
a real IS-12 device: 64 BCP-008 monitors through the proxy, the touchpoints of the two
copied receivers naming our copies, none of their original ids leaking.

### Receiver proxy

A copied receiver is a real ordering point, not a decorative IS-04 entry:

```
receiver R in one of the bridge's domains (the origin)
  → create a proxy receiver P in the OTHER domain (an ordinary vRX offered there)
  → someone connects a local stream to P
  → the normal channel path runs: NAT into R's domain, publish the sender
  → PATCH R over IS-05 to subscribe to the sender we just published
```

So a proxy receiver is a virtual receiver that additionally drives a remote one. The
published sender is not redundant work: it gives the stream a first-class identity in
the target domain, and R's `subscription.sender_id` then points at something a
controller over there can actually see.

R must advertise an `urn:x-nmos:control:sr-ctrl/*` control on its device, otherwise it
cannot be driven and the GUI marks it as not controllable.

**If the IS-05 patch fails the channel stays active.** The stream exists and is
published; only the remote receiver did not take it. That is reported per channel
(`remoteReceiver.error`) rather than torn down, because tearing down a working stream
because the far end was briefly unreachable is worse than leaving it running.

On teardown the remote receiver is released **before** our sender disappears — the same
ordering rule as everywhere else.

### Browsing a registry: pagination

Listing a registry's resources is not one GET. Five things have to be right, and each
one silently truncates or corrupts the result if skipped — all five are implemented in
`nmos/query-client.ts` and pinned by tests against a stub that reproduces them:

1. **A registry may cap a page.** A default cap of 10 exists in the field. Trusting the
   first response loses everything past the boundary.
2. **Only `rel="prev"` is walked.** The base response is defined as the most recently
   updated resources in descending order, so nothing newer exists from there. nmos-cpp
   advertises `rel="next"` on that page anyway, and following it returns an empty page
   every time — one wasted request per collection. A large, mostly stable registry's
   older majority only appears walking `rel="prev"`.
3. **The next URL is built from the `X-Paging-*` cursors, not taken from the `Link`
   header.** A real registry emits a malformed Link header, missing the `?` before its
   query string, which 404s if followed verbatim. The header's `rel` names are still
   used as the continue/stop signal.
4. **Cursors are sent unencoded.** They are version stamps of the form
   `<seconds>:<nanoseconds>`, and percent-encoding that colon is known to make a real
   registry stop responding.
5. **The cursor is not a strict boundary.** The resource sitting exactly at it can
   reappear as the first item of the next page, for instance when two resources share a
   version timestamp, so results are collected into a map keyed by id.

On top of that, every request states `paging.limit=1000`. The spec lets a registry cap
that, and it reports the limit it applied in `X-Paging-Limit`; nmos-cpp applies 100 where
its unstated default is 10, so a typical registry answers each collection in a single
request (measured live: 4 requests for senders, receivers, devices and flows, down from
22). Stating a limit also matters for correctness: the same registry returns a
self-contradictory `X-Paging-Since: 0:0` — "nothing older exists" — for a parameterless
request while older pages do exist, and answers correctly as soon as `paging.limit` is
stated at all. With a limit stated, `0:0` is therefore taken as the end. A registry that
refuses the parameter with 400 is asked again without it, and that is remembered for the
client's lifetime.

Every query also carries `query.downgrade=v1.0`. A Query API returns only resources
registered at its own version unless asked otherwise, so a v1.3 query hides every
device that registers at v1.2 or older. Measured on a live central registry: 4 senders
and 5 devices at plain v1.3, 148 senders and 29 devices with the downgrade. Single
lookups are downgraded too — nmos-cpp answers a plain v1.3 lookup of a v1.2 device with
409, which made a proxy unable to find that device's connection API. A registry that
refuses the parameter (400) is asked again without it, and that is remembered.

### IS-04 / IS-05 versions

| Direction | Versions |
|---|---|
| Registering our resources | v1.3 or v1.2 per registry (Settings). The payloads validate against the official v1.3 **and** v1.2 schemas, and nmos-cpp accepts them at both. |
| Reading a registry (Copy page, proxies, orphan cleanup) | the registry's version plus `query.downgrade=v1.0` — everything down to v1.0 |
| Driving a foreign receiver (proxy) | IS-05 v1.1 or v1.0, whichever the device advertises (highest wins) |
| Our own node API | IS-04 Node API v1.3, IS-05 Connection API v1.1 |

The paging statistics reach the GUI, so a registry whose pagination outruns the page
cap is visible rather than quietly returning a short list.

> These are not hypotheticals: they are the failure modes documented in
> [taqq505/nmos-simple-rds-mirror](https://github.com/taqq505/nmos-simple-rds-mirror),
> a control-plane-only IS-04 mirror that hit each of them against real registries.
> Worth reading — it solves the half of this problem we do not (metadata consistency
> without touching the fabric), and declares multicast NAT an explicit non-goal.

### End devices are never polled

The periodic work talks to registries (heartbeat every 5 s, a sync that only sends what
changed, a probe of registries no bridge uses) and to the two switches (`show
running-config section ip nat` every 30 s). It never talks to an end device.

End devices are contacted only on an event: a sender copy reads the origin's
`manifest_href` when it is created and when *Refresh* is pressed, and a receiver proxy
patches the original receiver's `/staged` when a stream is connected to it or removed.

One path used to break that rule. If the origin could not be read when a copy was
created, the failure happened before any channel existed, so nothing recorded it — and
the reconciler, which only skips copies that have a channel, fetched that device's
manifest again every 30 seconds for as long as it stayed unreachable. A failed read now
records a failed channel, which the reconciler leaves alone until Retry or Refresh. If a
working copy already exists and a refresh fails, the running stream is left untouched.

A changed SDP on the origin is followed through the registry, still without polling
the device (`federation/origin-watch.ts`): one IS-04 Query API WebSocket subscription on
`/senders` per registry that holds an original (downgraded, so v1.2 devices count). When
an original's version differs from the one its copy was built from — stored on the
channel as `originVersion` — the manifest is read once and, if the SDP changed (the `o=`
line aside), the copy is **updated in place**: same pool pair, same NAT group, so the
copy's address does not move. NAT is reprogrammed only when the original's own groups
moved. The copy's sender gets a new version (its SDP is part of its version hash), so
controllers see the change. Comparing with the stored version rather than the previous
message means changes made while the socket — or this software — was down are caught by
the registry's initial message. nmos-cpp sends that initial state in several messages and
its WebSocket on a port of its own; both are handled. A device that changes its SDP
without bumping its sender's version is not noticed; Refresh re-reads on demand and uses
the same in-place path. The Copy page shows whether each registry's feed is live.

### What is deliberately not done

- Copies are re-homed under **our** node in the target domain, with our own IDs. The
  alternative — replaying the foreign resource verbatim — would need us to heartbeat a
  node we do not own, and the target registry would garbage-collect it the moment we
  stopped.
- Resources belonging to one of our own nodes are marked `ours` when browsing, so the
  operator does not copy a copy.

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
- Fabric assignment of an SDP leg is **positional**, from the source domain's
  `firstLeg`: the first media section takes that fabric, the other leg the other one.
  For a redundant SDP the order comes from the `a=mid:` values named in `a=group:DUP`,
  which is what actually defines the primary, falling back to the order of the `m=`
  lines.

  It is deliberately *not* derived from source subnets. The configuration already states
  which domain hangs on which switch interface, so the mapping belongs to the plant
  description; inferring it from an address only adds a way to silently NAT a stream onto
  the wrong fabric.
- An SDP carrying **more than one essence** — video and audio together, say — is
  refused. Its second `m=` line is not a redundant leg, and treating it as one would NAT
  an audio group as the video's second path and publish a sender describing only the
  first essence.
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

### Requests the way a browser sends them

A browser's fetch helper typically sets `content-type: application/json` on every
request, body or not, and Fastify's default parser rejects a JSON content-type with an
empty body. That made every bodyless action in the GUI — Test, Reconcile, Remove
leftovers, Re-resolve, Retry, Refresh — fail with 400, while every check made with
`curl`, which sends no such header, passed. Both sides are fixed: the client only declares
JSON when it sends some, and the server treats an empty JSON body as an empty object. A
test drives the real routes with the browser's exact request shape, and fails without the
fix.

### A registry nothing is registered in

A bridge is the node, so a registry whose domain no bridge uses holds nothing of ours
and has nothing to heartbeat — it was never contacted, and its status said "not contacted
yet" forever, which tells the operator nothing about whether the address is right. Such
registries are now probed read-only at startup, after a settings change and on every
reconcile, and the status says "reachable — no bridge uses this domain yet".

### What costs time, and what must not

A registry that caps a page at 10 turns every listing into a sequence of round trips,
and at a few hundred milliseconds each that adds up fast. Four rules keep it out of the
operator's way:

- **A settings save must not scan.** Scanning every collection of every registry is the
  expensive operation; a save is the most frequent one. Orphan cleanup therefore runs at
  startup, on an explicit request, and when resetting — not on every save. That alone
  took saving from 8.3 s to 0.2 s.
- **Collections are scanned in parallel.** They are independent, so the six of them are
  fetched at once rather than one after another: 9.0 s to 1.5 s.
- **A page limit is a property of the registry, not of a collection.** It is learned
  once and reused, instead of probing again for every collection.
- **A resource's `version` changes only when its content does.** The builders stamp the
  current time by default, so every rebuild produced a new version and the reconciler
  re-registered the whole tree every 30 seconds — a registry watching our resources
  "update" forever for no reason. Content is hashed and the version reused when it
  matches, and a registration whose version the registry already holds is not sent at
  all. A reconcile now sends nothing when nothing changed.

### Idempotence and the reconciler

The software keeps a persisted desired state (`state.json` in the volume). A
reconciler loop (interval plus triggers) compares desired against actual:

- switch actual state from `show running-config section ip nat`,
- registry actual state per registry from our own bookkeeping plus heartbeat replies.

Deviations are corrected, not just logged. That is what lets the system survive a
container restart, a switch reload and a registry restart without hand-holding.

The reconciler is the safety net, not the delivery path. An activation syncs every
registry it touches before the PATCH answers — the target registries for the sender,
and the source domain's for the virtual receiver, whose `subscription` changes with
every switch. Before that was the case, a controller reading the connection from the
registry saw it up to one reconcile interval (30 s) late. Registries are synced in
parallel; order only matters within one registry.

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
| `a=ts-refclk:ptp=…` | passed through unchanged |
| `a=mediaclk:` | unchanged |

With **NAT disabled** there is no transformation: the SDP is copied verbatim and the
vTX points at the original addresses. That is the case for networks that are already
routed between the two houses.

> The PTP question is real: both houses must be locked to the same time (TAI),
> otherwise the stream arrives on the target side but its timestamps do not match the
> local grandmaster. Rewriting `ts-refclk` would only paper over a receiver's
> plausibility check without changing the physics, so it is passed through as-is and the
> timing stays an operational matter.

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
      "switchInterface": { "red": "Vlan101", "blue": "Vlan102" },
      "pool": { "base": "239.201.0.0", "pairs": 64,
                "sourceNat": { "red": "10.1.1.100", "blue": "10.1.2.100" } },
      "firstLeg": "red", "enabled": true },

    { "id": "partnerA", "label": "Partner A", "kind": "external",
      "iface": { "name": "eth1", "address": "10.9.0.10" },
      "switchInterface": { "red": "Vlan901", "blue": "Vlan902" },
      "pool": { "base": "239.200.0.0", "pairs": 64,
                "sourceNat": { "red": "10.9.1.100", "blue": "10.9.2.100" } },
      "firstLeg": "red", "enabled": true },

    { "id": "partnerB", "label": "Partner B", "kind": "external", "…": "…" }
  ],

  // Several registries per domain is the normal case when partners share a network.
  // The URL is derived from ip/port/tls — see "Registry addresses" below.
  "registries": [
    { "id": "int",   "label": "Internal registry", "domainId": "internal",
      "mode": "dnssd", "domain": "", "version": "v1.3", "enabled": true },
    { "id": "regA1", "label": "Partner A primary", "domainId": "partnerA",
      "mode": "manual", "ip": "10.9.0.20", "port": 8010, "version": "v1.3", "enabled": true },
    { "id": "regA2", "label": "Partner A backup",  "domainId": "partnerA",
      "mode": "manual", "ip": "10.9.0.21", "port": 8010, "tls": false, "version": "v1.3", "enabled": true }
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

  "bridges": [
    { "id": "1", "label": "Eigenes Haus ⇄ Partner A",   // the NMOS node's name
      "domains": ["internal", "partnerA"],              // no direction — each port has one
      "registries": ["regA1"],     // per domain: listed ones, or all when none of it is listed
      "nat": true,                 // per-bridge switch, on top of the global one
      "enabled": true }
  ],
  "devices": [{ "id": "…", "label": "Kameras", "bridgeId": "1", "receiverIds": ["…"] }],
  "receivers": [
    { "id": "…", "label": "Kameras 1", "deviceId": "…", "format": "video", "enabled": true,
      "side": "internal" }         // offered here; the stream flows to the other domain
  ]

  // Older files with a directed bridge (sourceDomain/targetDomain/targetRegistries) are
  // migrated on load: domains in the old order, registries kept, every receiver offered
  // on the old source side.
}
```

### Registry addresses

A manually configured registry is given an `ip` and a `port`, not a URL — the same
shape NMOS Crosspoint uses for its static registries. The base URL is assembled from
`ip`, `port` and `tls`:

| Field | Meaning |
|---|---|
| `ip` | IP or hostname; an IPv6 literal is bracketed automatically |
| `port` | registration API port; defaults to **8010** (nmos-cpp with one `http_port`) |
| `tls` | `https` instead of `http`; the scheme's default port is then left out of the URL |
| `queryPort` | port of the query API, if it differs from the registration port — nmos-cpp only shares one when configured with a single `http_port` |

A DNS-SD registry carries no address at all: it is resolved through discovery, and the
query API used for browsing resolves through the **same** resolver. Looking only at
`ip`/`port` there is what made browsing a discovered registry fail with "no IP
configured" — true, and useless.

There is no search-domain setting. The host's own search domains are used, which under
`network_mode: host` are the ones DHCP handed out, and that is the answer in every real
deployment.

Deriving the URL rather than storing it means there is one place that decides how an
address is formed, and the GUI can show the result while it is being typed. A
configuration that still carries a legacy `url` is parsed into these fields when it is
loaded, so an existing deployment keeps working.

### Discovery

DNS-SD is harder than it looks, and three separate things have to be right:

1. **It is a two-step lookup.** The service name carries a PTR record pointing at
   instance names; SRV and TXT hang off the *instance*. Asking for SRV directly on
   `_nmos-register._tcp.<domain>` finds nothing on a correctly configured server.
2. **`.local` is mDNS and cannot go through `node:dns` at all** — that resolver does
   unicast only. The multicast path needs its own socket, so both mechanisms are
   implemented and both are queried.
3. **TXT decides the outcome.** `api_proto` picks http vs https, `api_ver` says whether
   the registry speaks our version, and `pri` orders candidates — lower wins, and
   `>= 100` means "not for production", which is filtered out.

**Unicast always ranks above mDNS**, whatever the `pri` values. Unicast DNS-SD is the
administratively configured answer; mDNS is opportunistic and fragile across subnets, and
an mDNS announcement with a better `pri` must not override what the network's DNS says.
`pri` only orders registries announced the same way. The status shows which mechanism
produced the address in use.

Both service names are queried: `_nmos-register._tcp` and the pre-v1.3
`_nmos-registration._tcp`, which is what nmos-cpp still advertises.

**The search domains come from the host**: the `search` and `domain` lines of
`/etc/resolv.conf`, which under `network_mode: host` are the ones DHCP handed out. There
is nothing to configure.

#### Two things that bite in practice

- **mDNS is missed on the first try.** Responders suppress duplicate questions and a
  freshly started process routinely gets nothing back — which is exactly the situation
  at server startup. The query is therefore sent three times, staggered across the
  listening window.
- **An announcement can name a host you cannot resolve.** When an mDNS reflector
  carries announcements across a subnet boundary it forwards the service records but
  not the host's A record, and the host does not answer an A query either because it is
  not on your link. The SRV target is then a `.local` name that will only ever time out.
  Three fallbacks, in order: the A record from the announcement; an explicit A query;
  and finally the address embedded in the instance name, which nmos-cpp provides as
  `nmos-cpp_registration_<ip-with-dashes>_<port>`. The last one is a guess and is
  labelled as such in the GUI. If none works, the candidate is reported with a note
  saying to configure ip/port instead.

`GET /api/discovery` runs discovery on demand and returns the candidates, the host's
search domains **and every name that was queried** — a discovery failure is only
actionable if you can see what was asked for. `POST /api/discovery/refresh` drops
cached addresses so the next contact resolves again.

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
  follows. A domain whose address is not on the host yet — after a reboot Docker
  typically starts the container before DHCP has configured the interface — is retried
  every 5 s; once it binds, the registries are resynced so the href carries the real
  port.
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
6. ✅ Direct registry-to-registry copies: sender copies and receiver proxies
7. BCP-008-01 (`NcReceiverMonitor` per vRX)
8. The external→external transit case in production, failover across several
   registries
9. Optional: IS-09 system API, authentication (IS-10) for the external domains

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
3. **PTP across domain boundaries** — `ts-refclk` is passed through unchanged. Both
   houses have to be locked to the same TAI; that is an operational requirement, not
   something the gateway can fix.
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
