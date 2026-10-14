<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  api,
  registryUrl,
  DEFAULT_REGISTRY_PORT,
  type Config,
  type DiscoveryResult,
  type HostInterface,
  type Issue,
  type RegistryStatus,
} from '../api';
import RegistryStatusTable from '../components/RegistryStatusTable.vue';
import InfoHint from '../components/InfoHint.vue';

const cfg = ref<Config | null>(null);
const issues = ref<Issue[]>([]);
const error = ref<string | null>(null);
const saved = ref(false);
const probe = ref<Record<string, string>>({});
const registryStatus = ref<RegistryStatus[]>([]);
const hostInterfaces = ref<HostInterface[]>([]);
const discovery = ref<DiscoveryResult | null>(null);
const discovering = ref(false);

/** Addresses this host actually holds — with network_mode: host, the real ones. */
const usable = () => hostInterfaces.value.filter((i) => !i.internal);

/**
 * IDs are opaque keys — devices and registries refer to them, so they must never change
 * once something points at one. New entries get the next free number; the field is not
 * shown at all, because the only thing an operator could do with it is break a reference.
 */
function nextId(existing: string[]): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

function slug(label: string, taken: Set<string>, fallback: string): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || fallback;
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}



async function loadRegistryStatus() {
  registryStatus.value = await api.registries().catch(() => []);
}

async function refresh() {
  try {
    cfg.value = await api.config();
    hostInterfaces.value = await api.interfaces().catch(() => []);
    await loadRegistryStatus();
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function save() {
  if (!cfg.value) return;
  saved.value = false;
  try {
    const res = await api.saveConfig(cfg.value);
    issues.value = res.issues;
    saved.value = true;
    error.value = null;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function check() {
  if (!cfg.value) return;
  issues.value = (await api.validateConfig(cfg.value)).issues;
}

function pickInterface(index: number, address: string) {
  const d = cfg.value?.domains[index];
  const iface = hostInterfaces.value.find((i) => i.address === address);
  if (!d || !iface) return;
  d.iface.address = iface.address;
  d.iface.name = iface.name;
}

function addDomain() {
  if (!cfg.value) return;
  // Default to an address this host actually has: typing it by hand is the step most
  // likely to be wrong, and an unreachable node href stays invisible until a controller
  // tries to fetch a transport file.
  const free = usable().find((i) => !cfg.value!.domains.some((d) => d.iface.address === i.address)) ?? usable()[0];
  cfg.value.domains.push({
    id: nextId(cfg.value.domains.map((d) => d.id)),
    label: 'Partner',
    kind: 'external',
    iface: { name: free?.name ?? 'eth1', address: free?.address ?? '' },
    firstLeg: 'red',
    switchInterface: { red: '', blue: '' },
    pool: { base: '239.200.0.0', pairs: 64, sourceNat: null },
    enabled: true,
  });
}

function addRegistry() {
  if (!cfg.value) return;
  cfg.value.registries.push({
    id: nextId(cfg.value.registries.map((r) => r.id)),
    label: 'Registry',
    domainId: cfg.value.domains[0]?.id ?? '',
    mode: 'manual',
    ip: '',
    port: DEFAULT_REGISTRY_PORT,
    tls: false,
    version: 'v1.3',
    enabled: true,
  });
}

function toggleSourceNat(index: number) {
  const d = cfg.value?.domains[index];
  if (!d) return;
  d.pool.sourceNat = d.pool.sourceNat ? null : { red: '', blue: '' };
}

async function probeSwitch(fabric: 'red' | 'blue') {
  try {
    const r = await api.probeSwitch(fabric);
    probe.value[fabric] = r.reachable ? `reachable — ${r.version ?? ''}` : `unreachable: ${r.error ?? ''}`;
  } catch (e) {
    probe.value[fabric] = (e as Error).message;
  }
}

const cleanupResult = ref<string | null>(null);
const resetPlan = ref<Record<string, number> | null>(null);
const busy = ref(false);

/** Removes what an earlier run left in the registries — see POST /api/cleanup. */
async function runCleanup() {
  busy.value = true;
  try {
    const res = await api.cleanup();
    const total = res.registries.reduce((n, r) => n + r.removed.length, 0);
    cleanupResult.value = total
      ? `Removed ${total}: ${res.registries.filter((r) => r.removed.length).map((r) => `${r.registry} (${r.removed.length})`).join(', ')}`
      : 'Nothing left over — the registries match the configuration.';
    error.value = null;
    await loadRegistryStatus();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** Two steps on purpose: the first only reports what a reset would remove. */
async function askReset() {
  busy.value = true;
  try {
    const res = await api.reset(false);
    resetPlan.value = res.wouldRemove ?? null;
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function doReset() {
  busy.value = true;
  try {
    const res = await api.reset(true);
    const removed = (res.removed ?? []).reduce((n, r) => n + r.removed.length, 0);
    cleanupResult.value = `Reset done — ${removed} registry resource(s) removed.`;
    resetPlan.value = null;
    issues.value = [];
    error.value = null;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function runDiscovery() {
  discovering.value = true;
  try {
    discovery.value = await api.discover();
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    discovering.value = false;
  }
}

function useDiscovered(url: string) {
  if (!cfg.value) return;
  try {
    const parsed = new URL(url);
    const tls = parsed.protocol === 'https:';
    cfg.value.registries.push({
      id: nextId(cfg.value.registries.map((r) => r.id)),
      label: parsed.hostname,
      domainId: cfg.value.domains[0]?.id ?? '',
      mode: 'manual',
      ip: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : tls ? 443 : 80,
      tls,
      version: 'v1.3',
      enabled: true,
    });
    saved.value = false;
  } catch {
    error.value = `cannot parse ${url}`;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="head">
    <h2>Settings</h2>
    <div>
      <button @click="check">Check</button>
      <button @click="save">Save</button>
    </div>
  </div>
  <p v-if="error" class="bad">{{ error }}</p>
  <p v-if="saved" class="ok">Saved.</p>
  <ul v-if="issues.length" class="issues">
    <li v-for="(i, n) in issues" :key="n" :class="i.level === 'error' ? 'bad' : 'warn'">{{ i.level }}: {{ i.message }}</li>
  </ul>

  <template v-if="cfg">
    <!-- ── Domains: identity and reachability only. Everything NAT-related lives in
         the NAT section at the bottom, where the plant is described. ── -->
    <section>
      <div class="head">
        <h3>
          Domains
          <InfoHint wide>
            A domain is one network with its own registry view. One for your own facility, one per partner.
            Everything about how a domain hangs on the switches — its L3 interfaces, its fabric order and its
            multicast pool — is configured further down under <strong>NAT</strong>, because that describes the
            plant rather than the domain's identity.
          </InfoHint>
        </h3>
        <button @click="addDomain">Add domain</button>
      </div>
      <table class="grid">
        <colgroup>
          <col style="width: 22%" /><col style="width: 15%" /><col style="width: 31%" />
          <col style="width: 16%" /><col style="width: 9%" /><col style="width: 7%" />
        </colgroup>
        <thead>
          <tr>
            <th>Name<InfoHint text="Free to change at any time. What a device refers to is a number assigned behind the scenes, so renaming never detaches anything." /></th>
            <th>
              Role
              <InfoHint>
                Marks which domain is your own house. It only drives the defaults when creating a device, and
                the check that there is exactly one of them — the engine never branches on it. Direction comes
                solely from a device's source and target domain.
              </InfoHint>
            </th>
            <th>
              Our IP in this network
              <InfoHint wide>
                Where this software publishes its own NMOS Node API for this domain. It becomes
                <code>node.href</code> and <code>api.endpoints[].host</code>, so a controller in that network
                fetches our resources and a virtual sender's <code>/transportfile</code> over it — it has to be
                an address this host actually holds there. The list offers the host's own interfaces; physical
                NICs come first, because an address on a container bridge is reachable from nowhere useful.
              </InfoHint>
            </th>
            <th>Interface<InfoHint text="OS interface name. Used for interface_bindings on our resources, and to look up the MAC that IS-04 requires in interfaces[].port_id." /></th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(d, i) in cfg.domains" :key="i" :title="`internal key: ${d.id}`">
            <td><input v-model="d.label" /></td>
            <td>
              <select v-model="d.kind">
                <option value="internal">our own facility</option>
                <option value="external">partner</option>
              </select>
            </td>
            <td>
              <select :value="d.iface.address" @change="pickInterface(i, ($event.target as HTMLSelectElement).value)">
                <option v-for="h in usable()" :key="h.address" :value="h.address">
                  {{ h.address }} — {{ h.name }}
                </option>
                <option v-if="d.iface.address && !usable().some((h) => h.address === d.iface.address)" :value="d.iface.address">
                  {{ d.iface.address }} (not on this host)
                </option>
              </select>
            </td>
            <td><input v-model="d.iface.name" /></td>
            <td><input type="checkbox" v-model="d.enabled" /></td>
            <td><button @click="cfg.domains.splice(i, 1)">×</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Registries ── -->
    <section>
      <div class="head">
        <h3>
          Registries
          <InfoHint wide>
            Each registry belongs to one domain, and several per domain is the normal case when partners share
            a network. Enter IP and port — the URL is assembled from them and shown in the last column, so a
            typo is visible before saving.
          </InfoHint>
        </h3>
        <button @click="addRegistry">Add registry</button>
      </div>
      <table class="grid">
        <colgroup>
          <col style="width: 14%" /><col style="width: 11%" /><col style="width: 11%" /><col style="width: 15%" />
          <col style="width: 7%" /><col style="width: 5%" /><col style="width: 10%" /><col style="width: 9%" />
          <col style="width: 14%" /><col style="width: 4%" />
        </colgroup>
        <thead>
          <tr>
            <th>Name</th>
            <th>Domain</th>
            <th>Mode<InfoHint text="manual: the address below. dnssd: found over DNS-SD, see the DNS-SD block underneath." /></th>
            <th>IP / hostname<InfoHint text="In dnssd mode this is the search domain instead — leave it empty to use the ones the host got from DHCP." /></th>
            <th>Port<InfoHint text="Registration API port. Defaults to 80; nmos-cpp configured with a single http_port typically listens on 8010." /></th>
            <th>TLS</th>
            <th>Version</th>
            <th>Enabled</th>
            <th>Address<InfoHint text="Assembled from IP, port and TLS. A port that matches the scheme's default is left out, because a strict registry rejects a URI that spells it out." /></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in cfg.registries" :key="i" :title="`internal key: ${r.id}`">
            <td><input v-model="r.label" /></td>
            <td><select v-model="r.domainId"><option v-for="d in cfg.domains" :key="d.id" :value="d.id">{{ d.label }}</option></select></td>
            <td><select v-model="r.mode"><option value="manual">manual</option><option value="dnssd">dnssd</option></select></td>
            <td>
              <input v-if="r.mode === 'manual'" v-model="r.ip" placeholder="192.168.11.100" />
              <span v-else class="muted">found by DNS-SD</span>
            </td>
            <td><input type="number" min="1" max="65535" v-model.number="r.port" :disabled="r.mode === 'dnssd'" :placeholder="String(DEFAULT_REGISTRY_PORT)" /></td>
            <td><input type="checkbox" v-model="r.tls" :disabled="r.mode === 'dnssd'" /></td>
            <td><select v-model="r.version"><option value="v1.3">v1.3</option><option value="v1.2">v1.2</option></select></td>
            <td><input type="checkbox" v-model="r.enabled" /></td>
            <td class="derived"><code>{{ registryUrl(r) ?? (r.mode === 'dnssd' ? 'via DNS-SD' : '—') }}</code></td>
            <td><button @click="cfg.registries.splice(i, 1)">×</button></td>
          </tr>
        </tbody>
      </table>

      <h4>
        Current status
        <InfoHint text="Reflects what is actually running, not what is in the form above — save first for a changed address to show up here." />
      </h4>
      <RegistryStatusTable :registries="registryStatus" show-test @probed="loadRegistryStatus" />

      <h4>
        DNS-SD
        <InfoHint wide>
          Both unicast DNS-SD and mDNS (<code>.local</code>) are queried, and both the current
          <code>_nmos-register._tcp</code> and the older <code>_nmos-registration._tcp</code> service name.
          The search domains come from the host — under <code>network_mode: host</code> those are the ones
          DHCP handed out, so there is nothing to configure. The result lists every name that was queried,
          so a miss is diagnosable.
        </InfoHint>
      </h4>
      <div class="row">
        <button :disabled="discovering" @click="runDiscovery">{{ discovering ? 'searching…' : 'Discover now' }}</button>
        <button :disabled="discovering" @click="api.refreshDiscovery().then(loadRegistryStatus)" title="drop cached addresses so the next contact resolves again">
          Re-resolve
        </button>
      </div>
      <template v-if="discovery">
        <p class="hint">
          Host search domains: <code>{{ discovery.searchDomains.join(', ') || 'none in resolv.conf' }}</code>
        </p>
        <table v-if="discovery.found.length">
          <thead><tr><th>Instance</th><th>Address</th><th>Versions</th><th>pri</th><th>Via</th><th></th></tr></thead>
          <tbody>
            <tr v-for="d in discovery.found" :key="d.instance + d.url">
              <td>{{ d.instance }}<small>{{ d.serviceType }} in {{ d.domain }}</small></td>
              <td>
                <code>{{ d.url }}</code>
                <small v-if="d.addressSource === 'instance-name'" class="warn">
                  announced {{ d.host }}, which does not resolve — address taken from the instance name
                </small>
                <small v-else-if="d.address && d.host !== d.address">announced {{ d.host }}</small>
              </td>
              <td>{{ d.versions.join(', ') || '—' }}</td>
              <td>{{ d.priority }}</td>
              <td>{{ d.via }}</td>
              <td><button @click="useDiscovered(d.url)">Add as registry</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="warn">Nothing found.</p>
        <details v-if="discovery.tried.length || discovery.notes.length">
          <summary>What was queried</summary>
          <ul class="queried">
            <li v-for="(t, n) in discovery.tried" :key="'t' + n"><code>{{ t }}</code></li>
            <li v-for="(n2, n) in discovery.notes" :key="'n' + n" class="warn">{{ n2 }}</li>
          </ul>
        </details>
      </template>
    </section>

    <!-- ── NAT: the plant. How each domain hangs on each switch, and the pools. ── -->
    <section class="nat">
      <h3>
        NAT
        <InfoHint wide>
          This section describes the plant: how each domain hangs on the switches, and which addresses may be
          handed out. The software only configures the switch — the essence never passes through it.
        </InfoHint>
      </h3>
      <div class="row">
        <label class="check">
          <input type="checkbox" v-model="cfg.nat.enabled" />
          <span>NAT enabled<InfoHint wide>
            With NAT off, every SDP is copied verbatim and no switch is touched. That is the right mode when
            the address plans of the houses involved do not collide and the networks are already routed.
          </InfoHint></span>
        </label>
        <label>
          <span>Driver<InfoHint text="mock logs the switch commands instead of sending them — the whole federation becomes visible in your controller without touching the network. Start here." /></span>
          <select v-model="cfg.nat.driver"><option value="arista-eapi">arista-eapi</option><option value="mock">mock</option></select>
        </label>
        <label>
          <span>NAT group from<InfoHint text="EOS requires the source and destination rule of one translation to share a group number. They are per switch, not per domain, so this range is the upper bound for simultaneous channels across all domains." /></span>
          <input type="number" v-model.number="cfg.nat.groupIdRange[0]" />
        </label>
        <label><span>to</span><input type="number" v-model.number="cfg.nat.groupIdRange[1]" /></label>
      </div>

      <h4>Switches</h4>
      <article v-for="fabric in (['red', 'blue'] as const)" :key="fabric" class="box">
        <div class="row">
          <strong :class="fabric">{{ fabric }}</strong>
          <label><span>Host</span><input v-model="cfg.nat.switches[fabric].host" /></label>
          <label><span>User</span><input v-model="cfg.nat.switches[fabric].user" /></label>
          <label><span>Password</span><input type="password" v-model="cfg.nat.switches[fabric].password" /></label>
          <label class="check"><input type="checkbox" v-model="cfg.nat.switches[fabric].tls" /><span>HTTPS</span></label>
          <label>
            <span>Join<InfoHint text="How the switch is made to pull the original stream and emit the translated one: a static IGMP join on the interfaces, PIM when the switch is last hop anyway, or nothing if the far side joins by itself." /></span>
            <select v-model="cfg.nat.switches[fabric].join">
              <option value="igmpStatic">igmpStatic</option><option value="pim">pim</option><option value="none">none</option>
            </select>
          </label>
          <button @click="probeSwitch(fabric)">Test</button>
          <small>{{ probe[fabric] ?? '' }}</small>
        </div>
      </article>

      <h4>
        How each domain hangs on the switches
        <InfoHint wide>
          For a channel, ingress is the <em>source</em> domain's interface and egress the <em>target</em>
          domain's — both on the same switch. That is why the interfaces belong to the domain rather than to
          the switch, and why direction needs no special case.
        </InfoHint>
      </h4>
      <table class="grid">
        <colgroup>
          <col style="width: 18%" /><col style="width: 14%" /><col style="width: 14%" />
          <col style="width: 16%" /><col style="width: 14%" /><col style="width: 9%" /><col style="width: 15%" />
        </colgroup>
        <thead>
          <tr>
            <th>Domain</th>
            <th>L3 on red<InfoHint text="This domain's interface on the red switch — SVI, routed port or port-channel." /></th>
            <th>L3 on blue<InfoHint text="The same on the blue switch." /></th>
            <th>
              First m= line
              <InfoHint wide>
                Which fabric the first media section of an incoming SDP belongs to; the other leg takes the
                other fabric. This is configuration, not something read out of the stream — the plant already
                states where each domain hangs, and guessing it from a source address would only add a way to
                silently NAT a stream onto the wrong fabric. For a redundant SDP the order comes from the
                <code>a=mid:</code> values named in <code>a=group:DUP</code>.
              </InfoHint>
            </th>
            <th>
              Pool base
              <InfoHint wide>
                The range handed out for senders created <em>in</em> this domain. Addresses go out in pairs —
                even is blue, odd is red — and a pair is reserved even for a single-leg source, so the base
                address must be even.
              </InfoHint>
            </th>
            <th>Pairs</th>
            <th>
              Source NAT
              <InfoHint wide>
                Also translates the source address, one per fabric at the same index as the group pair. Usually
                necessary: with only the group translated, the stream keeps a source IP from the foreign
                network, which SSM (<code>a=source-filter</code>) and RPF on the far side will not accept.
              </InfoHint>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(d, i) in cfg.domains" :key="i">
            <td><strong>{{ d.label }}</strong></td>
            <td><input v-model="d.switchInterface.red" placeholder="Vlan101" /></td>
            <td><input v-model="d.switchInterface.blue" placeholder="Vlan102" /></td>
            <td>
              <select v-model="d.firstLeg"><option value="red">red</option><option value="blue">blue</option></select>
            </td>
            <td><input v-model="d.pool.base" placeholder="239.200.0.0" /></td>
            <td><input type="number" min="1" v-model.number="d.pool.pairs" /></td>
            <td class="snat">
              <label class="check"><input type="checkbox" :checked="!!d.pool.sourceNat" @change="toggleSourceNat(i)" /> on</label>
              <template v-if="d.pool.sourceNat">
                <input v-model="d.pool.sourceNat.red" placeholder="red base" />
                <input v-model="d.pool.sourceNat.blue" placeholder="blue base" />
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Maintenance ── -->
    <section class="maint">
      <h3>
        Maintenance
        <InfoHint wide>
          <strong>Remove leftovers</strong> asks each registry for everything belonging to our nodes and
          deletes whatever the current configuration does not call for. That is the only way resources from an
          earlier run can be found: the record of what was registered is not kept across a restart, so they
          have to be identified by querying the registry.
        </InfoHint>
      </h3>
      <p v-if="cleanupResult" class="ok">{{ cleanupResult }}</p>
      <div class="row">
        <button :disabled="busy" @click="runCleanup">Remove leftovers from the registries</button>
        <button :disabled="busy" @click="askReset">Factory reset…</button>
      </div>
      <div v-if="resetPlan" class="confirm">
        <p class="warn">
          A factory reset tears down every channel, removes everything this installation put into the
          registries, and wipes the configuration and state back to defaults. It cannot be undone.
        </p>
        <p>
          It would remove:
          <code v-for="(n, k) in resetPlan" :key="k">{{ k }}: {{ n }}&nbsp;</code>
        </p>
        <div class="row">
          <button :disabled="busy" class="danger" @click="doReset">Yes, reset everything</button>
          <button :disabled="busy" @click="resetPlan = null">Cancel</button>
        </div>
      </div>
    </section>
  </template>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.head button { margin-left: 0.5rem; }
section { margin-bottom: 2.5rem; }
section.nat { border-top: 1px solid #8884; padding-top: 1.25rem; }
section.maint { border-top: 1px solid #8884; padding-top: 1.25rem; }
.confirm { border: 1px solid #d24b3e88; border-radius: 6px; padding: 0.9rem; margin-top: 0.75rem; }
.confirm code { margin-right: 0.5rem; }
button.danger { background: #d24b3e; color: #fff; border-color: #d24b3e; }
.box { border: 1px solid #8884; border-radius: 6px; padding: 0.9rem; margin-bottom: 0.75rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; margin-bottom: 0.5rem; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.35rem; }
label > span { display: inline-flex; align-items: center; white-space: nowrap; }
input, select { padding: 0.3rem 0.4rem; }
input[type='number'] { width: 6rem; }
/* Fixed layout, or every keystroke reflows the table: with the default auto layout a
   column is sized from its content, so typing a longer name silently moves every field
   in the row — and the name column of the NAT table below with it. */
table.grid { table-layout: fixed; }
table.grid th { white-space: nowrap; }
td input, td select { width: 100%; box-sizing: border-box; min-width: 0; }
td input[type='checkbox'] { width: auto; }
td { overflow-wrap: anywhere; }
td small { display: block; opacity: 0.55; }
.ro { opacity: 0.6; background: #8881; cursor: not-allowed; }
.muted { opacity: 0.55; font-size: 0.8rem; }
.snat { display: flex; gap: 0.3rem; align-items: center; }
.snat input { width: 7rem; }
.derived code { font-size: 0.8rem; opacity: 0.8; white-space: nowrap; }
.issues { padding-left: 1.2rem; }
.hint { font-size: 0.8rem; opacity: 0.75; max-width: 62rem; }
h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
h4 { margin: 1.5rem 0 0.25rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
details { font-size: 0.85rem; margin-top: 0.5rem; }
summary { cursor: pointer; opacity: 0.75; }
.queried { margin: 0.4rem 0 0; padding-left: 1.2rem; }
.queried li { opacity: 0.8; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; }
.red { color: #d24b3e; }
.blue { color: #3a78c9; }
</style>
