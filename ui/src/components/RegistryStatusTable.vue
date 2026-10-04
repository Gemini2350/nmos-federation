<script setup lang="ts">
import { api, type RegistryStatus } from '../api';

import { ref } from 'vue';

const props = defineProps<{ registries: RegistryStatus[]; showTest?: boolean }>();
const emit = defineEmits<{ probed: [] }>();

/** Per-registry result of the last Test, so the button is never a no-op on screen. */
const probeResult = ref<Record<string, { ok: boolean; text: string }>>({});
const testing = ref<string | null>(null);

const LABEL: Record<RegistryStatus['state'], string> = {
  ok: 'ok',
  degraded: 'degraded',
  down: 'unreachable',
  unknown: 'not contacted yet',
  disabled: 'disabled',
};

/** "1 node, 2 devices, 1 sender" — what this registry actually holds of ours. */
function breakdown(r: RegistryStatus): string {
  const parts: string[] = [];
  for (const [key, n] of Object.entries(r.resources)) {
    if (key === 'total' || !n) continue;
    parts.push(`${n} ${key}${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ') || 'nothing registered';
}

function heartbeat(r: RegistryStatus): string {
  if (r.state === 'disabled') return '—';
  if (r.heartbeat.ageSeconds === null) return r.heartbeat.failures ? `${r.heartbeat.failures} failed` : 'never';
  const age = r.heartbeat.ageSeconds < 1 ? 'just now' : `${r.heartbeat.ageSeconds} s ago`;
  return r.heartbeat.failures ? `${age} · ${r.heartbeat.failures} failed since` : age;
}

async function test(r: RegistryStatus) {
  testing.value = r.id;
  try {
    const res = await api.probeRegistry(r.id);
    probeResult.value[r.id] = res.reachable
      ? { ok: true, text: `reachable${res.status ? ` (HTTP ${res.status})` : ''}` }
      : { ok: false, text: res.error ?? 'unreachable' };
  } catch (e) {
    // Swallowing this is what made the Test button look like it did nothing at all.
    probeResult.value[r.id] = { ok: false, text: (e as Error).message };
  } finally {
    testing.value = null;
  }
  emit('probed');
}
</script>

<template>
  <table class="registries">
    <colgroup>
      <col style="width: 18%" /><col style="width: 8%" /><col style="width: 22%" /><col style="width: 11%" />
      <col style="width: 11%" /><col style="width: 13%" /><col /><col v-if="props.showTest" style="width: 8%" />
    </colgroup>
    <thead>
      <tr>
        <th>Registry</th><th>Domain</th><th>Address</th><th>Status</th>
        <th>Resources</th><th>Heartbeat</th><th>Error</th><th v-if="props.showTest"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in props.registries" :key="r.id">
        <td>
          <strong>{{ r.label }}</strong>
          <small>{{ r.id }} · {{ r.mode }} · {{ r.version }}</small>
        </td>
        <td>{{ r.domainId }}</td>
        <td><code v-if="r.url">{{ r.url }}</code><small v-else>not resolved</small></td>
        <td><span class="dot" :class="r.state"></span>{{ LABEL[r.state] }}</td>
        <td :title="breakdown(r)">{{ r.resources.total }}</td>
        <td>{{ heartbeat(r) }}</td>
        <td class="err">{{ r.error || '' }}</td>
        <td v-if="props.showTest" class="test">
          <button :disabled="testing === r.id" @click="test(r)">{{ testing === r.id ? '…' : 'Test' }}</button>
          <small v-if="probeResult[r.id]" :class="probeResult[r.id]!.ok ? 'ok' : 'bad'">{{ probeResult[r.id]!.text }}</small>
        </td>
      </tr>
      <tr v-if="!props.registries.length">
        <td :colspan="props.showTest ? 8 : 7"><small>No registries configured.</small></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
/* Fixed, so a status flipping between "never" and "12 s ago · 3 failed since" does not
   resize the columns under the operator's eyes. */
.registries { table-layout: fixed; }
.registries td small { display: block; opacity: 0.6; }
.registries td { overflow-wrap: anywhere; }
.registries th { white-space: nowrap; }
.registries code { font-size: 0.8rem; }
.dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.45rem; vertical-align: middle; }
.dot.ok { background: #2e9e4f; }
.dot.degraded { background: #c08a2e; }
.dot.down { background: #d24b3e; }
.dot.unknown { background: #8888; }
.dot.disabled { background: #8884; }
.err { color: #d24b3e; max-width: 22rem; }
.test small { display: block; white-space: nowrap; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
</style>
