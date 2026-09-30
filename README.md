# NMOS Federation

Gateway zum punktuellen Signalaustausch zwischen getrennten ST-2110/NMOS-Systemen.

Die Software betreibt **virtuelle NMOS-Receiver** in einer Domäne und spiegelt jede
darauf geschaltete Quelle als **virtuellen NMOS-Sender** in eine andere Domäne — dort
in beliebig viele Registries. Der eigentliche Essence-Pfad läuft nicht durch die
Software, sondern über **Multicast-NAT auf dem Switch** (Arista EOS, Red- und
Blue-Fabric getrennt) — die Software steuert nur Registrierung, Adressvergabe und
Switch-Konfiguration.

Eine **Domäne** ist ein Netz mit eigenem Interface, eigenem Adress-Pool und eigenem
L3-Interface je Switch: genau eine interne, beliebig viele externe, pro Domäne 1..n
Registries.

```
  Domäne "internal"                      Domäne "partnerA"  (…partnerB, …)
  ┌───────────────────┐                  ┌───────────────────┐
  │ realer Sender     │                  │ realer Receiver   │
  │ 239.10.1.5:5004   │                  │ joint 239.200.0.4 │
  └─────────┬─────────┘                  └─────────▲─────────┘
            │ IGMP/PIM-Join durch Switch           │
  ┌─────────▼──────────────── Arista ──────────────┴─────────┐
  │  ip nat destination static 239.10.1.5 → 239.200.0.4      │  (je Fabric 1x)
  └──────────────────────────────────────────────────────────┘
            ▲                                      ▲
  ┌─────────┴─────────┐  eAPI            ┌──────────┴────────┐
  │ interne Registry  │◄── nmos-federation ──►│ Registries 1..n  │
  │ virt. Receiver    │   (Docker, WebGUI)    │ virt. Sender     │
  └───────────────────┘                       └──────────────────┘
```

- Konzept, Datenmodell und Abläufe: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Arbeitsnotizen für Claude Code: [CLAUDE.md](CLAUDE.md)

## Status

Lauffähig mit Mock-Switch: virtuelle Receiver werden in der Registry angemeldet, eine
IS-05-Schaltung darauf programmiert NAT auf beiden Fabrics, schreibt das SDP um und
veröffentlicht den virtuellen Sender in den Ziel-Registries; Abschalten baut alles in
umgekehrter Reihenfolge ab. 38 Offline-Tests, darunter die komplette Kette gegen eine
Stub-Registry.

Noch offen: der eAPI-Treiber ist gegen echte Hardware nicht verifiziert (siehe unten),
BCP-008-01-Monitoring fehlt, DNS-SD-Discovery ist auf Unicast beschränkt, und von den
IS-05-Aktivierungsmodi ist nur `activate_immediate` implementiert.

⚠ Multicast NAT auf der Zielplattform (DCS-7060SX2) ist noch nicht bewiesen: die CLI
nimmt die Regel an, `show ip nat translation` bleibt aber leer — siehe
`docs/ARCHITECTURE.md`, offener Punkt 1.

```bash
cd server && npm install && npm test
cd server && npm run dev          # Backend mit Mock-Switch, GUI auf :8080
```

Die EOS-Kommandos, die der Treiber senden würde, lassen sich ohne laufende Software
ausgeben — zum Gegentesten auf der Hardware:

```bash
cd server && npm run switch:preview -- --ingress Vlan101 --egress Vlan901
```

## Ports

| Port | Was |
|---|---|
| 8080 | WebGUI + REST + WebSocket, an 0.0.0.0 |
| 8081 | NMOS Node/Connection API, je Domäne an die IP dieser Domäne gebunden |
