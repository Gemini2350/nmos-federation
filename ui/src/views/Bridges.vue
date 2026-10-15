<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Bridge, type Config, type Device, type Mirror, type VirtualReceiver } from '../api';
import { domainName, primeFromConfig, registryName, registryNames } from '../names';
import InfoHint from '../components/InfoHint.vue';
import EditableName from '../components/EditableName.vue';
import RegistryBrowser from '../components/RegistryBrowser.vue';

/**
 * Bridges and copies on one page: on the left a registry's senders and receivers (the
 * source), on the right the bridges with their devices (the target). Clicking a device
 * makes it the target of the copy buttons on the left; what is copied appears in it at
 * once, and everything a copy needs — name, group, where it is shared, its state,
 * Refresh, Remove — sits on its own row.
 */
const cfg = ref<Config | null>(null);
const bridges = ref<Bridge[]>([]);
const devices = ref<Device[]>([]);
const mirrors = ref<Mirror[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const targetId = ref<string | null>(null);

const draft = ref({ label: 'NMOS Federation', domains: ['', ''] as [string, string], registries: [] as string[], nat: true, grouping: true });
const groupingOn = (d: Device) => bridgeOf(d)?.grouping !== false;
const deviceDraft = ref<Record<string, string>>({});
const rxDraft = ref<Record<string, { count: number; pattern: string; format: VirtualReceiver['format']; side: string }>>({});

const domains = computed(() => cfg.value?.domains ?? []);
const registriesOf = (domainId: string) => (cfg.value?.registries ?? []).filter((r) => r.domainId === domainId);
const bridgeOf = (d: Device) => bridges.value.find((b) => b.id === d.bridgeId);
const other = (b: Bridge | undefined, domainId: string) => (b ? (b.domains[0] === domainId ? b.domains[1] : b.domains[0]) : '');
const target = computed(() => devices.value.find((d) => d.id === targetId.value) ?? null);
const targetBridge = computed(() => (target.value ? (bridgeOf(target.value) ?? null) : null));
const mirrorById = computed(() => new Map(mirrors.value.map((m) => [m.id, m])));
const mirrorOf = (id: string | undefined) => (id ? mirrorById.value.get(id) : undefined);

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

/** A copy's state in a word, with the whole story in the tooltip. */
function copyState(m: Mirror | undefined): { word: string; cls: string; title: string } {
  if (!m) return { word: '', cls: '', title: '' };
  const c = m.channel;
  if (c?.state === 'active' && c.originActive === false) return { word: 'inactive', cls: 'muted', title: 'the original sender is switched off; the copy follows it' };
  if (m.originMissing) return { word: 'offline', cls: 'bad', title: `original ${m.originMissing.reason} (since ${new Date(m.originMissing.since).toLocaleString()})` };
  if (!c) return m.kind === 'receiver' ? { word: 'idle', cls: 'muted', title: 'nothing connected to the proxy' } : { word: 'not built', cls: 'warn', title: '' };
  if (c.state !== 'active') return { word: c.state, cls: c.state === 'failed' ? 'bad' : 'warn', title: c.error ?? '' };
  const groups = c.allocation ? c.legs.map((l) => c.allocation!.groups[l.fabric]) : c.legs.map((l) => l.group);
  const addr = `${groups.join(' / ') || '—'}${c.allocation ? '' : ' (NAT off)'}`;
  if (c.remoteReceiver && !c.remoteReceiver.connected) return { word: 'active ⚠', cls: 'warn', title: `${addr} · remote receiver NOT connected: ${c.remoteReceiver.error}` };
  return { word: 'active', cls: 'ok', title: c.remoteReceiver ? `${addr} · remote receiver connected` : addr };
}

async function refresh() {
  try {
    [cfg.value, bridges.value, devices.value, mirrors.value] = await Promise.all([api.config(), api.bridges(), api.devices(), api.mirrors()]);
    primeFromConfig(cfg.value);
    if (!draft.value.domains[0]) {
      draft.value.domains = [
        domains.value.find((d) => d.kind === 'internal')?.id ?? '',
        domains.value.find((d) => d.kind === 'external')?.id ?? '',
      ];
    }
    if (!targetId.value || !devices.value.some((d) => d.id === targetId.value)) targetId.value = devices.value[0]?.id ?? null;
    for (const b of bridges.value) deviceDraft.value[b.id] ??= 'Device';
    for (const d of devices.value) {
      rxDraft.value[d.id] ??= { count: 1, pattern: `${d.label} {n}`, format: 'video', side: bridgeOf(d)?.domains[0] ?? '' };
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** Messages float over the page instead of pushing it down. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notify(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 6000);
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
  await run(async () => {
    const res = await api.updateBridge(bridge.id, change);
    if (res.rebuilt) {
      const failed = res.failed?.length ?? 0;
      notify(failed ? `${res.rebuilt} channel(s) rebuilt, ${failed} failed: ${res.failed!.map((f) => f.error).join('; ')}` : `${res.rebuilt} channel(s) rebuilt.`);
    }
  });
}

/** Where a copy is shared — ticking a registry publishes or offers it there. */
function toggleShare(m: Mirror, registryId: string, on: boolean) {
  const next = on ? [...m.registries, registryId] : m.registries.filter((id) => id !== registryId);
  void rename(() => api.updateMirror(m.id, { registries: m.registryChoices.filter((id) => next.includes(id)) }));
}

/**
 * Which devices are open. Collapsed by default — a device of 30 ports is a screenful —
 * and remembered in this browser only (it is a view preference, not configuration).
 */
const OPEN_KEY = 'nmos-federation.bridges.openDevices';
const open = ref<Set<string>>(new Set());
try {
  const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
  if (Array.isArray(saved)) open.value = new Set(saved.filter((x): x is string => typeof x === 'string'));
} catch {
  /* private window, blocked storage: everything starts collapsed */
}
function setOpen(ids: string[], on: boolean) {
  const next = new Set(open.value);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  open.value = next;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    /* not remembered, still works */
  }
}
const isOpen = (d: Device) => open.value.has(d.id);

/** What a collapsed device still says: how many ports, and anything wrong with them. */
function summary(d: Device): { text: string; problems: string } {
  const proxies = (d.receivers ?? []).filter((r) => r.proxyFor).length;
  const virtual = (d.receivers?.length ?? 0) - proxies;
  const copies = d.senderCopies?.length ?? 0;
  const parts = [
    virtual ? `${virtual} virtual receiver${virtual === 1 ? '' : 's'}` : '',
    proxies ? `${proxies} prox${proxies === 1 ? 'y' : 'ies'}` : '',
    copies ? `${copies} sender cop${copies === 1 ? 'y' : 'ies'}` : '',
  ].filter(Boolean);
  const words = [
    ...(d.receivers ?? []).map((r) => copyState(mirrorOf(r.proxyFor?.mirrorId)).word),
    ...(d.senderCopies ?? []).map((c) => copyState(mirrorOf(c.id)).word),
  ];
  const count = (w: string) => words.filter((x) => x === w).length;
  const problems = [
    count('offline') ? `${count('offline')} offline` : '',
    count('failed') ? `${count('failed')} failed` : '',
    count('active ⚠') ? `${count('active ⚠')} not connected` : '',
  ].filter(Boolean);
  return { text: parts.join(' · ') || 'no ports', problems: problems.join(' · ') };
}

/** After a copy: show its result — the target opens. */
function afterCopy() {
  if (targetId.value) setOpen([targetId.value], true);
  void refresh();
}

const browser = ref<{ browse: (quiet?: boolean) => Promise<void> } | null>(null);
/** Removing a copy frees its original for copying again — the browser shows that. */
async function removeCopy(fn: () => Promise<unknown>) {
  await run(fn);
  await browser.value?.browse(true);
}

onMounted(refresh);
</script>

<template>
  <div class="toasts" aria-live="polite">
    <p v-if="error" class="toast bad" title="click to dismiss" @click="error = null">{{ error }}</p>
    <p v-if="notice" class="toast notice">{{ notice }}</p>
  </div>

  <div class="split">
    <!-- ── Source: a registry's senders and receivers ── -->
    <aside class="source">
      <h2>
        Copy from a registry
        <InfoHint wide>
          A <strong>sender</strong> copy reads the original's SDP, NATs the stream into the bridge's other domain
          and publishes it there. A <strong>receiver</strong> copy creates a proxy in the other domain: connect a
          stream to it and the original receiver is driven over IS-05. A copy always runs away from the
          registry you browse. The target is the device selected on the right.
        </InfoHint>
      </h2>
      <RegistryBrowser
        ref="browser"
        :cfg="cfg"
        :target="target"
        :bridge="targetBridge"
        @changed="afterCopy"
        @notice="notify"
        @error="(e) => (error = e)"
      />
    </aside>

    <!-- ── Target: bridges, devices, ports ── -->
    <section class="target">
      <h2>
        Bridges
        <InfoHint wide>
          A bridge joins two domains and <strong>is</strong> an NMOS node: every registry in either domain
          shows it under this name. It carries streams both ways — each virtual receiver is offered in one
          of the two domains and its stream flows to the other. Registries and NAT belong to the bridge; a
          device is simply a group of ports on it, in either direction. Click a device to copy into it.
        </InfoHint>
      </h2>

      <details class="new" :open="!bridges.length">
        <summary>New bridge</summary>
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
          <label class="check"><input type="checkbox" v-model="draft.nat" /><span>NAT<InfoHint text="Off copies every SDP verbatim and touches no switch — right when the address plans do not collide." /></span></label>
          <label class="check"><input type="checkbox" v-model="draft.grouping" /><span>Grouping<InfoHint text="Natural grouping (BCP-002-01): ports carry group hints so controllers show video, audio and ancillary of one source together. Off publishes no hints; groups you set stay stored." /></span></label>
          <button :disabled="busy" @click="run(() => api.createBridge(draft))">Create bridge</button>
        </div>
        <fieldset v-for="dom in draft.domains.filter((x, i) => x && draft.domains.indexOf(x) === i)" v-show="registriesOf(dom).length" :key="dom">
          <legend>Registries in {{ domainName(dom) }} (none ticked = all enabled ones)</legend>
          <label v-for="r in registriesOf(dom)" :key="r.id" class="check"><input type="checkbox" :value="r.id" v-model="draft.registries" /> {{ r.label }}</label>
        </fieldset>
        <p v-if="domains.length < 2" class="warn">A bridge needs two domains — add a second one under Settings first.</p>
      </details>

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
              Points at {{ (b.missing?.domains ?? []).map(domainName).join(' and ') }}, which does not exist — this bridge registers nothing.
            </small>
          </div>
          <div class="controls">
            <label class="check" title="Rebuilds this bridge's channels"><input type="checkbox" :checked="b.nat" @change="patchBridge(b, { nat: ($event.target as HTMLInputElement).checked })" /> NAT</label>
            <label class="check" title="Natural grouping (BCP-002-01) — off publishes no group hints; the groups set stay stored"><input type="checkbox" :checked="b.grouping !== false" @change="patchBridge(b, { grouping: ($event.target as HTMLInputElement).checked })" /> Grouping</label>
            <button title="expand all devices" @click="setOpen(devicesOf(b.id).map((d) => d.id), true)">▾ all</button>
            <button title="collapse all devices" @click="setOpen(devicesOf(b.id).map((d) => d.id), false)">▸ all</button>
            <button :disabled="busy" @click="run(() => api.deleteBridge(b.id))">Delete bridge</button>
          </div>
        </header>

        <article v-for="d in devicesOf(b.id)" :key="d.id" :class="['device', { target: d.id === targetId }]" @click="targetId = d.id">
          <header>
            <div>
              <button class="chev" :title="isOpen(d) ? 'collapse' : 'expand'" @click.stop="setOpen([d.id], !isOpen(d))">{{ isOpen(d) ? '▾' : '▸' }}</button>
              <strong><EditableName :value="d.label" @save="(label) => rename(() => api.updateDevice(d.id, { label }))" /></strong>
              <span v-if="d.id === targetId" class="tgt">◀ copy target</span>
              <small class="sum">{{ summary(d).text }}<span v-if="summary(d).problems" class="bad"> · {{ summary(d).problems }}</span></small>
              <small v-if="d.passthrough" class="pass" title="Every port of this device is a copy of one original device, so its control APIs are offered here too — through this software, with ids translated to the copies'.">
                passes through {{ d.passthrough.apis.join(' and ') }} of {{ d.passthrough.from }} · in {{ domainName(d.passthrough.domainId) }}
              </small>
            </div>
            <button :disabled="busy" @click.stop="run(() => api.deleteDevice(d.id))">Remove device</button>
          </header>

          <template v-if="isOpen(d)">
          <table v-if="d.receivers?.length">
            <thead><tr><th>Receiver</th><th v-if="groupingOn(d)">Group</th><th>Direction</th><th>State</th><th></th></tr></thead>
            <tbody>
              <tr v-for="vrx in d.receivers" :key="vrx.id">
                <td>
                  <EditableName :value="vrx.label" @save="(label) => rename(() => api.renameReceiver(vrx.id, label))" />
                  <small v-if="vrx.origin" class="orig">proxy of {{ vrx.origin.label }} · {{ registryName(vrx.origin.registryId) }}</small>
                  <small v-else class="orig">virtual · {{ vrx.format }}</small>
                </td>
                <td v-if="groupingOn(d)">
                  <EditableName :value="vrx.group ?? ''" allow-empty chain="group" :placeholder="vrx.groupHint?.group ?? '—'" @save="(group) => rename(() => api.setReceiverGroup(vrx.id, { group }))" />
                  <div v-if="vrx.groupHint || vrx.role" class="role">
                    <EditableName :value="vrx.role ?? ''" allow-empty chain="role" :placeholder="vrx.groupHint?.role ?? 'role'" @save="(role) => rename(() => api.setReceiverGroup(vrx.id, { role }))" />
                  </div>
                </td>
                <td>
                  <small class="dir">{{ direction(d, vrx) }}</small>
                  <span v-if="mirrorOf(vrx.proxyFor?.mirrorId)?.registryChoices.length" class="share">
                    <label v-for="id in mirrorOf(vrx.proxyFor?.mirrorId)!.registryChoices" :key="id" class="check" title="offer the proxy here">
                      <input type="checkbox" :checked="mirrorOf(vrx.proxyFor?.mirrorId)!.registries.includes(id)" :disabled="mirrorOf(vrx.proxyFor?.mirrorId)!.registries.length === 1 && mirrorOf(vrx.proxyFor?.mirrorId)!.registries.includes(id)" @click.stop @change="toggleShare(mirrorOf(vrx.proxyFor?.mirrorId)!, id, ($event.target as HTMLInputElement).checked)" />
                      {{ registryName(id) }}
                    </label>
                  </span>
                </td>
                <td :class="copyState(mirrorOf(vrx.proxyFor?.mirrorId)).cls" :title="copyState(mirrorOf(vrx.proxyFor?.mirrorId)).title">
                  {{ vrx.proxyFor ? copyState(mirrorOf(vrx.proxyFor.mirrorId)).word : '' }}
                </td>
                <td class="actions"><button :disabled="busy" @click.stop="removeCopy(() => api.deleteReceiver(vrx.id))">Remove</button></td>
              </tr>
            </tbody>
          </table>

          <table v-if="d.senderCopies?.length" class="copies">
            <thead><tr><th>Copied sender</th><th v-if="groupingOn(d)">Group</th><th>Direction</th><th>State</th><th></th></tr></thead>
            <tbody>
              <tr v-for="c in d.senderCopies" :key="c.id">
                <td>
                  <EditableName :value="c.name" @save="(label) => rename(() => api.updateMirror(c.id, { label }))" />
                  <small class="orig">copy of {{ c.originLabel }} · {{ registryName(c.registryId) }}</small>
                </td>
                <td v-if="groupingOn(d)">
                  <EditableName :value="c.group ?? ''" allow-empty chain="group" :placeholder="c.groupHint?.group ?? '—'" @save="(group) => rename(() => api.updateMirror(c.id, { group }))" />
                  <div v-if="c.groupHint || c.role" class="role">
                    <EditableName :value="c.role ?? ''" allow-empty chain="role" :placeholder="c.groupHint?.role ?? 'role'" @save="(role) => rename(() => api.updateMirror(c.id, { role }))" />
                  </div>
                </td>
                <td>
                  <small class="dir">{{ c.from ? `${domainName(c.from)} → ${domainName(c.to ?? '')}` : '—' }}</small>
                  <span v-if="mirrorOf(c.id)?.registryChoices.length" class="share">
                    <label v-for="id in mirrorOf(c.id)!.registryChoices" :key="id" class="check" title="publish the copy here">
                      <input type="checkbox" :checked="mirrorOf(c.id)!.registries.includes(id)" :disabled="mirrorOf(c.id)!.registries.length === 1 && mirrorOf(c.id)!.registries.includes(id)" @click.stop @change="toggleShare(mirrorOf(c.id)!, id, ($event.target as HTMLInputElement).checked)" />
                      {{ registryName(id) }}
                    </label>
                  </span>
                </td>
                <td :class="copyState(mirrorOf(c.id)).cls" :title="copyState(mirrorOf(c.id)).title">{{ copyState(mirrorOf(c.id)).word }}</td>
                <td class="actions">
                  <button :disabled="busy" title="re-read the original's SDP now — changes are followed automatically" @click.stop="run(() => api.refreshMirror(c.id))">↻</button>
                  <button :disabled="busy" @click.stop="removeCopy(() => api.deleteMirror(c.id))">Remove</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!d.receivers?.length && !d.senderCopies?.length" class="empty">
            No ports yet — copy from the registry on the left, or add virtual receivers below.
          </p>

          <details class="add" @click.stop>
            <summary>Add virtual receivers</summary>
            <div v-if="rxDraft[d.id]" class="row">
              <label><span>Count</span><input type="number" min="1" max="256" v-model.number="rxDraft[d.id]!.count" /></label>
              <label><span>Name pattern</span><input v-model="rxDraft[d.id]!.pattern" /></label>
              <label><span>Direction <InfoHint text="The receivers appear in the domain on the left. A stream connected to one flows to the domain on the right, where its sender is published." /></span>
                <select v-model="rxDraft[d.id]!.side">
                  <option v-for="dom in bridgeOf(d)?.domains ?? []" :key="dom" :value="dom">{{ domainName(dom) }} → {{ domainName(other(bridgeOf(d), dom)) }}</option>
                </select>
              </label>
              <label><span>Format</span>
                <select v-model="rxDraft[d.id]!.format"><option value="video">video</option><option value="audio">audio</option><option value="data">data</option></select>
              </label>
              <button :disabled="busy" @click="run(() => api.addReceivers(d.id, rxDraft[d.id]!))">Add</button>
            </div>
          </details>
          </template>
        </article>

        <div class="row add-device">
          <label><span>New device</span><input v-model="deviceDraft[b.id]" placeholder="Cameras" /></label>
          <button :disabled="busy" @click="run(() => api.createDevice({ bridgeId: b.id, label: deviceDraft[b.id] }))">Add device</button>
        </div>
      </article>

      <p v-if="!bridges.length"><small>No bridges yet.</small></p>
    </section>
  </div>
</template>

<style scoped>
/* Two columns: the source stays in view while the target side scrolls. Below that
   width they stack, source first. */
.split { display: grid; grid-template-columns: minmax(24rem, 5fr) 7fr; gap: 1.5rem; align-items: start; }
.source { position: sticky; top: 0.5rem; max-height: calc(100vh - 1rem); overflow: auto; padding-right: 0.5rem; border-right: 1px solid #8883; }
@media (max-width: 1100px) {
  .split { grid-template-columns: 1fr; }
  .source { position: static; max-height: none; border-right: 0; padding-right: 0; }
}
h2 { display: flex; align-items: center; font-size: 1.15rem; margin: 0 0 0.75rem; }
.new, .bridge { border: 1px solid #8884; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
.new summary { cursor: pointer; font-weight: 600; }
.new .row { margin-top: 0.6rem; }
.bridge.detached { border-color: #d24b3e88; }
.bridge > header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 0.5rem; }
.device { border: 1px solid #8883; border-radius: 6px; padding: 0.6rem 0.75rem; margin: 0.6rem 0 0 0.75rem; cursor: pointer; }
.device.target { border-color: #2e7fc0; box-shadow: 0 0 0 1px #2e7fc0; }
.device > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
.device table, .device input, .device select, .device button, .device details { cursor: auto; }
.tgt { font-size: 0.75rem; color: #2e7fc0; margin-left: 0.5rem; }
.chev { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 0.3rem 0 0; font-size: 0.9rem; opacity: 0.7; }
.chev:hover { opacity: 1; }
.sum { display: block; font-size: 0.75rem; opacity: 0.6; margin-left: 1.25rem; }
.sum .bad { opacity: 1; }
.add-device { margin-top: 0.75rem; margin-left: 0.75rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.3rem; }
label > span { display: inline-flex; align-items: center; white-space: nowrap; }
input, select { padding: 0.3rem 0.4rem; }
input[type='number'] { width: 4.5rem; }
fieldset { margin-top: 0.6rem; border: 1px solid #8883; border-radius: 4px; display: flex; gap: 1rem; flex-wrap: wrap; }
legend { font-size: 0.8rem; opacity: 0.7; }
small { display: block; opacity: 0.65; }
.controls { display: flex; align-items: center; gap: 0.75rem; }
.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; background: #d24b3e; color: #fff; border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; }
.both { align-self: center; font-size: 1.2rem; opacity: 0.6; padding-bottom: 0.2rem; }
.dir { opacity: 0.75; white-space: nowrap; }
.share { display: flex; flex-wrap: wrap; gap: 0 0.6rem; margin-top: 0.15rem; }
.share label.check { font-size: 0.75rem; }
.role { font-size: 0.8rem; opacity: 0.8; margin-top: 0.1rem; }
.pass { display: block; font-size: 0.75rem; color: #2e7fc0; margin-top: 0.1rem; }
.orig { display: block; font-size: 0.75rem; opacity: 0.55; margin-top: 0.1rem; }
.actions { display: flex; gap: 0.3rem; justify-content: flex-end; }
table.copies { margin-top: 0.5rem; }
.empty { font-size: 0.85rem; opacity: 0.65; }
.add { margin-top: 0.5rem; font-size: 0.85rem; }
.add summary { cursor: pointer; opacity: 0.75; }
.add .row { margin-top: 0.4rem; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; }
.muted { opacity: 0.5; }
.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem; max-width: min(36rem, calc(100vw - 2rem)); z-index: 50; }
.toast { margin: 0; padding: 0.6rem 0.85rem; border-radius: 6px; background: Canvas; color: CanvasText; border: 1px solid #8886; box-shadow: 0 4px 16px #0003; font-size: 0.9rem; }
.toast.bad { border-color: #d24b3e; color: #d24b3e; cursor: pointer; }
.toast.notice { border-color: #2e9e4f; }
</style>
