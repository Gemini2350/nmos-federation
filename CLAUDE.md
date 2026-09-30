# CLAUDE.md — NMOS Federation

Gateway für punktuellen Signalaustausch zwischen getrennten ST-2110/NMOS-Systemen.
Vollständiges Konzept: `docs/ARCHITECTURE.md` — bei Architekturfragen dort nachsehen,
nicht neu erfinden.

## Kurzfassung

Virtuelle NMOS-Receiver in einer Domäne; wird darauf geschaltet, entsteht ein
virtueller NMOS-Sender in einer anderen Domäne mit umgeschriebenem SDP. Der
Medienpfad läuft über Multicast-NAT auf Switches (eAPI), Red und Blue getrennt,
Adressen paarweise aus dem Pool der Ziel-Domäne (gerade = blue, ungerade = red).

**Domäne** = ein Netz mit eigenem Interface, eigenem Pool und eigenem L3-Interface je
Switch. Genau eine interne, beliebig viele externe; pro Domäne 1..n Registries.
Mehrere Partner im selben Netz = eine Domäne mit mehreren Registries; Partner in
getrennten Netzen = mehrere Domänen.

## Struktur

```
server/src/
  federation/engine.ts      Orchestrator: Statemachine, Registrierungen, Reconcile
  federation/pool.ts        Pärchen-Allokator + NatGroupAllocator
  federation/pools.ts       PoolManager: ein Pool je Domäne, NAT-Groups global
  federation/channel.ts     buildChannelPlan — reine Plan-Ableitung, ohne Netzwerk
  federation/state.ts       persistierter State: seed, Channels, IS-05-Zustände
  nmos/sdp.ts               SDP parsen (inkl. rtpmap/fmtp) + Gruppen/Quellen ersetzen
  nmos/resources.ts         IS-04-Ressourcen, Essence aus SDP, deterministische UUIDv5
  nmos/registry-client.ts   IS-04 Registration + Heartbeat + DNS-SD
  nmos/node-api.ts          IS-04 Node API, IS-05 vRX/vTX, /transportfile
  switch/driver.ts          Treiber-Interface program/unprogram/readState
  switch/arista-eapi.ts     eAPI runCmds, Kommando-Templates
  switch/mock.ts            protokolliert nur — Federation ohne Hardware testbar
  tools/switch-preview.ts   druckt die EOS-Kommandos eines Channels
  config/                   Domänen, Registries, NAT, Validierung
  api/rest.ts               REST + WebSocket fürs GUI
ui/                         Vue 3 + Vite: Channels, Devices, Einstellungen
```

Alles ohne Hardware testbar: `switch/mock.ts` protokolliert die Kommandos,
`engine.test.ts` fährt die ganze Kette gegen eine Stub-Registry.

## Regeln

- **IDs sind persistent.** UUIDv5 aus Node-UUID + logischem Schlüssel. Ein
  Container-Neustart darf keine Controller-Zuordnung zerreißen.
- **Adressen kommen aus dem Pool der ZIEL-Domäne** — sie müssen in dem Netz gültig
  sein, in dem der Sender entsteht.
- **NAT-Group-Nummern gelten pro Switch, nicht pro Domäne.** Deshalb ein globaler
  Allokator (`NatGroupAllocator`), nie ein Ableiten aus dem Pool-Index.
- **Ingress = Quell-Domäne, Egress = Ziel-Domäne**, beides Interfaces auf demselben
  Switch. Es gibt keine intern/extern-Sonderbehandlung mehr.
- **Abbau ist die exakte Umkehrung des Aufbaus**, und der vTX wird immer *zuerst*
  abgemeldet — sonst schaltet jemand auf einen bereits toten Strom.
- **Eine ausgefallene Registry darf einen Channel nicht kippen.** Je Registry ein
  eigener Client mit eigenem Heartbeat; Fehlendes zieht der Reconciler nach.
- **Pool-Freigabe nur über den PoolManager**, nie durch direktes Editieren des State.
- **Switch-Kommandos gehören in `switch/arista-eapi.ts`**, nirgends sonst.
- **Die Konfiguration ist ein Provider, kein Snapshot.** `Engine` bekommt
  `config: () => store.current`; ein `store.save()` ersetzt das Objekt. Wer die
  Config als Referenz festhält, sieht Settings-Änderungen nie — genau dieser Bug
  hat die über die REST-API angelegten Receiver in der Node API verschwinden lassen.
- **Zwei Ports:** `port` (GUI/REST, 0.0.0.0) und `nmosPort` (Node/Connection API, je
  Domäne an die IP dieser Domäne gebunden). Liegen zwei Domänen auf derselben IP,
  nimmt die zweite den nächsten freien Port; der `href` folgt dem.

## Befehle

```bash
cd server && npm install && npm test     # Offline-Tests (Pool, SDP, Plan)
cd server && npm run dev                 # Backend mit Mock-Switch
cd server && npm run switch:preview      # EOS-Kommandos eines Channels ausgeben
curl -s localhost:8080/api/status        # Registries, Switches, Pool-Füllstand
cd ui && npm run dev                     # GUI-Dev-Server
docker compose up -d --build
```

## Nicht vergessen

Auf der Zielhardware (DCS-7060SX2-48YC6, EOS 4.35.1F) nimmt die CLI
`ip nat destination static` **an**, die Regel erscheint aber **nicht** in
`show ip nat translation`. Ob sie in Hardware programmiert wird, ist offen und
entscheidet sich am Traffic-Test — bis dahin gilt der eAPI-Treiber nicht als
tragfähig. Stand und nächste Schritte: `docs/ARCHITECTURE.md`, offener Punkt 1.
