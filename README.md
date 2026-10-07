<picture>
  <source media="(prefers-color-scheme: dark)" srcset="ui/public/icon-dark.svg">
  <img src="ui/public/icon.svg" alt="" width="84" align="right">
</picture>

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

1. **Domains** — one for your own facility, one per partner network. Pick **our IP in
   this network** from the host's interfaces; that is where this software publishes its
   own node API for that domain. The ID next to the name is an internal key that devices
   refer to, so it follows the name while the entry is new and is fixed once saved.
2. **Registries** — assign each to a domain and give it an **IP and port**, or use
   **DNS-SD**. The URL is assembled for you and shown next to the fields; the port
   defaults to 80. Several registries per domain are fine.

   DNS-SD needs no address and no search domain: the host's own search domains are used,
   which under `network_mode: host` are the ones DHCP handed out. *Discover now* shows
   what was found and every name that was queried, so a miss is diagnosable. Both unicast
   DNS-SD and mDNS (`.local`) are tried, and both the current `_nmos-register._tcp` and
   the older `_nmos-registration._tcp` service name.

   A fresh install starts with its registry **disabled**, so nothing is announced until
   you have checked the domain's address and switched it on.
3. **NAT**, at the bottom of the page — this is where the plant is described: host and
   credentials per switch, and per domain its **L3 interface on each switch**, which
   fabric the **first `m=` line** of an incoming SDP belongs to, and the multicast
   **pool** (base address must be even). Leave the driver on `mock` at first: the
   software then logs the switch commands instead of sending them, which lets you see
   the whole federation in your controller without touching the network.

The **Channels** page shows a status line per registry — resolved address, state,
how many of our resources it holds, the age of the last heartbeat and the last error —
plus a Test button that probes one registry without changing anything.

Then create a **bridge** between your domain and a partner's — that is the NMOS node
every registry will show. It carries streams **both ways**. Add **devices** under it, and
virtual receivers into those; each receiver is offered in one of the two domains and its
stream flows to the other. The receivers appear in the registry immediately; connecting
a source to one of them with your usual controller creates the virtual sender on the
other side.

```
Bridge "Eigenes Haus ⇄ Partner A"   ← the node, named by you
  ├─ Device "Kameras"               ← one NMOS device, ports in either direction
  └─ Device "Ton"
```

## Copying existing resources

The **Copy** page is the second operating mode: browse a registry and copy what is
already there, without going through a virtual receiver.

- **Sender copy** — reads the original's SDP from its manifest, NATs the stream into
  the bridge's other domain and publishes the copy there. *Refresh* re-reads the manifest if
  the origin changed.
- **Receiver proxy** — creates a proxy receiver in the bridge's other domain. Connect a stream
  to it and the original receiver in the other registry is driven over IS-05, so the
  essence actually arrives. The original has to advertise an `sr-ctrl` control;
  receivers that do not are shown as not controllable.

Both hang off a device, and through it off its bridge, which supplies the registries and
the NAT setting. The direction comes from the registry you copy from: a copy always runs
into the bridge's other domain. Each copy can be renamed and given its own registries.

`network_mode: host` is required — the software needs one interface with a real IP
per domain (node href, manifest fetch, mDNS). Configuration and state live in
`./config`.

### Autostart

The container already comes back after a reboot (`restart: unless-stopped`), as long as
Docker itself starts at boot: `sudo systemctl enable docker`.

To also **update** at boot — `git pull`, then rebuild and restart — install the systemd
unit:

```bash
sudo deploy/install-autostart.sh            # update + start at every boot
sudo deploy/install-autostart.sh --nightly  # additionally every night at 04:00
sudo deploy/install-autostart.sh --remove   # uninstall
```

It runs as the user owning the checkout (who must be in the `docker` group), waits for
the network and the Docker daemon, and treats a failed pull as non-fatal — with no network
at boot the container still starts on the version already checked out. `--ff-only` means
local changes on the host never turn into a merge commit. Log: `journalctl -u
nmos-federation-update`.

Be aware what this means: whatever is on `main` deploys itself on the next boot. For a
gateway in a running facility, consider checking out a tag you have tested instead of
`main`, so an update only happens when you move it.

## Starting over

Configuration and state live in `./config`, mounted into the container at `/config`.

**The clean way** is *Settings → Maintenance → Factory reset*. It tears down every
channel, unregisters everything this installation put into the registries, and only then
wipes configuration and state — in that order, because the node ids derive from the
state, so wiping first would leave resources in the registries that nobody can identify
any more.

**By hand**, if the GUI is not reachable:

```bash
docker compose down
rm -rf config
docker compose up -d --build
```

This leaves whatever was registered behind, since nothing is left to unregister it. The
registry's own garbage collection removes a node once its heartbeat stops, so it clears
within a minute or two — and *Maintenance → Remove leftovers* clears it immediately.

Upgrading does **not** need either: an older `config.json` keeps working. A registry's
full `url` is migrated into address and port, fields that no longer exist are dropped,
and string ids like `internal` stay valid — they are opaque keys.

**Remove leftovers**, next to it, is the narrower tool: it asks each registry for
everything belonging to our nodes and deletes whatever the current configuration does not
call for. That is the only way resources from an earlier run can be found at all — the
record of what was registered is not kept across a restart, so they have to be identified
by querying the registry.

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
