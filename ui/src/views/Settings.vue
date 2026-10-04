<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, registryUrl, DEFAULT_REGISTRY_PORT, type Config, type DiscoveryResult, type HostInterface, type Issue, type RegistryStatus } from '../api';
import RegistryStatusTable from '../components/RegistryStatusTable.vue';

const cfg = ref<Config | null>(null);
const issues = ref<Issue[]>([]);
const error = ref<string | null>(null);
const saved = ref(false);
const probe = ref<Record<string, string>>({});
const registryStatus = ref<RegistryStatus[]>([]);
const discovery = ref<DiscoveryResult | null>(null);
const discovering = ref(false);
const discoveryDomain = ref('');

/**
 * Discovery is worth showing in full: which search domain was used, which names were
 * queried and what came back. "DNS-SD found nothing" on its own is not actionable.
 */
async function runDiscovery() {
  discovering.value = true;
  try {
    discovery.value = await api.discover(discoveryDomain.value ? { domain: discoveryDomain.value } : {});
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
      id: `reg${cfg.value.registries.length}`,
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

async function loadRegistryStatus() {
  registryStatus.value = await api.registries().catch(() => []);
}

/**
 * IDs that already exist on disk. They are keys: devices, registries and copies refer
 * to them, so changing one detaches everything pointing at it. Editing them by hand is
 * what locked an operator out of deleting a device, so they are read-only once saved —
 * and derived from the name while an entry is still new.
 */
const hostInterfaces = ref<HostInterface[]>([]);

/** The addresses this host actually holds — with network_mode: host, the real ones. */
const usable = () => hostInterfaces.value.filter((i) => !i.internal);

function pickInterface(domainIndex: number, address: string) {
  const d = cfg.value?.domains[domainIndex];
  const iface = hostInterfaces.value.find((i) => i.address === address);
  if (!d || !iface) return;
  d.iface.address = iface.address;
  d.iface.name = iface.name;
  // The fabric subnets default to the network this address sits in — the common case
  // for a single-fabric setup, and a sane starting point for red/blue.
  if (iface.cidr && !d.fabricSubnets.red && !d.fabricSubnets.blue) {
    const network = iface.cidr.replace(/\/(\d+)$/, (_m, bits) => `/${bits}`);
    d.fabricSubnets.red = network.replace(/^(\d+\.\d+\.\d+)\.\d+/, '$1.0');
  }
}

const savedDomainIds = ref<Set<string>>(new Set());
const savedRegistryIds = ref<Set<string>>(new Set());

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

const isNewDomain = (id: string) => !savedDomainIds.value.has(id);
const isNewRegistry = (id: string) => !savedRegistryIds.value.has(id);

// While an entry is unsaved, keep its ID in step with the name the operator is typing.
watch(
  () => cfg.value?.domains.map((d) => `${d.id}\u0000${d.label}`).join('|'),
  () => {
    if (!cfg.value) return;
    const taken = new Set(cfg.value.domains.map((d) => d.id));
    for (const d of cfg.value.domains) {
      if (!isNewDomain(d.id)) continue;
      taken.delete(d.id);
      const next = slug(d.label, taken, 'domain');
      taken.add(next);
      if (next !== d.id) {
        for (const r of cfg.value.registries) if (r.domainId === d.id) r.domainId = next;
        for (const dev of cfg.value.devices) {
          if (dev.sourceDomain === d.id) dev.sourceDomain = next;
          if (dev.targetDomain === d.id) dev.targetDomain = next;
        }
        d.id = next;
      }
    }
  },
);

watch(
  () => cfg.value?.registries.map((r) => `${r.id}\u0000${r.label}`).join('|'),
  () => {
    if (!cfg.value) return;
    const taken = new Set(cfg.value.registries.map((r) => r.id));
    for (const r of cfg.value.registries) {
      if (!isNewRegistry(r.id)) continue;
      taken.delete(r.id);
      const next = slug(r.label, taken, 'registry');
      taken.add(next);
      if (next !== r.id) {
        for (const dev of cfg.value.devices) {
          dev.targetRegistries = dev.targetRegistries.map((x) => (x === r.id ? next : x));
        }
        r.id = next;
      }
    }
  },
);

async function refresh() {
  try {
    cfg.value = await api.config();
    savedDomainIds.value = new Set(cfg.value.domains.map((d) => d.id));
    savedRegistryIds.value = new Set(cfg.value.registries.map((r) => r.id));
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

function addDomain() {
  // Default to an address this host actually has: typing it by hand is the step most
  // likely to be wrong, and an unreachable node href is invisible until a controller
  // tries to fetch a transport file.
  const free = usable().find((i) => !cfg.value?.domains.some((d) => d.iface.address === i.address)) ?? usable()[0];
  cfg.value?.domains.push({
    id: `partner${cfg.value.domains.length}`,
    label: 'Partner',
    kind: 'external',
    iface: { name: free?.name ?? 'eth1', address: free?.address ?? '' },
    fabricSubnets: { red: null, blue: null },
    switchInterface: { red: '', blue: '' },
    pool: { base: '239.200.0.0', pairs: 64, sourceNat: null },
    ptpRefclk: null,
    enabled: true,
  });
}

function addRegistry() {
  cfg.value?.registries.push({
    id: `reg${cfg.value.registries.length}`,
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
    <section>
      <div class="head"><h3>Domains</h3><button @click="addDomain">Add domain</button></div>
      <article v-for="(d, i) in cfg.domains" :key="i" class="box">
        <div class="row">
          <label>Name <input v-model="d.label" /></label>
          <label :title="isNewDomain(d.id) ? 'derived from the name until saved' : 'internal key — rename the name instead'">
            ID
            <input :value="d.id" readonly class="ro" />
          </label>
          <label>Kind
            <select v-model="d.kind"><option value="internal">internal</option><option value="external">external</option></select>
          </label>
          <label title="OS interface name, used for interface_bindings">Interface <input v-model="d.iface.name" /></label>
          <label title="This host's IP in THIS network. It is published as node.href and api.endpoints[].host, so a controller in this domain fetches our resources and the sender's /transportfile over it.">
            Our IP in this network
            <select :value="d.iface.address" @change="pickInterface(i, ($event.target as HTMLSelectElement).value)">
              <option v-for="h in usable()" :key="h.address" :value="h.address">
                {{ h.name }} — {{ h.address }}{{ h.cidr ? ` (${h.cidr})` : '' }}
              </option>
              <option v-if="d.iface.address && !usable().some((h) => h.address === d.iface.address)" :value="d.iface.address">
                {{ d.iface.address }} (not on this host)
              </option>
            </select>
          </label>
          <label class="check"><input type="checkbox" v-model="d.enabled" /> enabled</label>
        </div>
        <p class="hint">
          <strong>Our IP in this network</strong> is where this software publishes its own NMOS Node API for
          this domain — a controller in this network reaches our resources and the virtual sender's
          <code>/transportfile</code> through it. It has to be an address this host actually holds in that
          network. The ID is an internal key that devices and registries refer to; it follows the name while
          the entry is new and is fixed once saved.
        </p>
        <div class="row">
          <label title="Source subnet of the red fabric in this domain. A stream's leg is assigned to a fabric by matching its source IP against these.">
            Subnet red <input v-model="d.fabricSubnets.red" placeholder="10.1.1.0/24" />
          </label>
          <label title="Source subnet of the blue fabric in this domain.">
            Subnet blue <input v-model="d.fabricSubnets.blue" placeholder="10.1.2.0/24" />
          </label>
          <label title="This domain's L3 interface on the RED switch — SVI, routed port or port-channel.">
            L3 interface red <input v-model="d.switchInterface.red" placeholder="Vlan101" />
          </label>
          <label title="This domain's L3 interface on the BLUE switch.">
            L3 interface blue <input v-model="d.switchInterface.blue" placeholder="Vlan102" />
          </label>
        </div>
        <p class="hint">
          <strong>Subnet red/blue</strong> tell the software which fabric a stream's leg belongs to: the
          leg's source IP is matched against them, and if neither matches, the order of the
          <code>m=</code> lines decides. <strong>L3 interface red/blue</strong> is this domain's interface
          on each switch. For a channel, ingress is the source domain's interface and egress the target
          domain's — which is why they live on the domain rather than on the switch. Both are only needed
          with NAT enabled.
        </p>
        <div class="row">
          <label>Pool base (must be even) <input v-model="d.pool.base" /></label>
          <label>Pairs <input type="number" min="1" v-model.number="d.pool.pairs" /></label>
          <label class="check"><input type="checkbox" :checked="!!d.pool.sourceNat" @change="toggleSourceNat(i)" /> source NAT</label>
          <template v-if="d.pool.sourceNat">
            <label>Source red <input v-model="d.pool.sourceNat.red" /></label>
            <label>Source blue <input v-model="d.pool.sourceNat.blue" /></label>
          </template>
          <label>ts-refclk override <input v-model="d.ptpRefclk" placeholder="empty = pass through" /></label>
        </div>
        <button class="del" @click="cfg.domains.splice(i, 1)">Remove domain</button>
      </article>
    </section>

    <section>
      <div class="head"><h3>Registries</h3><button @click="addRegistry">Add registry</button></div>
      <p class="hint">
        Several registries per domain is the normal case when partners share a network.
        Enter IP and port — the URL is assembled from them.
      </p>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Domain</th><th>Mode</th><th>IP / hostname</th><th>Port</th>
            <th>TLS</th><th>Version</th><th>Enabled</th><th>Address</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in cfg.registries" :key="i">
            <td><input :value="r.id" readonly class="ro" :title="isNewRegistry(r.id) ? 'derived from the name until saved' : 'internal key — rename the name instead'" /></td>
            <td><input v-model="r.label" /></td>
            <td><select v-model="r.domainId"><option v-for="d in cfg.domains" :key="d.id" :value="d.id">{{ d.id }}</option></select></td>
            <td><select v-model="r.mode"><option value="manual">manual</option><option value="dnssd">dnssd</option></select></td>
            <td>
              <input v-if="r.mode === 'manual'" v-model="r.ip" placeholder="192.168.11.100" />
              <input v-else v-model="r.domain" placeholder="search domain, empty = local" />
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
      <h4>Current status</h4>
      <p class="hint">Reflects what is running — save first for a changed address to show up here.</p>
      <RegistryStatusTable :registries="registryStatus" show-test @probed="loadRegistryStatus" />

      <h4>DNS-SD</h4>
      <div class="row">
        <label>Search domain
          <input v-model="discoveryDomain" :placeholder="discovery?.searchDomains.join(', ') || 'from the host (DHCP)'" />
        </label>
        <button :disabled="discovering" @click="runDiscovery">{{ discovering ? 'searching…' : 'Discover now' }}</button>
        <button :disabled="discovering" @click="api.refreshDiscovery().then(loadRegistryStatus)" title="drop cached addresses so the next contact resolves again">
          Re-resolve
        </button>
      </div>
      <p class="hint">
        Leave the domain empty to use the host's search domains — under
        <code>network_mode: host</code> those are the ones DHCP handed out. Both unicast
        DNS-SD and mDNS (<code>.local</code>) are queried.
      </p>

      <template v-if="discovery">
        <p class="hint">
          Host search domains: <code>{{ discovery.searchDomains.join(', ') || 'none in resolv.conf' }}</code>
          <template v-if="discovery.usedDomain"> · used: <code>{{ discovery.usedDomain }}</code></template>
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
                <small v-else-if="d.host !== d.address && d.address">announced {{ d.host }}</small>
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

    <section>
      <h3>NAT and switches</h3>
      <div class="row">
        <label class="check"><input type="checkbox" v-model="cfg.nat.enabled" /> NAT enabled</label>
        <label>Driver
          <select v-model="cfg.nat.driver"><option value="arista-eapi">arista-eapi</option><option value="mock">mock</option></select>
        </label>
        <label>NAT group from <input type="number" v-model.number="cfg.nat.groupIdRange[0]" /></label>
        <label>to <input type="number" v-model.number="cfg.nat.groupIdRange[1]" /></label>
      </div>
      <p class="hint">NAT group numbers are per switch — the range is the upper bound for simultaneous channels across all domains.</p>
      <article v-for="fabric in (['red', 'blue'] as const)" :key="fabric" class="box">
        <div class="row">
          <strong :class="fabric">{{ fabric }}</strong>
          <label>Host <input v-model="cfg.nat.switches[fabric].host" /></label>
          <label>User <input v-model="cfg.nat.switches[fabric].user" /></label>
          <label>Password <input type="password" v-model="cfg.nat.switches[fabric].password" /></label>
          <label class="check"><input type="checkbox" v-model="cfg.nat.switches[fabric].tls" /> HTTPS</label>
          <label>Join
            <select v-model="cfg.nat.switches[fabric].join">
              <option value="igmpStatic">igmpStatic</option><option value="pim">pim</option><option value="none">none</option>
            </select>
          </label>
          <button @click="probeSwitch(fabric)">Test</button>
          <small>{{ probe[fabric] ?? '' }}</small>
        </div>
      </article>
      <p class="hint">The L3 interfaces live on the domains: ingress is the source domain's interface, egress the target domain's.</p>
    </section>
  </template>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.head button { margin-left: 0.5rem; }
section { margin-bottom: 2rem; }
.box { border: 1px solid #8884; border-radius: 6px; padding: 0.9rem; margin-bottom: 0.75rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; margin-bottom: 0.5rem; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.35rem; }
input, select { padding: 0.3rem 0.4rem; }
.ro { opacity: 0.6; background: #8881; cursor: not-allowed; }
input[type='number'] { width: 6rem; }
td input, td select { width: 100%; box-sizing: border-box; }
td input[type='number'] { width: 5.5rem; }
td input[type='checkbox'] { width: auto; }
.derived code { font-size: 0.8rem; opacity: 0.8; white-space: nowrap; }
.del { margin-top: 0.5rem; }
.issues { padding-left: 1.2rem; }
.hint { font-size: 0.8rem; opacity: 0.7; }
details { font-size: 0.85rem; margin-top: 0.5rem; }
summary { cursor: pointer; opacity: 0.75; }
.queried { margin: 0.4rem 0 0; padding-left: 1.2rem; }
.queried li { opacity: 0.8; }
h4 { margin: 1.25rem 0 0.25rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; }
.red { color: #d24b3e; }
.blue { color: #3a78c9; }
</style>
