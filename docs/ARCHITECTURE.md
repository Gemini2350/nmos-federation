# NMOS Federation — Architektur

Stand 2026-08-24. Dieses Dokument ist die Referenz für Datenmodell, Abläufe und
offene Entscheidungen. Code-Gerüst folgt dieser Struktur 1:1.

---

## 1. Aufgabe

Mehrere voneinander getrennte ST-2110-Systeme mit **je eigener NMOS-Registry,
eigenem Multicast-Adressplan und eigener PTP-Domain** sollen punktuell Signale
austauschen. Kein Trunk, kein zusammengelegtes Netz — nur einzelne, kontrolliert
freigegebene Ströme.

Die Software ist dabei **Broker, nicht Medienpfad**:

| Aufgabe | Wer macht es |
|---|---|
| Signalisierung (IS-04/IS-05) | nmos-federation |
| Adressvergabe aus Federation-Pool | nmos-federation |
| Multicast-NAT, IGMP/PIM | Switch, konfiguriert per eAPI |
| Essence-Transport | Switch-Hardware, wire-speed |

## 2. Grundbegriffe

- **Domäne** — ein Netz mit eigener Registry-Sicht: eigenes Interface, eigener
  Federation-Pool, eigenes L3-Interface auf beiden Switches. Genau eine Domäne ist
  die interne, dazu kommen **beliebig viele externe**.
- **Registry** — gehört zu genau einer Domäne. Pro Domäne sind mehrere Registries
  möglich und der Normalfall, wenn mehrere Partner im selben Netz hängen.
- **Virtueller Receiver (vRX)** — NMOS-Receiver, den die Software in einer Domäne
  registriert. Er ist der Bestellpunkt: der Anwender schaltet mit seinem gewohnten
  Controller (z. B. NMOS-Crosspoint) eine echte Quelle darauf.
- **Virtueller Sender (vTX)** — der aus dieser Schaltung entstehende Sender in der
  Ziel-Domäne. Existiert nur, solange der vRX aktiv geschaltet ist.
- **Federation Channel** — das Paar (vRX, vTX) samt Pool-Reservierung und
  Switch-Programmierung. Der Channel ist die zentrale Zustandseinheit.
- **Fabric** — `red` oder `blue`, die beiden ST-2022-7-Wege. Zwei getrennte Switches,
  zwei getrennte NAT-Konfigurationen, eine gemeinsame Adress-Logik.

### Warum Domänen und nicht "intern/extern"

Ein einzelnes Begriffspaar trägt nur, solange alle Partner im selben Netz liegen.
Sobald zwei Partnersysteme in **getrennten** Netzen hängen, braucht jedes ein eigenes
Interface, einen eigenen Adress-Pool und ein eigenes Egress-Interface auf den
Switches. Beides fällt mit dem Domänen-Modell zusammen:

| Situation | Modellierung |
|---|---|
| Mehrere Partner-Registries im selben Netz | **eine** externe Domäne, mehrere Registries |
| Partner in getrennten Netzen | **mehrere** externe Domänen, je 1..n Registries |

## 3. Richtung eines Channels

Ein Channel läuft immer von einer **Quell-Domäne** in eine **Ziel-Domäne**. Der vRX
lebt in der Quell-Domäne, der vTX entsteht in der Ziel-Domäne, die Adressen kommen
aus dem Pool der Ziel-Domäne.

```
internal → partnerA     interne Quelle für Partner A freigeben
partnerA → internal     Signal von Partner A ins eigene Haus holen
partnerA → partnerB     Transit, technisch derselbe Fall
```

Ein **Federation Device** hat genau eine Quell- und eine Ziel-Domäne und darin eine
beliebige Auswahl an Ziel-Registries. Fan-out in zwei **getrennte Netze** ist bewusst
kein Device-Feature: das braucht zwei NAT-Übersetzungen, zwei Pool-Reservierungen und
zwei Sender — also zwei Devices. Fan-out an mehrere Registries **im selben Netz** ist
dagegen nur eine Mehrfachregistrierung desselben vTX und wird direkt unterstützt.

## 4. NMOS-Ressourcenmodell

Die Software ist ein NMOS-**Node pro Domäne**.

```
Node(internal)                        Node(partnerA)              Node(partnerB)
  href = http://<int-ip>:8080           href = http://<extA>:8080   …
  ├─ Device "Federation IN"             ├─ Device "Federation IN ▸ mirror"
  │    └─ vRX 1..n                      │    └─ vTX 1..n
  └─ Device "Federation OUT ▸ mirror"   └─ Device "Federation OUT"
       └─ vTX 1..n                           └─ vRX 1..n
```

Warum Node pro Domäne und nicht eine Node-UUID in allen Registries: `node.href`,
`api.endpoints` und `interfaces` müssen **aus der jeweiligen Domäne erreichbar** sein.
Ein externer Controller muss das Manifest (`/transportfile`) des vTX abrufen können,
also über die IP dieser Domäne. Mehrere Registries **innerhalb** einer Domäne teilen
sich dagegen denselben Node — sie sehen dasselbe Netz.

### Devices

Der Anwender legt Devices selbst an (Name, Quell-Domäne, Ziel-Domäne, Ziel-Registries,
NAT ja/nein) und weist ihnen einzelne vRX zu. Zu jedem Device erzeugt die Software
automatisch ein **Spiegel-Device in der Ziel-Domäne**, das die zugehörigen vTX trägt;
der Name ist ableitbar und überschreibbar. So bleibt im Fremdsystem sichtbar, welche
Signale zusammengehören.

### Ressourcen je Channel

Ein aktiver Channel erzeugt in der Ziel-Domäne `source` → `flow` → `sender`. Die
Parameter (`format`, `media_type`, `frame_width/height`, `exactframerate`, `sampling`,
`depth`, `colorimetry`, Audio: `channels`/`sample_rate`) werden aus dem eingehenden
SDP abgeleitet, nicht geraten. Gelingt das Parsen nicht, geht der Channel in `failed`
statt einen falsch beschriebenen Sender zu veröffentlichen.

### Registrierung

- IS-04 Registration API v1.3, POST `/x-nmos/registration/v1.3/resource`,
  Heartbeat alle 5 s auf `/health/nodes/<id>`.
- Registry-Adresse je Registry-Eintrag: **manuelle URL** (Regelfall extern) oder
  Unicast-DNS-SD/mDNS (Regelfall intern).
- Jede Registry hat **ihren eigenen Client mit eigenem Heartbeat**. Fällt eine von
  drei externen Registries aus, laufen die anderen weiter; der Channel bleibt aktiv
  und meldet im GUI, in welcher Registry er gerade nicht publiziert ist.
- Heartbeat 404 → diese Registry wurde neu gestartet → nur dort alles neu registrieren.
- Beim Start: Orphan-Cleanup je Registry — Ressourcen mit unserer Node-UUID, die
  nicht im persistierten State stehen, werden gelöscht.
- IDs sind **deterministisch und persistent** (UUIDv5 aus Node-UUID + logischem
  Schlüssel), damit Controller-Zuordnungen einen Container-Neustart überleben. Ein
  vTX trägt in allen Registries **derselben Domäne** dieselbe ID.

### IS-05

- **vRX**: vollständige Connection API v1.1 (`staged`, `active`, `constraints`,
  `transporttype`, `bulk`). Aktivierung nimmt `transport_file` (SDP) entgegen —
  das ist der Auslöser der gesamten Federation-Kette. `master_enable=false`
  räumt ab.
- **vTX**: `active`/`staged` read-mostly plus `/transportfile` mit dem
  transformierten SDP. Ein externer Controller darf den vTX nicht umkonfigurieren;
  Änderungsversuche werden mit 423/400 abgewiesen (Entscheidung, siehe offene Punkte).

## 5. Multicast-Pools

**Ein Pool pro Domäne** — er beschreibt die Adressen, die vergeben werden, wenn ein
Sender *in dieser Domäne* entsteht. Der frühere `toExternal`/`toInternal`-Schnitt geht
darin auf: `internal.pool` ist das alte `toInternal`, jede externe Domäne bringt ihr
eigenes ehemaliges `toExternal` mit.

Vergabe **immer paarweise**, auch wenn die Quelle kein ST 2022-7 macht:

```
Pool-Basis 239.200.0.0, Pärchen-Index i
  blue = base + 2i        (gerade)
  red  = base + 2i + 1    (ungerade)
```

- Pool-Start muss gerade sein; wird beim Speichern der Settings validiert.
- Freigabe gibt das Pärchen komplett zurück; Neuvergabe nimmt den **niedrigsten
  freien Index** ("nächste freie Adresse").
- Bei einbeiniger Quelle wird nur die Adresse der Fabric belegt, auf der die Quelle
  liegt; die andere bleibt reserviert und ungenutzt.
- Fabric-Zuordnung eines SDP-Legs: primär über die Subnetze der Quell-Domäne,
  hilfsweise über die Reihenfolge der `m=`-Zeilen (Leg 0 = red, Leg 1 = blue).
- Überlappende Pools zweier Domänen sind eine **Warnung**, kein Fehler: bei wirklich
  getrennten Netzen ist das zulässig, prüfen kann die Software es nicht.

### Source-NAT-Pool (optional, aber empfohlen)

Wird nur die Gruppe übersetzt, behält der Strom die Quell-IP aus dem Fremdnetz. Für
SSM (`a=source-filter`) und für RPF/Routing auf der Zielseite ist das meist unbrauchbar.
Deshalb je Domäne und Fabric ein **Unicast-Pool**, aus dem pro Channel eine übersetzte
Quelladresse vergeben wird — deterministisch am selben Index wie das Gruppen-Pärchen.

### NAT-Group-Nummern

EOS verlangt, dass Source- und Destination-Regel eines Übersetzungspaares dieselbe
`group`-Nummer tragen. Diese Nummern gelten **pro Switch, nicht pro Domäne** — alle
Domänen hängen an demselben Switch-Paar. Sie kommen deshalb aus einem globalen
Allokator, nicht aus dem Domänen-Pool. Der konfigurierte Bereich ist damit die harte
Obergrenze für die Zahl gleichzeitiger Channels über alle Domänen hinweg.

## 6. Switch-Steuerung (Arista EOS via eAPI)

Zwei Switches, `red` und `blue`, mit je Host und Zugangsdaten. Die L3-Interfaces
stehen **an den Domänen**, nicht am Switch: jede Domäne nennt ihr Interface je Fabric.
Für einen Channel ist damit

- **Ingress** = Interface der Quell-Domäne auf diesem Switch,
- **Egress** = Interface der Ziel-Domäne auf diesem Switch.

Das ist der Grund, warum die Richtung keine Sonderbehandlung mehr braucht.

Transport: JSON-RPC POST auf `https://<switch>/command-api`, Methode `runCmds`
(`version: 1`, `format: json`), Kommandoliste beginnt mit `enable`, `configure`.
Bricht ein Kommando ab, führt EOS die folgenden nicht mehr aus — die Fehlerantwort
enthält Index und Meldung, darauf baut das Rollback auf.

Pro Channel und Fabric werden drei Dinge programmiert:

1. **Ingress-Join** — der Switch muss den Originalstrom überhaupt ziehen:
   `ip igmp static-group <origGroup> [source <origSrc>]` auf dem Ingress-Interface.
   Alternativ per PIM, wenn der Switch ohnehin Last-Hop ist → Konfig-Schalter
   `join: igmpStatic | pim | none`.
2. **NAT** — Gruppenübersetzung, optional zusätzlich Quellübersetzung:
   ```
   ip nat destination static <origGroup> <fedGroup> group <N>
   ip nat source      static <origSrc>   <fedSrc>   group <N>
   ```
3. **Egress** — die übersetzte Gruppe muss Richtung Ziel-Domäne ausgegeben werden:
   `ip igmp static-group <fedGroup>` auf dem Egress-Interface, oder PIM/mroute,
   wenn die Gegenseite selbst joint.

Das Driver-Interface (`switch/driver.ts`) kennt nur `program(fabricPlan)` /
`unprogram(fabricPlan)` / `readState()`. Neben `arista-eapi` existiert ein
`mock`-Treiber, der Kommandos nur protokolliert — damit ist die komplette
Federation-Logik ohne Hardware testbar.

### ⚠ Plattform-Voraussetzung

**Multicast NAT ist bei Arista vermutlich kein Feature aller Plattformen.** Die
TOI-Reihe nennt durchgehend nur die Trident3-Familie — das EOS-Handbuch selbst enthält
allerdings *keine* Plattformliste für NAT, die Einordnung ist also Indizienlage:

| Feature | ab EOS | Plattformen |
|---|---|---|
| Static NAT | 4.21.6F | 7050X3, 720XP, 720D |
| **Multicast NAT** | **4.25.1F** | **7050X3, 720XP, 720D** |
| NAT VRF | 4.27.0F | 7050X3, 720XP, 720D |
| Static NAT | 4.35.0F | 7050X4, 7358X4 |
| NAT Flow | 4.28.1F | 7170 |

Die **7060er-Serie (Tomahawk/Tomahawk+) kommt in keinem NAT-TOI vor.**

### Messstand auf einer DCS-7060SX2-48YC6 (EOS 4.35.1F)

| Prüfung | Ergebnis |
|---|---|
| `ip nat destination static 239.10.1.5 239.200.0.1 group 100` auf Vlan101 | **wird akzeptiert**, keine Fehlermeldung |
| `show ip nat translation` direkt danach | **leer** — Header ohne Zeilen |
| in Hardware programmiert? | **offen** |
| Traffic-Test | **noch nicht gemacht** |

Die CLI-Annahme widerlegt "7060 kann gar kein NAT" als pauschale Aussage. Die leere
Translation-Tabelle nach einer statischen Regel ist umgekehrt das typische Bild für
"Konfiguration angenommen, Hardware nicht programmiert" — beweisend ist erst der
Traffic-Test. Siehe offener Punkt 1.

### Idempotenz und Reconciler

Die Software führt einen persistierten Soll-Zustand (`state.json` im Volume). Ein
Reconciler-Loop (Intervall + Trigger) vergleicht Soll gegen Ist:

- Switch-Ist über `show running-config section ip nat` bzw. `show ip nat translation`,
- Registry-Ist je Registry über die eigene Buchführung plus Heartbeat-Antworten.

Abweichungen werden korrigiert, nicht nur geloggt. Damit übersteht das System
Container-Neustart, Switch-Reload und Registry-Neustart ohne Handarbeit.

## 7. SDP-Transformation

Eingang: `transport_file` aus der IS-05-Aktivierung des vRX.

| SDP-Element | Behandlung |
|---|---|
| `o=` Origin-Adresse | auf übersetzte Quelle bzw. eigene Node-IP setzen, `sess-version` hochzählen |
| `c=IN IP4 <grp>/<ttl>` | Gruppe ersetzen, TTL aus Konfig (Default: übernehmen) |
| `a=source-filter:incl IN IP4 <grp> <src>` | Gruppe **und** Quelle ersetzen |
| `m=` Port/Payload | unverändert |
| `a=fmtp:` | unverändert (Essence-Beschreibung) |
| `a=group:DUP` / mehrere `m=` | jedes Leg bekommt sein Pool-Pendant |
| `a=ts-refclk:ptp=…` | Default Passthrough, optional Override auf `ptpRefclk` der Ziel-Domäne |
| `a=mediaclk:` | unverändert |

Bei **NAT disabled** entfällt die Transformation: das SDP wird 1:1 kopiert und der vTX
verweist auf die Originaladressen. Das ist der Fall für bereits geroutete Netze.

> Die PTP-Frage ist real: beide Häuser müssen auf dieselbe Zeit (TAI) gelockt sein,
> sonst ist der Strom auf der Zielseite zwar da, aber die Zeitstempel passen nicht zum
> lokalen GM. Der Override rettet nur die SDP-Plausibilitätsprüfung des Empfängers,
> nicht die Physik.

## 8. Channel-Lebenszyklus

```
        IS-05 activate (master_enable=true, transport_file)
idle ──────────────► allocating ──► programming ──► publishing ──► active
 ▲                       │              │               │            │
 │                       └──────────────┴───────────────┴──► failed  │
 │                                                                   │
 └── releasing ◄── unprogramming ◄── withdrawing ◄────────────────────┘
                IS-05 deactivate / vRX disabled / Quelle verschwunden
```

- **allocating** — Pärchen aus dem Pool der Ziel-Domäne, Source-NAT-Adressen,
  NAT-Group-Nummer aus dem globalen Allokator.
- **programming** — beide Fabrics; schlägt eine fehl, wird die andere zurückgerollt.
- **publishing** — `source`/`flow`/`sender` in allen Ziel-Registries des Devices.
  Schlägt eine von mehreren Registries fehl, bleibt der Channel aktiv und die
  fehlende Registrierung wird vom Reconciler nachgezogen.
- **active** — Heartbeats laufen, Reconciler wacht.
- **failed** — Grund wird im GUI und (später) über BCP-008-01 sichtbar gemacht;
  belegte Ressourcen werden freigegeben.

Abbau ist streng die Umkehrung: erst den vTX **abmelden** (damit kein Controller mehr
auf einen gleich toten Strom schaltet), dann NAT und Joins entfernen, dann Pool frei.

## 9. Konfiguration (Übersicht)

```jsonc
{
  "domains": [
    { "id": "internal", "label": "Eigenes Haus", "kind": "internal",
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

  // Mehrere Registries pro Domäne sind der Normalfall, wenn Partner sich ein Netz teilen.
  "registries": [
    { "id": "int",   "label": "Interne Registry", "domainId": "internal",
      "mode": "dnssd",  "version": "v1.3", "enabled": true },
    { "id": "regA1", "label": "Partner A primär",  "domainId": "partnerA",
      "mode": "manual", "url": "http://10.9.0.20:8235", "version": "v1.3", "enabled": true },
    { "id": "regA2", "label": "Partner A backup",  "domainId": "partnerA",
      "mode": "manual", "url": "http://10.9.0.21:8235", "version": "v1.3", "enabled": true }
  ],

  "nat": {
    "enabled": true,
    "driver": "arista-eapi",
    "switches": {
      "red":  { "host": "10.0.0.11", "user": "…", "password": "…", "tls": true, "join": "igmpStatic" },
      "blue": { "host": "10.0.0.12", "user": "…", "password": "…", "tls": true, "join": "igmpStatic" }
    },
    "groupIdRange": [100, 999]
  },

  "devices": [
    { "id": "…", "label": "Federation OUT ▸ Partner A",
      "sourceDomain": "internal", "targetDomain": "partnerA",
      "targetRegistries": ["regA1", "regA2"],   // leer = alle aktiven der Domäne
      "nat": true, "receiverIds": ["…"] }
  ]
}
```

## 10. Stack und Betrieb

- **Backend** Node 22+/TypeScript. HTTP: `fastify` (REST + `/x-nmos/*` + WS).
  Kein DB-Server; State als JSON im Volume, atomar geschrieben.
- **Frontend** Vue 3 + Vite + TypeScript, gebaut ins Image, vom Backend ausgeliefert.
- **Zwei Ports:** `port` (GUI/REST/WebSocket, an 0.0.0.0) und `nmosPort`
  (Node/Connection API). Von der NMOS-API läuft **je Domäne ein eigener Listener**,
  gebunden an die IP dieser Domäne — derselbe Port ist dadurch mehrfach nutzbar.
  Liegen zwei Domänen auf derselben IP (Laboraufbau), nimmt die zweite den nächsten
  freien Port, und `node.href` folgt dem.
- **Docker** `network_mode: host` ist Pflicht: die Software braucht je Domäne ein
  Interface mit echter IP (Node-href, Manifest-Abruf, mDNS). Alternative wäre
  macvlan mit mehreren Netzen.
- Konfiguration und State unter `/config` (Volume).

## 11. Roadmap

1. ✅ Kern: Pools je Domäne, NAT-Groups, SDP, Channel-Plan
2. ✅ NMOS-Node je Domäne: IS-04-Registrierung, Node API, IS-05 vRX/vTX
3. ⏳ Switch-Treiber: mock steht, arista-eapi geschrieben aber **nicht gegen Hardware
   verifiziert** — blockiert durch offenen Punkt 1
4. ✅ Persistenz + Recovery + Reconciler (in `engine.ts`, 30-s-Intervall)
5. ✅ WebGUI: Domänen/Registries/Switches, Devices, Channel-Dashboard mit Live-Status
6. BCP-008-01 (`NcReceiverMonitor` je vRX) — Muster liegt in Legacy2NMOS/Crosspoint
7. Transit-Fall extern→extern produktiv, Failover bei mehreren Registries
8. Optional: IS-09 System API, Authentifizierung (IS-10) für die externen Domänen

## 12. Offene Punkte

1. **NAT-Plattform.** Stand der Verifikation auf der DCS-7060SX2-48YC6 (EOS 4.35.1F):
   die Regel wird von der CLI **angenommen**, erscheint aber **nicht** in
   `show ip nat translation`. Nächste Schritte in dieser Reihenfolge:
   - `show running-config interfaces Vlan101` — persistiert die Regel überhaupt?
   - `show logging last 10 minutes | grep -i nat` — meldet der NAT-Agent etwas?
   - `show ip nat access-list interface` / `show ip nat pool` — kennt die Box die Regel?
   - **Traffic-Test** (entscheidend): Quelle auf 239.10.1.5 in Vlan101 senden,
     239.200.0.1 auf dem Egress-Interface joinen, Zähler prüfen.
   Wenn der Traffic-Test negativ ist, drei Wege:
   a) kleines 7050X3-/720XP-Paar als dedizierte Federation-NAT-Stufe zwischen die
      Fabrics hängen — die Hauptswitches bleiben unangetastet;
   b) Federation ohne NAT betreiben (`nat: false`), wenn sich die Adresspläne der
      beteiligten Häuser nicht überschneiden — das ist bereits ein unterstützter Modus;
   c) Linux-Gateway (nftables + smcroute) als Software-NAT, mit klarer
      Durchsatzgrenze. Blockiert Roadmap-Punkt 3.
2. **Exakte EOS-Syntax und Interface-Platzierung** (Ingress vs. Egress/Twice-NAT)
   gegen die tatsächlich verwendete Plattform verifizieren.
3. **PTP über Domänengrenzen** — Passthrough oder Override der `ts-refclk`?
   Betrieblich zu klären, technisch beides vorbereitet.
4. **Fremder Controller am vTX**: entschieden — read-only, PATCH auf `staged` eines
   virtuellen Senders antwortet 423. Bei Bedarf umkehrbar, dann braucht es eine
   Konfliktstrategie gegen unsere eigene Reconciliation.
5. **IS-05-Aktivierungsmodi**: nur `activate_immediate`; `activate_scheduled_*`
   antwortet 501. Für geplante Umschaltungen nachzurüsten.
6. **Kollisionen im Zielnetz** — der Federation-Pool einer Domäne muss dort exklusiv
   sein; die Software kann das nicht prüfen, nur dokumentieren und bei überlappenden
   Pools warnen.
7. **Bandbreiten-/Kapazitätsgrenze** — wieviele Channels pro Fabric? Begrenzt durch
   NAT-TCAM der Plattform und durch den NAT-Group-Bereich.
8. **Sicherheit der externen Domänen** — heute offene HTTP-APIs auf allen
   Interfaces. Mindestens Bind-Adressen je Domäne trennen, mittelfristig IS-10.
