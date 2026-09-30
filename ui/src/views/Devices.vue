<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Config, type Device, type VirtualReceiver } from '../api';

const cfg = ref<Config | null>(null);
const devices = ref<Device[]>([]);
const error = ref<string | null>(null);

const draft = ref({ label: 'Federation OUT', sourceDomain: '', targetDomain: '', targetRegistries: [] as string[], nat: true });
const rxDraft = ref<Record<string, { count: number; pattern: string; format: VirtualReceiver['format'] }>>({});

const domains = computed(() => cfg.value?.domains ?? []);
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

onMounted(refresh);
</script>

<template>
  <h2>Devices</h2>
  <p v-if="error" class="bad">{{ error }}</p>

  <section class="new">
    <h3>Neues Device</h3>
    <div class="row">
      <label>Name <input v-model="draft.label" /></label>
      <label>Quell-Domäne
        <select v-model="draft.sourceDomain">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }} ({{ d.id }})</option>
        </select>
      </label>
      <label>Ziel-Domäne
        <select v-model="draft.targetDomain">
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.label }} ({{ d.id }})</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" v-model="draft.nat" /> NAT</label>
      <button @click="run(() => api.createDevice(draft))">Anlegen</button>
    </div>
    <fieldset v-if="registriesOf(draft.targetDomain).length">
      <legend>Ziel-Registries (keine Auswahl = alle aktiven der Domäne)</legend>
      <label v-for="r in registriesOf(draft.targetDomain)" :key="r.id" class="check">
        <input type="checkbox" :value="r.id" v-model="draft.targetRegistries" /> {{ r.label }}
      </label>
    </fieldset>
    <p class="hint">
      Fan-out in zwei getrennte Netze braucht zwei Devices — das sind zwei NAT-Übersetzungen.
      Mehrere Registries im selben Netz sind dagegen nur eine Mehrfachregistrierung.
    </p>
  </section>

  <article v-for="d in devices" :key="d.id" class="device">
    <header>
      <div>
        <strong>{{ d.label }}</strong>
        <small>{{ d.sourceDomain }} → {{ d.targetDomain }} · {{ d.nat ? 'NAT' : 'ohne NAT' }} ·
          {{ d.targetRegistries.length ? d.targetRegistries.join(', ') : 'alle Registries der Ziel-Domäne' }}</small>
      </div>
      <button @click="run(() => api.deleteDevice(d.id))">Device löschen</button>
    </header>

    <table v-if="d.receivers?.length">
      <thead><tr><th>Virtueller Receiver</th><th>Format</th><th>Aktiv</th><th></th></tr></thead>
      <tbody>
        <tr v-for="vrx in d.receivers" :key="vrx.id">
          <td>{{ vrx.label }}</td>
          <td>{{ vrx.format }}</td>
          <td>{{ vrx.enabled ? 'ja' : 'nein' }}</td>
          <td><button @click="run(() => api.deleteReceiver(vrx.id))">Entfernen</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else><small>Noch keine virtuellen Receiver.</small></p>

    <div class="row" v-if="rxDraft[d.id]">
      <label>Anzahl <input type="number" min="1" max="256" v-model.number="rxDraft[d.id]!.count" /></label>
      <label>Namensmuster <input v-model="rxDraft[d.id]!.pattern" /></label>
      <label>Format
        <select v-model="rxDraft[d.id]!.format">
          <option value="video">video</option><option value="audio">audio</option><option value="data">data</option>
        </select>
      </label>
      <button @click="run(() => api.addReceivers(d.id, rxDraft[d.id]!))">Receiver anlegen</button>
    </div>
  </article>
</template>

<style scoped>
.new, .device { border: 1px solid #8884; border-radius: 6px; padding: 1rem; margin-bottom: 1.25rem; }
.new h3 { margin-top: 0; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
label.check { flex-direction: row; align-items: center; gap: 0.35rem; }
input, select { padding: 0.3rem 0.4rem; }
input[type='number'] { width: 5rem; }
fieldset { margin-top: 0.75rem; border: 1px solid #8883; border-radius: 4px; display: flex; gap: 1rem; flex-wrap: wrap; }
legend { font-size: 0.8rem; opacity: 0.7; }
.device header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }
.device small { display: block; opacity: 0.65; }
.hint { font-size: 0.8rem; opacity: 0.7; margin-bottom: 0; }
.bad { color: #d24b3e; }
</style>
