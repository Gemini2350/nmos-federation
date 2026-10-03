# NMOS Federation

A gateway for exchanging individual signals between separate ST 2110 / NMOS systems.

The software runs **virtual NMOS receivers** in one domain and mirrors every source
connected to them as a **virtual NMOS sender** in another domain — there into any
number of registries. The essence path does not run through the software: it goes
over **multicast NAT on the switch** (Arista EOS, red and blue fabric kept separate).
The software only drives registration, address allocation and switch configuration.

A **domain** is a network with its own interface, its own address pool and its own L3
interface per switch: exactly one internal, any number of external, and 1..n
registries per domain.

```
  domain "internal"                      domain "partnerA"  (…partnerB, …)
  ┌───────────────────┐                  ┌───────────────────┐
  │ real sender       │                  │ real receiver     │
  │ 239.10.1.5:5004   │                  │ joins 239.200.0.0 │
  └─────────┬─────────┘                  └─────────▲─────────┘
            │ switch joins via IGMP/PIM            │
  ┌─────────▼──────────────── switch ──────────────┴─────────┐
  │  ip nat destination static 239.10.1.5 → 239.200.0.1      │  (once per fabric)
  └──────────────────────────────────────────────────────────┘
            ▲                                      ▲
  ┌─────────┴─────────┐  eAPI            ┌──────────┴────────┐
  │ internal registry │◄── nmos-federation ──►│ registries 1..n │
  │ virtual receivers │   (Docker, web GUI)   │ virtual senders │
  └───────────────────┘                       └─────────────────┘
```

- Concept, data model and workflows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Working notes for Claude Code: [CLAUDE.md](CLAUDE.md)

## Quick start on a Docker host

```bash
git clone https://github.com/Gemini2350/nmos-federation.git
cd nmos-federation
docker compose up -d --build
```

Then open `http://<host>:8080` and configure it under **Settings**:

1. **Domains** — one internal, one per partner network. Each needs an interface name,
   the IP its node API is reachable on, the red/blue source subnets, the L3 interface
   per switch, and a multicast pool whose base address is **even**.
2. **Registries** — assign each to a domain and give it an **IP and port** (or use
   DNS-SD). The URL is assembled for you and shown next to the fields; the port
   defaults to 8010, which is what nmos-cpp uses with a single `http_port`. Several
   registries per domain are fine.
3. **NAT and switches** — host and credentials per fabric, plus the NAT group range.
   Leave the driver on `mock` at first: the software then logs the switch commands
   instead of sending them, which lets you see the whole federation in your
   controller without touching the network.

The **Channels** page shows a status line per registry — resolved address, state,
how many of our resources it holds, the age of the last heartbeat and the last error —
plus a Test button that probes one registry without changing anything.

Then create a **device** (source domain → target domain) and add virtual receivers to
it. They appear in the registry immediately; connecting a source to one of them with
your usual controller creates the virtual sender on the other side.

`network_mode: host` is required — the software needs one interface with a real IP
per domain (node href, manifest fetch, mDNS). Configuration and state live in
`./config`.

## Ports

| Port | Purpose |
|---|---|
| 8080 | web GUI + REST + WebSocket, bound to 0.0.0.0 |
| 8081 | NMOS node/connection API, one listener per domain on that domain's IP |

## Status

Working with the mock switch driver: virtual receivers are registered, an IS-05
connection to one of them programs NAT on both fabrics, rewrites the SDP and
publishes the virtual sender in the target registries; disabling it tears everything
down in reverse order. 38 offline tests, including the full chain against a stub
registry.

Still open: the eAPI driver is unverified against real hardware (see below),
BCP-008-01 monitoring is missing, discovery is limited to unicast DNS-SD, and of the
IS-05 activation modes only `activate_immediate` is implemented.

> ⚠ Multicast NAT on the target platform (DCS-7060SX2) is not proven yet: the CLI
> accepts the rule, but `show ip nat translation` stays empty — see
> `docs/ARCHITECTURE.md`, open point 1.

## Development

```bash
cd server && npm install && npm test   # offline tests
cd server && npm run dev               # backend with the mock switch, GUI on :8080
cd ui && npm run dev                   # GUI dev server
```

The commands the driver would send can be printed without running the software, for
cross-checking on the hardware:

```bash
cd server && npm run switch:preview -- --ingress Vlan101 --egress Vlan901
```

## License

MIT
