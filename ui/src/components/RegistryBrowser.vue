<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api, type BrowseReceiver, type BrowseSender, type Bridge, type Config, type Device } from '../api';
import { domainName, registryName } from '../names';
import BrowseList from './BrowseList.vue';

/**
 * The source half of the Bridges page: browse a registry and copy what is there into
 * the target device picked on the right. A sender copy is published in the bridge's
 * other domain, a receiver proxy offered there — a copy always runs away from the
 * registry it comes from, so the registry only has to sit in one of the bridge's two
 * domains.
 */
const props = defineProps<{ cfg: Config | null; target: Device | null; bridge: Bridge | null }>();
const emit = defineEmits<{ changed: []; notice: [text: string]; error: [text: string | null] }>();

const senders = ref<BrowseSender[]>([]);
const receivers = ref<BrowseReceiver[]>([]);
const sourceRegistry = ref('');
const filter = ref('');
const busy = ref(false);
const paging = ref<{ limit: number | null; pages: number; truncated: boolean } | null>(null);
const watchFeeds = ref<{ registryId: string; kind: 'sender' | 'receiver'; state: 'connecting' | 'open' | 'retrying'; error: string | null }[]>([]);

const registries = computed(() => (props.cfg?.registries ?? []).filter((r) => r.enabled));
watch(
  registries,
  (regs) => {
    if (!sourceRegistry.value && regs[0]) {
      sourceRegistry.value = regs[0].id;
      void browse();
    }
  },
  { immediate: true },
);

const originDomain = computed(() => registries.value.find((r) => r.id === sourceRegistry.value)?.domainId ?? '');
const inBridge = computed(() => !!props.bridge && props.bridge.domains.includes(originDomain.value));
const otherSide = computed(() =>
  props.bridge ? (props.bridge.domains[0] === originDomain.value ? props.bridge.domains[1] : props.bridge.domains[0]) : '',
);

/** One line per registry: live when every feed of it (senders, receivers) is. */
const feeds = computed(() => {
  const by = new Map<string, { registryId: string; state: 'connecting' | 'open' | 'retrying'; error: string | null; kinds: string[] }>();
  for (const f of watchFeeds.value) {
    const cur = by.get(f.registryId) ?? { registryId: f.registryId, state: 'open' as const, error: null, kinds: [] };
    cur.kinds.push(f.kind);
    if (f.state !== 'open' && cur.state === 'open') {
      cur.state = f.state;
      cur.error = f.error;
    }
    by.set(f.registryId, cur);
  }
  return [...by.values()];
});

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
const visibleSenders = computed(() => senders.value.filter((s) => matches(s.label, s.deviceLabel, s.nodeLabel, s.flow?.media_type)));
const visibleReceivers = computed(() =>
  receivers.value.filter((r) => matches(r.label, r.deviceLabel, r.nodeLabel, r.format.split(':').pop(), ...(r.caps?.media_types ?? []))),
);

/** What a receiver is subscribed to, by the sender's name where this registry knows it. */
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
    const [res, w] = await Promise.all([api.browse(sourceRegistry.value), api.mirrorWatch().catch(() => [])]);
    senders.value = res.senders;
    receivers.value = res.receivers;
    paging.value = res.paging;
    watchFeeds.value = w;
    emit('error', null);
  } catch (e) {
    emit('error', (e as Error).message);
  } finally {
    if (!quiet) busy.value = false;
  }
}
defineExpose({ browse });

const formatOf = (format: string): 'video' | 'audio' | 'data' =>
  format.endsWith(':audio') ? 'audio' : format.endsWith(':data') ? 'data' : 'video';

/** Rows ticked for copying, per list. Cleared when another registry is browsed. */
const selected = reactive({ sender: new Set<string>(), receiver: new Set<string>() });
// MXL is shared memory on one host — nothing to NAT, no SDP: never copyable.
const copyableSender = (s: BrowseSender) => !s.copied && !s.ours && !s.mxl && !!s.manifest_href;
const copyableReceiver = (r: BrowseReceiver) => !r.copied && !r.ours && !r.mxl && r.controllable;
const MXL_TITLE = 'MXL is host-local shared memory: no multicast to NAT, no SDP — it cannot be federated into another network';

function toggle(kind: 'sender' | 'receiver', ids: string[], on: boolean) {
  for (const id of ids) {
    if (on) selected[kind].add(id);
    else selected[kind].delete(id);
  }
}

async function copySelected(kind: 'sender' | 'receiver') {
  const target = props.target;
  if (!target) return emit('error', 'pick a target device on the right first');
  const rows = (kind === 'sender' ? senders.value : receivers.value).filter((r) => selected[kind].has(r.id));
  busy.value = true;
  const failed: string[] = [];
  let done = 0;
  for (const item of rows) {
    emit('notice', `${kind === 'sender' ? 'Copying' : 'Proxying'} ${done + 1} of ${rows.length}: ${item.label}…`);
    try {
      await api.createMirror({
        kind,
        deviceId: target.id,
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
  emit('error', failed.length ? failed.join(' · ') : null);
  if (done) {
    emit('notice', kind === 'sender' ? `${done} sender(s) copied into ${target.label}` : `${done} receiver(s) proxied into ${target.label}`);
    emit('changed');
  }
  await browse(true);
}
</script>

<template>
  <div class="browser">
    <div class="source-pick">
      <label>Source registry
        <select v-model="sourceRegistry" @change="browse()">
          <option v-for="r in registries" :key="r.id" :value="r.id">{{ r.label }} — {{ domainName(r.domainId) }}</option>
        </select>
      </label>
      <button :disabled="busy || !sourceRegistry" @click="browse()">{{ busy ? 'loading…' : 'Reload' }}</button>
    </div>
    <p v-if="feeds.length" class="feeds">
      <span v-for="w in feeds" :key="w.registryId" :class="w.state === 'open' ? 'ok' : 'busy'" :title="w.state === 'open' ? 'changes of the originals arrive through this registry\'s feed — nothing is polled' : (w.error ?? '')">
        {{ registryName(w.registryId) }}: {{ w.state === 'open' ? 'live' : w.state === 'connecting' ? 'connecting…' : 'reconnecting' }}
      </span>
    </p>
    <p v-if="paging?.truncated" class="warn">The registry returned more pages than are followed — the list may be incomplete.</p>

    <div class="toolbar">
      <input v-model="filter" type="search" class="search" placeholder="Search name, device, node or format" @keydown.esc="filter = ''" />
      <small class="count">
        {{ visibleSenders.length }}<template v-if="searching">/{{ senders.length }}</template> TX ·
        {{ visibleReceivers.length }}<template v-if="searching">/{{ receivers.length }}</template> RX
      </small>
      <button :disabled="searching" title="expand all" @click="expandAll(true)">▾</button>
      <button :disabled="searching" title="collapse all" @click="expandAll(false)">▸</button>
    </div>

    <p v-if="!target" class="hint">Click a device on the right to make it the target.</p>
    <p v-else-if="!inBridge && sourceRegistry" class="warn">
      {{ registryName(sourceRegistry) }} is in {{ domainName(originDomain) }}, which the bridge of
      “{{ target.label }}” does not join ({{ domainName(bridge?.domains[0] ?? '') }} ⇄ {{ domainName(bridge?.domains[1] ?? '') }}).
    </p>

    <h3>Senders <small v-if="inBridge">copied into {{ domainName(otherSide) }}</small></h3>
    <div class="bulk">
      <button :disabled="busy || !target || !inBridge || !selected.sender.size" @click="copySelected('sender')">
        Copy {{ selected.sender.size || '' }} into {{ target?.label ?? '…' }}
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
      :inactive="(s) => s.subscription?.active === false || !!s.mxl"
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
        <span v-if="s.mxl" class="muted" :title="MXL_TITLE">MXL — host-local</span>
        <span v-else-if="s.copied" class="ok">copied</span>
        <span v-else-if="s.subscription?.active === false" class="muted" title="switched off at the device">inactive</span>
        <span v-else-if="s.ours" class="muted" title="copying our own copy would loop">—</span>
        <span v-else-if="!s.manifest_href" class="muted" title="no manifest_href, so there is no SDP to read">no manifest</span>
      </template>
    </BrowseList>

    <h3>Receivers <small v-if="inBridge">proxied into {{ domainName(otherSide) }}</small></h3>
    <div class="bulk">
      <button :disabled="busy || !target || !inBridge || !selected.receiver.size" @click="copySelected('receiver')">
        Proxy {{ selected.receiver.size || '' }} into {{ target?.label ?? '…' }}
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
      :inactive="(r) => !!r.mxl"
      @toggle="(ids, on) => toggle('receiver', ids, on)"
    >
      <template #head><th>Accepts</th><th>Currently</th></template>
      <template #cells="{ row: r }">
        <td>{{ (r.caps?.media_types ?? []).join(', ') || '—' }}</td>
        <td><small>{{ currently(r) }}</small></td>
      </template>
      <template #status="{ row: r }">
        <span v-if="r.mxl" class="muted" :title="MXL_TITLE">MXL — host-local</span>
        <span v-else-if="r.copied" class="ok">proxied</span>
        <span v-else-if="r.ours" class="muted">—</span>
        <span v-else-if="!r.controllable" class="muted" title="advertises no sr-ctrl control, so it cannot be driven over IS-05">not controllable</span>
      </template>
    </BrowseList>
  </div>
</template>

<style scoped>
/* Not .pick: BrowseList's table carries that class, and a scoped rule here reaches a
   child component's root element. */
.source-pick { display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap; }
.source-pick label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; flex: 1 1 14rem; }
select, input { padding: 0.3rem 0.4rem; }
.feeds { display: flex; flex-wrap: wrap; gap: 0.2rem 0.75rem; font-size: 0.75rem; margin: 0.4rem 0; }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0; background: Canvas; border-bottom: 1px solid #8883; }
.search { flex: 1 1 auto; min-width: 0; padding: 0.4rem 0.55rem; }
.count { opacity: 0.7; white-space: nowrap; font-size: 0.8rem; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 1rem 0 0.3rem; }
h3 small { text-transform: none; letter-spacing: 0; margin-left: 0.4rem; opacity: 0.8; }
.bulk { margin: 0.2rem 0 0.4rem; }
.hint { font-size: 0.85rem; color: #2e7fc0; margin: 0.5rem 0; }
.warn { color: #c08a2e; font-size: 0.85rem; }
.ok { color: #2e9e4f; }
.busy { color: #c08a2e; }
.muted { opacity: 0.5; }
td small { display: block; opacity: 0.6; }
</style>
