# CLAUDE.md — NMOS Federation

A gateway for exchanging individual signals between separate ST 2110 / NMOS systems.
Full concept: `docs/ARCHITECTURE.md` — look there for architecture questions instead
of reinventing them.

## In short

Virtual NMOS receivers live in one domain; connect a source to one and a virtual
sender with a rewritten SDP appears in another domain. The essence path runs over
multicast NAT on the switches (eAPI), red and blue separately, addresses handed out
in pairs from the target domain's pool (even = blue, odd = red).

**Domain** = a network with its own interface, its own pool and its own L3 interface
per switch. Exactly one internal, any number of external; 1..n registries per domain.
Several partners in the same network = one domain with several registries; partners
in separate networks = several domains.

## Layout

```
server/src/
  federation/engine.ts      orchestrator: state machine, registrations, reconcile
  federation/pool.ts        pair allocator + NatGroupAllocator
  federation/pools.ts       PoolManager: one pool per domain, NAT groups global
  federation/channel.ts     buildChannelPlan — pure plan derivation, no network
  federation/state.ts       persisted state: seed, channels, IS-05 states
  nmos/sdp.ts               SDP parsing (incl. rtpmap/fmtp) + group/source rewrite
  nmos/resources.ts         IS-04 resources, essence from SDP, deterministic UUIDv5
  nmos/registry-client.ts   IS-04 registration + heartbeat + DNS-SD
  nmos/node-api.ts          IS-04 node API, IS-05 vRX/vTX, /transportfile
  switch/driver.ts          driver interface program/unprogram/readState
  switch/arista-eapi.ts     eAPI runCmds, command templates
  switch/mock.ts            logs only — federation testable without hardware
  tools/switch-preview.ts   prints a channel's EOS commands
  config/                   domains, registries, NAT, validation
  api/rest.ts               REST + WebSocket for the GUI
ui/                         Vue 3 + Vite: channels, devices, settings
```

Everything is testable without hardware: `switch/mock.ts` logs the commands and
`engine.test.ts` drives the whole chain against a stub registry.

## Rules

- **IDs are persistent.** UUIDv5 from the node UUID plus a logical key. A container
  restart must not break a controller's bindings.
- **Addresses come from the TARGET domain's pool** — they must be valid in the
  network where the sender appears.
- **NAT group numbers are per switch, not per domain.** Hence a global allocator
  (`NatGroupAllocator`), never derived from the pool index.
- **Ingress = source domain, egress = target domain**, both interfaces on the same
  switch. There is no internal/external special case any more.
- **Teardown is the exact reverse of setup**, and the virtual sender is always
  unregistered *first* — otherwise someone connects to a stream that is already dead.
- **A registry that is down must not take a channel with it.** One client with its
  own heartbeat per registry; the reconciler catches up on what is missing.
- **Release pool entries only through the PoolManager**, never by editing state.
- **Switch commands belong in `switch/arista-eapi.ts`** and nowhere else.
- **The configuration is a provider, not a snapshot.** `Engine` receives
  `config: () => store.current`; a `store.save()` replaces the object. Holding the
  config by reference means never seeing settings changes — that exact bug made
  receivers created through the REST API vanish from the node API.
- **Two ports:** `port` (GUI/REST, 0.0.0.0) and `nmosPort` (node/connection API,
  bound per domain to that domain's IP). If two domains share an IP, the second takes
  the next free port and its `href` follows.
- **`.dockerignore` matters.** Without it the build context carries both
  `node_modules` trees and "load build context" takes minutes on a virtiofs-backed
  Docker host.

## Commands

```bash
cd server && npm install && npm test     # offline tests (pool, SDP, plan, engine)
cd server && npm run dev                 # backend with the mock switch
cd server && npm run switch:preview      # print a channel's EOS commands
cd ui && npm run dev                     # GUI dev server
docker compose up -d --build
curl -s localhost:8080/api/status        # registries, switches, pool usage
```

## Do not forget

Multicast NAT on Arista is platform dependent, and the target platform
(DCS-7060SX2, Tomahawk+) is not on Arista's NAT list. On the box the CLI **accepts**
`ip nat destination static`, but `show ip nat translation` stays **empty** — whether
it is programmed in hardware is decided by a traffic test. Until then the eAPI driver
does not count as proven. See `docs/ARCHITECTURE.md`, open point 1.
