<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type BrowseReceiver, type BrowseSender, type Config, type Mirror } from '../api';

const cfg = ref<Config | null>(null);
const mirrors = ref<Mirror[]>([]);
const senders = ref<BrowseSender[]>([]);
const receivers = ref<BrowseReceiver[]>([]);
const sourceRegistry = ref('');
const deviceId = ref('');
const filter = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const device = computed(() => cfg.value?.devices.find((d) => d.id === deviceId.value) ?? null);
const registries = computed(() => (cfg.value?.registries ?? []).filter((r) => r.enabled));

/**
 * The direction is fixed by the device, and it differs per kind:
 *  - a sender copy reads from the device's source domain and publishes into its target
 *  - a receiver proxy drives a receiver in the target domain from the source domain
 * So a registry only yields copyable resources if it sits in the matching domain.
 */
const senderSource = computed(() => registries.value.find((r) => r.id === sourceRegistry.value)?.domainId === device.value?.sourceDomain);
const receiverSource = computed(() => registries.value.find((r) => r.id === sourceRegistry.value)?.domainId === device.value?.targetDomain);

const match = (label: string, dev: string) =>
  !filter.value || `${label} ${dev}`.toLowerCase().includes(filter.value.toLowerCase());
const visibleSenders = computed(() => senders.value.filter((s) => match(s.label, s.deviceLabel)));
const visibleReceivers = computed(() => receivers.value.filter((r) => match(r.label, r.deviceLabel)));

async function load() {
  try {
    [cfg.value, mirrors.value] = await Promise.all([api.config(), api.mirrors()]);
    if (!deviceId.value) deviceId.value = cfg.value.devices[0]?.id ?? '';
    if (!sourceRegistry.value) sourceRegistry.value = registries.value[0]?.id ?? '';
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function browse() {
  if (!sourceRegistry.value) return;
  busy.value = true;
  senders.value = [];
  receivers.value = [];
  try {
    const res = await api.browse(sourceRegistry.value);
    senders.value = res.senders;
    receivers.value = res.receivers;
    error.value = null;
    notice.value = `${res.senders.length} senders, ${res.receivers.length} receivers`;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const formatOf = (format: string): 'video' | 'audio' | 'data' =>
  format.endsWith(':audio') ? 'audio' : format.endsWith(':data') ? 'data' : 'video';

async function copy(kind: 'sender' | 'receiver', item: BrowseSender | BrowseReceiver) {
  if (!deviceId.value) {
    error.value = 'pick a target device first';
    return;
  }
  busy.value = true;
  try {
    await api.createMirror({
      kind,
      deviceId: deviceId.value,
      registryId: sourceRegistry.value,
      originId: item.id,
      originDeviceId: item.device_id,
      originLabel: item.label,
      ...(kind === 'receiver' ? { format: formatOf((item as BrowseReceiver).format) } : {}),
    });
    notice.value =
      kind === 'sender'
        ? `"${item.label}" copied — NAT programmed and published`
        : `"${item.label}" proxied — connect a stream to the proxy to drive it`;
    error.value = null;
    await Promise.all([load(), browse()]);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    error.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const stateClass = (m: Mirror) =>
  m.channel?.state === 'active' ? 'ok' : m.channel?.state === 'failed' ? 'bad' : 'busy';

function stateText(m: Mirror): string {
  if (!m.channel) return m.kind === 'receiver' ? 'idle — nothing connected to the proxy' : 'not built yet';
  const c = m.channel;
  if (c.state !== 'active') return c.error ? `${c.state}: ${c.error}` : c.state;
  const addr = c.allocation ? `${c.allocation.groups.red} / ${c.allocation.groups.blue}` : 'NAT off, SDP verbatim';
  if (c.remoteReceiver) {
    return c.remoteReceiver.connected ? `active · ${addr} · remote receiver connected` : `active · ${addr} · remote receiver NOT connected: ${c.remoteReceiver.error}`;
  }
  return `active · ${addr}`;
}

onMounted(load);
</script>

<template>
  <h2>Copy between registries</h2>
  <p class="lead">
    Copies an existing resource directly, without going through a virtual receiver.
    A <strong>sender</strong> copy reads the original's SDP from its manifest, NATs the stream into the
    target domain and publishes the copy there. A <strong>receiver</strong> copy creates a proxy in the
    source domain: connect a stream to it and the original receiver is driven over IS-05.
  </p>
  <p v-if="error" class="bad">{{ error }}</p>
  <p v-if="notice" class="notice">{{ notice }}</p>

  <section class="box">
    <div class="row">
      <label>Source registry
        <select v-model="sourceRegistry" @change="browse">
          <option v-for="r in registries" :key="r.id" :value="r.id">{{ r.label }} ({{ r.domainId }})</option>
        </select>
      </label>
      <label>Target device
        <select v-model="deviceId">
          <option v-for="d in cfg?.devices ?? []" :key="d.id" :value="d.id">
            {{ d.label }} — {{ d.sourceDomain }} → {{ d.targetDomain }}{{ d.nat ? '' : ' (no NAT)' }}
          </option>
        </select>
      </label>
      <label>Filter <input v-model="filter" placeholder="label or device" /></label>
      <button :disabled="busy || !sourceRegistry" @click="browse">{{ busy ? 'working…' : 'Browse' }}</button>
    </div>
    <p v-if="!cfg?.devices.length" class="warn">No devices yet — create one under Devices first; it supplies the direction and the NAT setting.</p>
  </section>

  <section v-if="senders.length || receivers.length">
    <h3>Senders <small v-if="device">copyable from {{ device.sourceDomain }}</small></h3>
    <p v-if="!senderSource" class="warn">
      This registry is not in the target device's source domain, so its senders cannot be copied with that device.
    </p>
    <table v-else>
      <thead><tr><th>Sender</th><th>Device</th><th>Essence</th><th></th></tr></thead>
      <tbody>
        <tr v-for="s in visibleSenders" :key="s.id">
          <td><strong>{{ s.label }}</strong><small>{{ s.id }}</small></td>
          <td>{{ s.deviceLabel }}<small v-if="s.ours">one of ours</small></td>
          <td>
            <template v-if="s.flow">{{ s.flow.media_type }}<small v-if="s.flow.frame_width">{{ s.flow.frame_width }}×{{ s.flow.frame_height }}</small></template>
            <small v-else>unknown</small>
          </td>
          <td>
            <span v-if="s.copied" class="ok">copied</span>
            <span v-else-if="s.ours" class="muted" title="copying our own copy would loop">—</span>
            <span v-else-if="!s.manifest_href" class="muted" title="no manifest_href, so there is no SDP to read">no manifest</span>
            <button v-else :disabled="busy" @click="copy('sender', s)">Copy</button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3>Receivers <small v-if="device">proxyable into {{ device.sourceDomain }}</small></h3>
    <p v-if="!receiverSource" class="warn">
      A receiver proxy drives a receiver in the device's target domain — pick a registry in {{ device?.targetDomain }}.
    </p>
    <table v-else>
      <thead><tr><th>Receiver</th><th>Device</th><th>Accepts</th><th>Currently</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in visibleReceivers" :key="r.id">
          <td><strong>{{ r.label }}</strong><small>{{ r.id }}</small></td>
          <td>{{ r.deviceLabel }}<small v-if="r.ours">one of ours</small></td>
          <td>{{ (r.caps?.media_types ?? []).join(', ') || '—' }}</td>
          <td><small>{{ r.subscription?.active ? `connected to ${r.subscription.sender_id}` : 'idle' }}</small></td>
          <td>
            <span v-if="r.copied" class="ok">copied</span>
            <span v-else-if="r.ours" class="muted">—</span>
            <span v-else-if="!r.controllable" class="muted" title="advertises no sr-ctrl control, so it cannot be driven over IS-05">not controllable</span>
            <button v-else :disabled="busy" @click="copy('receiver', r)">Proxy</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section>
    <h3>Existing copies</h3>
    <table v-if="mirrors.length">
      <thead><tr><th>Origin</th><th>Kind</th><th>Direction</th><th>State</th><th></th></tr></thead>
      <tbody>
        <tr v-for="m in mirrors" :key="m.id">
          <td><strong>{{ m.label || m.originLabel }}</strong><small>from {{ m.registryId }}</small></td>
          <td>{{ m.kind === 'sender' ? 'sender copy' : 'receiver proxy' }}</td>
          <td><small v-if="m.device">{{ m.device.sourceDomain }} → {{ m.device.targetDomain }}{{ m.device.nat ? '' : ' (no NAT)' }}</small></td>
          <td :class="stateClass(m)">{{ stateText(m) }}</td>
          <td class="actions">
            <button v-if="m.kind === 'sender'" :disabled="busy" @click="run(() => api.refreshMirror(m.id))" title="re-read the origin SDP and rebuild">Refresh</button>
            <button :disabled="busy" @click="run(() => api.deleteMirror(m.id))">Remove</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else><small>Nothing copied yet.</small></p>
  </section>
</template>

<style scoped>
.lead { max-width: 60rem; opacity: 0.8; font-size: 0.9rem; }
.box { border: 1px solid #8884; border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
input, select { padding: 0.3rem 0.4rem; }
section { margin-bottom: 2rem; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin-bottom: 0.3rem; }
h3 small { text-transform: none; letter-spacing: 0; margin-left: 0.5rem; opacity: 0.8; }
td small { display: block; opacity: 0.6; }
.actions { display: flex; gap: 0.4rem; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.busy { color: #c08a2e; }
.warn { color: #c08a2e; font-size: 0.85rem; }
.notice { color: #2e9e4f; }
.muted { opacity: 0.5; }
</style>
