<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Bridge, type Config, type Device, type VirtualReceiver } from '../api';
import { domainName, primeFromConfig, registryNames } from '../names';
import InfoHint from '../components/InfoHint.vue';
import EditableName from '../components/EditableName.vue';

const cfg = ref<Config | null>(null);
const bridges = ref<Bridge[]>([]);
const devices = ref<Device[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const draft = ref({ label: 'NMOS Federation', domains: ['', ''] as [string, string], registries: [] as string[], nat: true });
const deviceDraft = ref<Record<string, string>>({});
const rxDraft = ref<Record<string, { count: number; pattern: string; format: VirtualReceiver['format']; side: string }>>({});

const domains = computed(() => cfg.value?.domains ?? []);
const registriesOf = (domainId: string) => (cfg.value?.registries ?? []).filter((r) => r.domainId === domainId);
const bridgeOf = (d: Device) => bridges.value.find((b) => b.id === d.bridgeId);
const other = (b: Bridge | undefined, domainId: string) => (b ? (b.domains[0] === domainId ? b.domains[1] : b.domains[0]) : '');
/** Direction of a port: offered in its side, flowing to the other domain. */
function direction(d: Device, vrx: VirtualReceiver): string {
  const b = bridgeOf(d);
  const side = vrx.side && b?.domains.includes(vrx.side) ? vrx.side : (b?.domains[0] ?? '');
  return `${domainName(side)} → ${domainName(other(b, side))}`;
}
/** Where the node appears in one domain: the bridge's listed registries there, or all. */
function sharedIn(b: Bridge, domainId: string): string {
  const listed = b.registries.filter((id) => registriesOf(domainId).some((r) => r.id === id));
  return listed.length ? registryNames(listed) : 'all registries';
}
const devicesOf = (bridgeId: string) => devices.value.filter((d) => d.bridgeId === bridgeId);

async function refresh() {
  try {
    [cfg.value, bridges.value, devices.value] = await Promise.all([api.config(), api.bridges(), api.devices()]);
    primeFromConfig(cfg.value);
    if (!draft.value.domains[0]) {
      draft.value.domains = [
        domains.value.find((d) => d.kind === 'internal')?.id ?? '',
        domains.value.find((d) => d.kind === 'external')?.id ?? '',
      ];
    }
    for (const b of bridges.value) deviceDraft.value[b.id] ??= 'Device';
    for (const d of devices.value) {
      rxDraft.value[d.id] ??= { count: 1, pattern: `${d.label} {n}`, format: 'video', side: bridgeOf(d)?.domains[0] ?? '' };
    }
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/**
 * A rename saves in the background. Going through `run` disabled every field while
 * it saved, which threw the cursor out of the next name the moment Tab had put it
 * there. The server queues the writes, so they can go out back to back.
 */
async function rename(fn: () => Promise<unknown>) {
  try {
    await fn();
    error.value = null;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    error.value = null;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/**
 * Direction, target registries and NAT shape every channel on a bridge, so changing one
 * rebuilds them. The backend does that; here we only report what happened.
 */
async function patchBridge(bridge: Bridge, change: Partial<Bridge>) {
  notice.value = null;
  busy.value = true;
  try {
    const res = await api.updateBridge(bridge.id, change);
    if (res.rebuilt) {
      const failed = res.failed?.length ?? 0;
      notice.value = failed
        ? `${res.rebuilt} channel(s) rebuilt, ${failed} failed: ${res.failed!.map((f) => f.error).join('; ')}`
        : `${res.rebuilt} channel(s) rebuilt.`;
    }
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="head">
    <h2>
      Bridges
      <InfoHint wide>
        A bridge joins two domains and <strong>is</strong> an NMOS node: every registry in either domain
        shows it under this name. It carries streams both ways — each virtual receiver is offered in one
        of the two domains and its stream flows to the other. Registries and NAT belong to the bridge; a
        device is simply a group of ports on it, in either direction.
      </InfoHint>
    </h2>
  </div>
  <p v-if="error" class="bad">{{ error }}</p>
  <p v-if="notice" class="notice">{{ notice }}</p>

  <section class="new">
    <h3>New bridge</h3>
    <div class="row">
      <label><span>Name <InfoHint text="The NMOS node's label, as every registry will show it. &quot;NMOS Federation&quot; is only the suggestion — name it after what it connects. Rename it any time by clicking the name." /></span><input v-model="draft.label" placeholder="NMOS Federation" /></label>
      <label><span>Domain</span>
        <select v-model="draft.domains[0]">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </label>
      <span class="both" title="a bridge carries streams both ways — each port decides its own direction">⇄</span>
      <label><span>Domain</span>
        <select v-model="draft.domains[1]">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" v-model="draft.nat" />
        <span>NAT<InfoHint text="Off copies every SDP verbatim and touches no switch — right when the address plans do not collide." /></span>
      </label>
      <button :disabled="busy" @click="run(() => api.createBridge(draft))">Create bridge</button>
    </div>
    <fieldset v-for="dom in draft.domains.filter((x, i) => x && draft.domains.indexOf(x) === i)" :key="dom" v-show="registriesOf(dom).length">
      <legend>Registries in {{ domainName(dom) }} (none ticked = all enabled ones)</legend>
      <label v-for="r in registriesOf(dom)" :key="r.id" class="check">
        <input type="checkbox" :value="r.id" v-model="draft.registries" /> {{ r.label }}
      </label>
    </fieldset>
    <p v-if="domains.length < 2" class="warn">
      A bridge needs two domains — add a second one under Settings first.
    </p>
  </section>

  <article v-for="b in bridges" :key="b.id" :class="['bridge', { detached: b.detached }]">
    <header>
      <div>
        <strong><EditableName :value="b.label" fallback="NMOS Federation" @save="(label) => rename(() => api.updateBridge(b.id, { label }))" /></strong>
        <span v-if="b.detached" class="badge">detached</span>
        <small>
          node · {{ domainName(b.domains[0]) }} ⇄ {{ domainName(b.domains[1]) }} ·
          in {{ domainName(b.domains[0]) }}: {{ sharedIn(b, b.domains[0]) }} · in {{ domainName(b.domains[1]) }}: {{ sharedIn(b, b.domains[1]) }}
        </small>
        <small v-if="b.detached" class="bad">
          Points at
          {{ (b.missing?.domains ?? []).map(domainName).join(' and ') }},
          which does not exist — this bridge registers nothing.
        </small>
      </div>
      <div class="controls">
        <label class="check" title="Rebuilds this bridge's channels">
          <input type="checkbox" :checked="b.nat" @change="patchBridge(b, { nat: ($event.target as HTMLInputElement).checked })" />
          NAT
        </label>
        <button :disabled="busy" @click="run(() => api.deleteBridge(b.id))">Delete bridge</button>
      </div>
    </header>

    <article v-for="d in devicesOf(b.id)" :key="d.id" class="device">
      <header>
        <strong><EditableName :value="d.label" @save="(label) => rename(() => api.updateDevice(d.id, { label }))" /></strong>
        <button :disabled="busy" @click="run(() => api.deleteDevice(d.id))">Remove device</button>
      </header>
      <table v-if="d.receivers?.length">
        <thead><tr><th>Virtual receiver</th><th>Direction</th><th>Format</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          <tr v-for="vrx in d.receivers" :key="vrx.id">
            <td><EditableName :value="vrx.label" @save="(label) => rename(() => api.renameReceiver(vrx.id, label))" /></td>
            <td><small class="dir">{{ direction(d, vrx) }}</small></td>
            <td>{{ vrx.format }}</td>
            <td>{{ vrx.enabled ? 'yes' : 'no' }}</td>
            <td><button :disabled="busy" @click="run(() => api.deleteReceiver(vrx.id))">Remove</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else><small>No ports yet — add virtual receivers here, or copy existing ones on the Copy page.</small></p>

      <div class="row" v-if="rxDraft[d.id]">
        <label><span>Count</span><input type="number" min="1" max="256" v-model.number="rxDraft[d.id]!.count" /></label>
        <label><span>Name pattern</span><input v-model="rxDraft[d.id]!.pattern" /></label>
        <label><span>Direction <InfoHint text="The receivers appear in the domain on the left. A stream connected to one flows to the domain on the right, where its sender is published. Copies on the Copy page need no choice: they run away from the registry they come from." /></span>
          <select v-model="rxDraft[d.id]!.side">
            <option v-for="dom in bridgeOf(d)?.domains ?? []" :key="dom" :value="dom">{{ domainName(dom) }} → {{ domainName(other(bridgeOf(d), dom)) }}</option>
          </select>
        </label>
        <label><span>Format</span>
          <select v-model="rxDraft[d.id]!.format">
            <option value="video">video</option><option value="audio">audio</option><option value="data">data</option>
          </select>
        </label>
        <button :disabled="busy" @click="run(() => api.addReceivers(d.id, rxDraft[d.id]!))">Add virtual receivers</button>
      </div>
    </article>

    <div class="row add-device">
      <label><span>New device</span><input v-model="deviceDraft[b.id]" placeholder="Cameras" /></label>
      <button :disabled="busy" @click="run(() => api.createDevice({ bridgeId: b.id, label: deviceDraft[b.id] }))">Add device</button>
    </div>
  </article>

  <p v-if="!bridges.length"><small>No bridges yet.</small></p>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
h2 { display: flex; align-items: center; }
.new, .bridge { border: 1px solid #8884; border-radius: 6px; padding: 1rem; margin-bottom: 1.25rem; }
.bridge.detached { border-color: #d24b3e88; }
.bridge > header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 0.75rem; }
.device { border: 1px solid #8883; border-radius: 6px; padding: 0.75rem; margin: 0.75rem 0 0 1rem; }
.device > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.add-device { margin-top: 0.9rem; margin-left: 1rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.35rem; }
label > span { display: inline-flex; align-items: center; white-space: nowrap; }
input, select { padding: 0.3rem 0.4rem; }
input[type='number'] { width: 5rem; }
fieldset { margin-top: 0.75rem; border: 1px solid #8883; border-radius: 4px; display: flex; gap: 1rem; flex-wrap: wrap; }
legend { font-size: 0.8rem; opacity: 0.7; }
small { display: block; opacity: 0.65; }
.controls { display: flex; align-items: center; gap: 0.75rem; }
.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; background: #d24b3e; color: #fff; border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; font-size: 0.85rem; }
.notice { color: #2e9e4f; }
.both { align-self: center; font-size: 1.2rem; opacity: 0.6; padding-bottom: 0.2rem; }
.dir { opacity: 0.75; white-space: nowrap; }
</style>
