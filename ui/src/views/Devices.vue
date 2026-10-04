<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Config, type Device, type VirtualReceiver } from '../api';

const cfg = ref<Config | null>(null);
const devices = ref<Device[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const draft = ref({ label: 'Federation OUT', sourceDomain: '', targetDomain: '', targetRegistries: [] as string[], nat: true });
const rxDraft = ref<Record<string, { count: number; pattern: string; format: VirtualReceiver['format'] }>>({});

const domains = computed(() => cfg.value?.domains ?? []);
const natGloballyOff = computed(() => cfg.value?.nat.enabled === false);
const registriesOf = (domainId: string) => (cfg.value?.registries ?? []).filter((r) => r.domainId === domainId);

async function refresh() {
  try {
    [cfg.value, devices.value] = await Promise.all([api.config(), api.devices()]);
    if (!draft.value.sourceDomain) {
      draft.value.sourceDomain = domains.value.find((d) => d.kind === 'internal')?.id ?? '';
      draft.value.targetDomain = domains.value.find((d) => d.kind === 'external')?.id ?? '';
    }
    for (const d of devices.value) {
      rxDraft.value[d.id] ??= { count: 1, pattern: `${d.label} {n}`, format: 'video' };
    }
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/**
 * Toggling NAT invalidates every channel of this device: addresses, switch rules and
 * the published sender were all derived from the old setting. The backend rebuilds
 * them; here we just report what happened.
 */
async function setNat(device: Device, nat: boolean) {
  notice.value = null;
  try {
    const res = await api.updateDevice(device.id, { nat });
    if (res.rebuilt) {
      const failed = res.failed?.length ?? 0;
      notice.value = failed
        ? `${res.rebuilt} channel(s) rebuilt, ${failed} failed: ${res.failed!.map((f) => f.error).join('; ')}`
        : `${res.rebuilt} channel(s) rebuilt with NAT ${nat ? 'on' : 'off'}.`;
    }
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <h2>Devices</h2>
  <p v-if="error" class="bad">{{ error }}</p>
  <p v-if="notice" class="notice">{{ notice }}</p>
  <p v-if="natGloballyOff" class="warn">
    NAT is switched off globally in the settings — per-device NAT has no effect until you enable it there.
  </p>

  <section class="new">
    <h3>New device</h3>
    <div class="row">
      <label>Name <input v-model="draft.label" /></label>
      <label>Source domain
        <select v-model="draft.sourceDomain">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }} ({{ d.id }})</option>
        </select>
      </label>
      <label>Target domain
        <select v-model="draft.targetDomain">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }} ({{ d.id }})</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" v-model="draft.nat" /> NAT</label>
      <button @click="run(() => api.createDevice(draft))">Create</button>
    </div>
    <fieldset v-if="registriesOf(draft.targetDomain).length">
      <legend>Target registries (no selection = all enabled ones of the domain)</legend>
      <label v-for="r in registriesOf(draft.targetDomain)" :key="r.id" class="check">
        <input type="checkbox" :value="r.id" v-model="draft.targetRegistries" /> {{ r.label }}
      </label>
    </fieldset>
    <p class="hint">
      Fanning out into two separate networks needs two devices — that is two NAT translations.
      Several registries in the same network are just a multiple registration of the same sender.
    </p>
  </section>

  <article v-for="d in devices" :key="d.id" :class="['device', { detached: d.detached }]">
    <header>
      <div>
        <strong>{{ d.label }}</strong>
        <span v-if="d.detached" class="badge">detached</span>
        <small>{{ d.sourceDomain }} → {{ d.targetDomain }} ·
          {{ d.targetRegistries.length ? d.targetRegistries.join(', ') : 'all registries of the target domain' }}</small>
        <small v-if="d.detached" class="bad">
          Points at
          {{ [d.missing?.sourceDomain, d.missing?.targetDomain].filter(Boolean).join(' and ') }}, which
          {{ d.missing?.sourceDomain && d.missing?.targetDomain ? 'do' : 'does' }} not exist — this device registers nothing.
          Recreate that domain under Settings, or change the device, or delete it.
        </small>
        <small v-else-if="d.missing?.registries.length" class="warn">
          Unknown target registries ignored: {{ d.missing.registries.join(', ') }}
        </small>
      </div>
      <div class="controls">
        <label class="check" :title="natGloballyOff ? 'NAT is off globally' : 'Rebuilds this device\'s channels'">
          <input type="checkbox" :checked="d.nat" @change="setNat(d, ($event.target as HTMLInputElement).checked)" />
          NAT
        </label>
        <button @click="run(() => api.deleteDevice(d.id))">Delete device</button>
      </div>
    </header>

    <table v-if="d.receivers?.length">
      <thead><tr><th>Virtual receiver</th><th>Format</th><th>Enabled</th><th></th></tr></thead>
      <tbody>
        <tr v-for="vrx in d.receivers" :key="vrx.id">
          <td>{{ vrx.label }}</td>
          <td>{{ vrx.format }}</td>
          <td>{{ vrx.enabled ? 'yes' : 'no' }}</td>
          <td><button @click="run(() => api.deleteReceiver(vrx.id))">Remove</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else><small>No virtual receivers yet.</small></p>

    <div class="row" v-if="rxDraft[d.id]">
      <label>Count <input type="number" min="1" max="256" v-model.number="rxDraft[d.id]!.count" /></label>
      <label>Name pattern <input v-model="rxDraft[d.id]!.pattern" /></label>
      <label>Format
        <select v-model="rxDraft[d.id]!.format">
          <option value="video">video</option><option value="audio">audio</option><option value="data">data</option>
        </select>
      </label>
      <button @click="run(() => api.addReceivers(d.id, rxDraft[d.id]!))">Create receivers</button>
    </div>
  </article>
</template>

<style scoped>
.new, .device { border: 1px solid #8884; border-radius: 6px; padding: 1rem; margin-bottom: 1.25rem; }
.device.detached { border-color: #d24b3e88; }
.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; background: #d24b3e; color: #fff; border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; }
.new h3 { margin-top: 0; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.35rem; }
input, select { padding: 0.3rem 0.4rem; }
input[type='number'] { width: 5rem; }
fieldset { margin-top: 0.75rem; border: 1px solid #8883; border-radius: 4px; display: flex; gap: 1rem; flex-wrap: wrap; }
legend { font-size: 0.8rem; opacity: 0.7; }
.device header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; gap: 1rem; }
.device small { display: block; opacity: 0.65; }
.controls { display: flex; align-items: center; gap: 0.75rem; }
.hint { font-size: 0.8rem; opacity: 0.7; margin-bottom: 0; }
.bad { color: #d24b3e; }
.warn { color: #c08a2e; }
.notice { color: #2e9e4f; }
</style>
