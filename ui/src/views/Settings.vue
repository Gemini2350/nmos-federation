<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, registryUrl, DEFAULT_REGISTRY_PORT, type Config, type Issue, type RegistryStatus } from '../api';
import RegistryStatusTable from '../components/RegistryStatusTable.vue';

const cfg = ref<Config | null>(null);
const issues = ref<Issue[]>([]);
const error = ref<string | null>(null);
const saved = ref(false);
const probe = ref<Record<string, string>>({});
const registryStatus = ref<RegistryStatus[]>([]);

async function loadRegistryStatus() {
  registryStatus.value = await api.registries().catch(() => []);
}

async function refresh() {
  try {
    cfg.value = await api.config();
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
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function check() {
  if (!cfg.value) return;
  issues.value = (await api.validateConfig(cfg.value)).issues;
}

function addDomain() {
  cfg.value?.domains.push({
    id: `partner${cfg.value.domains.length}`,
    label: 'Partner',
    kind: 'external',
    iface: { name: 'eth1', address: '' },
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
          <label>ID <input v-model="d.id" /></label>
          <label>Name <input v-model="d.label" /></label>
          <label>Kind
            <select v-model="d.kind"><option value="internal">internal</option><option value="external">external</option></select>
          </label>
          <label>Interface <input v-model="d.iface.name" /></label>
          <label>Node API address <input v-model="d.iface.address" /></label>
          <label class="check"><input type="checkbox" v-model="d.enabled" /> enabled</label>
        </div>
        <div class="row">
          <label>Subnet red <input v-model="d.fabricSubnets.red" placeholder="10.1.1.0/24" /></label>
          <label>Subnet blue <input v-model="d.fabricSubnets.blue" placeholder="10.1.2.0/24" /></label>
          <label>L3 interface red <input v-model="d.switchInterface.red" placeholder="Vlan101" /></label>
          <label>L3 interface blue <input v-model="d.switchInterface.blue" placeholder="Vlan102" /></label>
        </div>
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
            <td><input v-model="r.id" /></td>
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
input[type='number'] { width: 6rem; }
td input, td select { width: 100%; box-sizing: border-box; }
td input[type='number'] { width: 5.5rem; }
td input[type='checkbox'] { width: auto; }
.derived code { font-size: 0.8rem; opacity: 0.8; white-space: nowrap; }
.del { margin-top: 0.5rem; }
.issues { padding-left: 1.2rem; }
.hint { font-size: 0.8rem; opacity: 0.7; }
h4 { margin: 1.25rem 0 0.25rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; }
.red { color: #d24b3e; }
.blue { color: #3a78c9; }
</style>
