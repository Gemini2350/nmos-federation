<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api, type Channel, type Status } from '../api';
import RegistryStatusTable from '../components/RegistryStatusTable.vue';

const channels = ref<Channel[]>([]);
const status = ref<Status | null>(null);
const error = ref<string | null>(null);
let ws: WebSocket | null = null;
let poll: number | null = null;

async function refresh() {
  try {
    [channels.value, status.value] = await Promise.all([api.channels(), api.status()]);
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(async () => {
  await refresh();
  // Live updates; the poll is only the safety net underneath.
  ws = api.events();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.type === 'hello') channels.value = msg.channels;
    if (msg.type === 'channel' || msg.type === 'registry') void refresh();
  };
  poll = window.setInterval(refresh, 10_000);
});
onUnmounted(() => {
  ws?.close();
  if (poll) clearInterval(poll);
});

const badge = (state: string) => (state === 'active' ? 'ok' : state === 'failed' ? 'bad' : 'busy');
</script>

<template>
  <div class="head">
    <h2>Channels</h2>
    <button @click="api.reconcile().then(refresh)">Reconcile now</button>
  </div>
  <p v-if="error" class="bad">{{ error }}</p>

  <section v-if="status" class="cards">
    <div class="card" v-if="!status.nat.enabled">
      <h3>NAT</h3>
      <span class="warn">globally off — SDPs are copied verbatim</span>
    </div>
    <div class="card" v-for="(sw, fabric) in status.switches" :key="fabric">
      <h3>Switch {{ fabric }}</h3>
      <span :class="sw.reachable ? 'ok' : 'bad'">{{ sw.reachable ? sw.version || 'reachable' : sw.error || 'unreachable' }}</span>
    </div>
    <div class="card" v-for="(pool, domainId) in status.pools" :key="domainId">
      <h3>Pool {{ domainId }}</h3>
      <span>{{ pool.free }} / {{ pool.total }} pairs free</span>
    </div>
  </section>

  <section v-if="status" class="registries">
    <h3>Registries</h3>
    <RegistryStatusTable :registries="status.registries" show-test @probed="refresh" />
  </section>

  <h3 v-if="status">Channels</h3>
  <table v-if="channels.length">
    <thead>
      <tr>
        <th>State</th><th>Direction</th><th>Source</th><th>Federation addresses</th>
        <th>NAT group</th><th>Registries</th><th>Error</th><th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="c in channels" :key="c.id">
        <td><span :class="badge(c.state)">{{ c.state }}</span></td>
        <td>{{ c.sourceDomain }} → {{ c.targetDomain }}</td>
        <td>
          <div v-for="leg in c.legs" :key="leg.fabric">
            <span :class="leg.fabric">{{ leg.fabric }}</span> {{ leg.group }}:{{ leg.port }}
            <small v-if="leg.source">from {{ leg.source }}</small>
          </div>
        </td>
        <td>
          <template v-if="c.allocation">
            <div><span class="red">red</span> {{ c.allocation.groups.red }}</div>
            <div><span class="blue">blue</span> {{ c.allocation.groups.blue }}</div>
          </template>
          <small v-else>NAT off — SDP copied verbatim</small>
        </td>
        <td>{{ c.allocation?.natGroupId ?? '—' }}</td>
        <td>{{ c.publishedIn.join(', ') || '—' }}</td>
        <td class="bad">{{ c.error || '' }}</td>
        <td class="actions">
          <button v-if="c.state === 'failed'" @click="api.retryChannel(c.receiverId).then(refresh).catch(e => error = e.message)">Retry</button>
          <button @click="api.dropChannel(c.receiverId).then(refresh)">Tear down</button>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else>No federation active. Use your controller to connect a source to a virtual receiver.</p>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
.cards { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0 1.5rem; }
.card { border: 1px solid #8884; border-radius: 6px; padding: 0.6rem 0.9rem; min-width: 11rem; }
.card h3 { margin: 0 0 0.3rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
.card small { display: block; opacity: 0.6; }
.ok { color: #2e9e4f; }
.bad { color: #d24b3e; }
.busy { color: #c08a2e; }
.warn { color: #c08a2e; }
.red { color: #d24b3e; font-weight: 600; }
.blue { color: #3a78c9; font-weight: 600; }
.actions { display: flex; gap: 0.4rem; }
.registries { margin-bottom: 2rem; }
.registries h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
small { opacity: 0.65; }
</style>
