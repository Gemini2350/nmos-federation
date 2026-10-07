<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type BrowseReceiver, type BrowseSender, type Config, type Mirror } from '../api';
import { domainName, primeFromConfig, registryName } from '../names';
import EditableName from '../components/EditableName.vue';
import BrowseList from '../components/BrowseList.vue';

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
const paging = ref<{ limit: number | null; pages: number; truncated: boolean } | null>(null);

const device = computed(() => cfg.value?.devices.find((d) => d.id === deviceId.value) ?? null);
/** Registries and NAT live on the bridge the device hangs on. */
const bridge = computed(() => cfg.value?.bridges.find((b) => b.id === device.value?.bridgeId) ?? null);
const registries = computed(() => (cfg.value?.registries ?? []).filter((r) => r.enabled));

/**
 * A bridge has no direction, so a copy runs away from the registry it comes from: a
 * sender copy is published in the bridge's other domain, a receiver proxy is offered
 * there. The registry only has to sit in one of the bridge's two domains.
 */
const originDomain = computed(() => registries.value.find((r) => r.id === sourceRegistry.value)?.domainId ?? '');
const inBridge = computed(() => !!bridge.value && bridge.value.domains.includes(originDomain.value));
const otherSide = computed(() =>
  bridge.value ? (bridge.value.domains[0] === originDomain.value ? bridge.value.domains[1] : bridge.value.domains[0]) : '',
);

/**
 * Search over everything a row is known by: its name, device, node and format. Every
 * word has to match somewhere, in any order — "snp 3 video" finds the third video
 * sender of the SNP without typing its exact label.
 */
const terms = computed(() => filter.value.toLowerCase().split(/\s+/).filter(Boolean));
const searching = computed(() => terms.value.length > 0);
const matches = (...fields: (string | null | undefined)[]) => {
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return terms.value.every((t) => text.includes(t));
};
const visibleSenders = computed(() =>
  senders.value.filter((s) => matches(s.label, s.deviceLabel, s.nodeLabel, s.flow?.media_type)),
);
const visibleReceivers = computed(() =>
  receivers.value.filter((r) => matches(r.label, r.deviceLabel, r.nodeLabel, r.format.split(':').pop(), ...(r.caps?.media_types ?? []))),
);
/**
 * What a receiver is subscribed to, by the sender's name where this registry knows it —
 * a bare UUID tells nobody anything, and an active receiver without a sender id (a
 * manual SDP) used to read "connected to null".
 */
const senderNames = computed(() => new Map(senders.value.map((s) => [s.id, s.label])));
function currently(r: BrowseReceiver): string {
  const sub = r.subscription;
  if (!sub?.active) return 'idle';
  if (!sub.sender_id) return 'active, no sender (manual SDP)';
  return `connected to ${senderNames.value.get(sub.sender_id) ?? sub.sender_id}`;
}

const senderList = ref<{ expandAll: (open: boolean) => void } | null>(null);
const receiverList = ref<{ expandAll: (open: boolean) => void } | null>(null);
function expandAll(open: boolean) {
  senderList.value?.expandAll(open);
  receiverList.value?.expandAll(open);
}

async function load() {
  try {
    [cfg.value, mirrors.value] = await Promise.all([api.config(), api.mirrors()]);
    primeFromConfig(cfg.value);
    if (!deviceId.value) deviceId.value = cfg.value.devices[0]?.id ?? '';
    if (!sourceRegistry.value) sourceRegistry.value = registries.value[0]?.id ?? '';
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/**
 * `quiet` re-reads after a copy without emptying the lists first. Emptying them made the
 * tables vanish and come back, and the page jumped under the pointer every time.
 */
async function browse(quiet = false) {
  if (!sourceRegistry.value) return;
  if (!quiet) {
    busy.value = true;
    senders.value = [];
    receivers.value = [];
    selected.sender.clear();
    selected.receiver.clear();
  }
  try {
    const res = await api.browse(sourceRegistry.value);
    senders.value = res.senders;
    receivers.value = res.receivers;
    paging.value = res.paging;
    error.value = null;
    if (!quiet) {
      // The page count is the sum over senders, receivers, devices and flows — reporting
      // it as "N pages" next to a sender count read as nonsense. Say what it means.
      const paged = res.paging.limit && res.paging.pages > 5
        ? ` · this registry caps a page at ${res.paging.limit}, so the list was fetched in ${res.paging.pages} requests`
        : '';
      notify(`${res.senders.length} senders, ${res.receivers.length} receivers${paged}`);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    if (!quiet) busy.value = false;
  }
}

const formatOf = (format: string): 'video' | 'audio' | 'data' =>
  format.endsWith(':audio') ? 'audio' : format.endsWith(':data') ? 'data' : 'video';

/** Rows ticked for copying, per table. Cleared when another registry is browsed. */
const selected = reactive({ sender: new Set<string>(), receiver: new Set<string>() });

const copyableSender = (s: BrowseSender) => !s.copied && !s.ours && !!s.manifest_href;
const copyableReceiver = (r: BrowseReceiver) => !r.copied && !r.ours && r.controllable;

function toggle(kind: 'sender' | 'receiver', ids: string[], on: boolean) {
  for (const id of ids) {
    if (on) selected[kind].add(id);
    else selected[kind].delete(id);
  }
}

/** Messages float over the page instead of being inserted above the tables. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notify(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 6000);
}

async function copySelected(kind: 'sender' | 'receiver') {
  if (!deviceId.value) {
    error.value = 'pick a target device first';
    return;
  }
  const rows = (kind === 'sender' ? senders.value : receivers.value).filter((r) => selected[kind].has(r.id));
  busy.value = true;
  const failed: string[] = [];
  let done = 0;
  for (const item of rows) {
    notify(`${kind === 'sender' ? 'Copying' : 'Proxying'} ${done + 1} of ${rows.length}: ${item.label}…`);
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
      // Marked in place, so the row changes its last cell and nothing else moves.
      item.copied = true;
      selected[kind].delete(item.id);
      done++;
    } catch (e) {
      failed.push(`${item.label}: ${(e as Error).message}`);
    }
  }
  busy.value = false;
  error.value = failed.length ? failed.join(' · ') : null;
  if (done) {
    notify(
      kind === 'sender'
        ? `${done} sender(s) copied — NAT programmed and published`
        : `${done} receiver(s) proxied — connect a stream to a proxy to drive the original`,
    );
  }
  await Promise.all([load(), browse(true)]);
}

/** Name and registries of an existing copy; the stream itself is not touched. */
async function updateMirror(m: Mirror, change: { label?: string; registries?: string[] }) {
  try {
    await api.updateMirror(m.id, change);
    error.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function toggleShare(m: Mirror, registryId: string, on: boolean) {
  const next = on ? [...m.registries, registryId] : m.registries.filter((id) => id !== registryId);
  // Order as offered, so the stored list does not depend on the clicking order.
  void updateMirror(m, { registries: m.registryChoices.filter((id) => next.includes(id)) });
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
    Copies an existing resource directly, without going through a virtual receiver, in either
    direction of the bridge — away from the registry you browse.
    A <strong>sender</strong> copy reads the original's SDP from its manifest, NATs the stream into the
    bridge's other domain and publishes the copy there. A <strong>receiver</strong> copy creates a proxy in
    the other domain: connect a stream to it and the original receiver is driven over IS-05.
  </p>
  <div class="toasts" aria-live="polite">
    <p v-if="error" class="toast bad" @click="error = null" title="click to dismiss">{{ error }}</p>
    <p v-if="notice" class="toast notice">{{ notice }}</p>
  </div>

  <section class="box">
    <div class="row">
      <label>Source registry
        <select v-model="sourceRegistry" @change="browse()">
          <option v-for="r in registries" :key="r.id" :value="r.id">{{ r.label }} — {{ domainName(r.domainId) }}</option>
        </select>
      </label>
      <label>Target device
        <select v-model="deviceId">
          <option v-for="d in cfg?.devices ?? []" :key="d.id" :value="d.id">
            {{ cfg?.bridges.find((b) => b.id === d.bridgeId)?.label }} · {{ d.label }}
          </option>
        </select>
      </label>
      <button :disabled="busy || !sourceRegistry" @click="browse()">{{ busy ? 'working…' : 'Browse' }}</button>
    </div>
    <p v-if="paging?.truncated" class="warn">
      The registry returned more pages than this browse follows — the list may be incomplete.
    </p>
    <p v-if="!cfg?.devices.length" class="warn">
      No devices yet. Create a bridge and a device under
      <RouterLink to="/bridges">Bridges</RouterLink> first — the bridge supplies the direction, the target
      registries and the NAT setting that a copy needs.
    </p>
  </section>

  <section v-if="senders.length || receivers.length">
    <div class="toolbar">
      <input
        ref="searchBox"
        v-model="filter"
        type="search"
        class="search"
        placeholder="Search name, device, node or format — e.g. “snp video 3”"
        @keydown.esc="filter = ''"
      />
      <small class="count">
        {{ visibleSenders.length }}<template v-if="searching"> of {{ senders.length }}</template> senders ·
        {{ visibleReceivers.length }}<template v-if="searching"> of {{ receivers.length }}</template> receivers
      </small>
      <button :disabled="searching" @click="expandAll(true)">Expand all</button>
      <button :disabled="searching" @click="expandAll(false)">Collapse all</button>
    </div>

    <h3>Senders <small v-if="inBridge">copied from {{ domainName(originDomain) }} into {{ domainName(otherSide) }}</small></h3>
    <!-- With no device there is nothing to say about domains yet; saying it anyway
         produced three contradictory messages and a blank domain name. -->
    <p v-if="!bridge" class="warn">Pick a target device to copy anything.</p>
    <p v-else-if="!inBridge" class="warn">
      This registry is in <strong>{{ domainName(originDomain) }}</strong>, which the bridge
      “{{ bridge.label }}” does not join — it connects {{ domainName(bridge.domains[0]) }} and
      {{ domainName(bridge.domains[1]) }}.
    </p>
    <template v-else>
      <div class="bulk">
        <button :disabled="busy || !selected.sender.size" @click="copySelected('sender')">
          Copy selected ({{ selected.sender.size }})
        </button>
      </div>
      <BrowseList
        ref="senderList"
        :rows="visibleSenders"
        :selected="selected.sender"
        :copyable="copyableSender"
        :searching="searching"
        :busy="busy"
        noun="sender"
        :col-classes="['c-ess']"
        @toggle="(ids, on) => toggle('sender', ids, on)"
      >
        <template #head><th>Essence</th></template>
        <template #cells="{ row: s }">
          <td>
            <template v-if="s.flow">{{ s.flow.media_type }}<small v-if="s.flow.frame_width">{{ s.flow.frame_width }}×{{ s.flow.frame_height }}</small></template>
            <small v-else>unknown</small>
          </td>
        </template>
        <template #status="{ row: s }">
          <span v-if="s.copied" class="ok">copied</span>
          <span v-else-if="s.ours" class="muted" title="copying our own copy would loop">—</span>
          <span v-else-if="!s.manifest_href" class="muted" title="no manifest_href, so there is no SDP to read">no manifest</span>
        </template>
      </BrowseList>
    </template>

    <h3>Receivers <small v-if="inBridge">proxied into {{ domainName(otherSide) }}, driving them in {{ domainName(originDomain) }}</small></h3>
    <p v-if="!bridge" class="warn">Pick a target device to copy anything.</p>
    <p v-else-if="!inBridge" class="warn">
      This registry is in <strong>{{ domainName(originDomain) }}</strong>, which the bridge
      “{{ bridge.label }}” does not join.
    </p>
    <template v-else>
      <div class="bulk">
        <button :disabled="busy || !selected.receiver.size" @click="copySelected('receiver')">
          Proxy selected ({{ selected.receiver.size }})
        </button>
      </div>
      <BrowseList
        ref="receiverList"
        :rows="visibleReceivers"
        :selected="selected.receiver"
        :copyable="copyableReceiver"
        :searching="searching"
        :busy="busy"
        noun="receiver"
        :col-classes="['c-ess', 'c-cur']"
        @toggle="(ids, on) => toggle('receiver', ids, on)"
      >
        <template #head><th>Accepts</th><th>Currently</th></template>
        <template #cells="{ row: r }">
          <td>{{ (r.caps?.media_types ?? []).join(', ') || '—' }}</td>
          <td><small>{{ currently(r) }}</small></td>
        </template>
        <template #status="{ row: r }">
          <span v-if="r.copied" class="ok">proxied</span>
          <span v-else-if="r.ours" class="muted">—</span>
          <span v-else-if="!r.controllable" class="muted" title="advertises no sr-ctrl control, so it cannot be driven over IS-05">not controllable</span>
        </template>
      </BrowseList>
    </template>
  </section>

  <section>
    <h3>Existing copies</h3>
    <table v-if="mirrors.length">
      <thead><tr><th>Name</th><th>Kind</th><th>Direction</th><th>Shared in</th><th>State</th><th></th></tr></thead>
      <tbody>
        <tr v-for="m in mirrors" :key="m.id">
          <td>
            <strong><EditableName :value="m.name" @save="(label) => updateMirror(m, { label })" /></strong>
            <small>{{ m.name !== m.originLabel ? `${m.originLabel} · ` : '' }}from {{ registryName(m.registryId) }}</small>
          </td>
          <td>{{ m.kind === 'sender' ? 'sender copy' : 'receiver proxy' }}</td>
          <td><small v-if="m.device?.from">{{ domainName(m.device.from) }} → {{ domainName(m.device.to ?? '') }}{{ m.device.nat ? '' : ' (no NAT)' }}</small></td>
          <td class="share">
            <label v-for="id in m.registryChoices" :key="id" class="check" :title="m.kind === 'sender' ? 'publish the copied sender here' : 'offer the proxy receiver here'">
              <input
                type="checkbox"
                :checked="m.registries.includes(id)"
                :disabled="busy || (m.registries.length === 1 && m.registries.includes(id))"
                @change="toggleShare(m, id, ($event.target as HTMLInputElement).checked)"
              />
              {{ registryName(id) }}
            </label>
            <small v-if="!m.registryChoices.length">no registry in that domain</small>
          </td>
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
.bulk { margin: 0.2rem 0 0.4rem; }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; padding: 0.5rem 0; margin-bottom: 0.5rem; background: Canvas; border-bottom: 1px solid #8883; }
.search { flex: 1 1 22rem; padding: 0.45rem 0.6rem; font-size: 0.95rem; }
.count { opacity: 0.7; white-space: nowrap; }
.share { display: flex; flex-wrap: wrap; gap: 0.2rem 0.75rem; }
label.check { flex-direction: row; align-items: center; gap: 0.3rem; font-size: 0.85rem; white-space: nowrap; }
.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem; max-width: min(36rem, calc(100vw - 2rem)); z-index: 50; }
.toast { margin: 0; padding: 0.6rem 0.85rem; border-radius: 6px; background: Canvas; color: CanvasText; border: 1px solid #8886; box-shadow: 0 4px 16px #0003; font-size: 0.9rem; }
.toast.bad { border-color: #d24b3e; color: #d24b3e; cursor: pointer; }
.toast.notice { border-color: #2e9e4f; }
</style>
