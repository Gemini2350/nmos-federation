<script
  setup
  lang="ts"
  generic="T extends { id: string; label: string; nodeId: string | null; nodeLabel: string | null; device_id: string; deviceLabel: string; ours: boolean }"
>
import { computed, reactive } from 'vue';

/**
 * A registry's senders or receivers, grouped node → device and collapsible.
 *
 * A flat list stopped being usable at a real central registry: 148 senders, 389
 * receivers. Grouping follows how people think about the plant — a node is a box, a
 * device a card or function in it — and every level can be ticked as a whole.
 *
 * Nodes start collapsed, devices open, so a registry first reads as a list of boxes.
 * While a search is active everything that matches is shown open, since hiding a hit
 * behind a closed group would make the search look broken.
 */
const props = defineProps<{
  rows: T[];
  /** Ids ticked for copying. Owned by the parent; changes go out through `toggle`. */
  selected: Set<string>;
  copyable: (row: T) => boolean;
  /** A search is active: show every group open. */
  searching: boolean;
  busy: boolean;
  /** Singular noun for counts, e.g. "sender". */
  noun: string;
  /** Classes for the extra columns between name and state, for fixed widths. */
  colClasses: string[];
}>();
const emit = defineEmits<{ toggle: [ids: string[], on: boolean] }>();
defineSlots<{
  head(): unknown;
  cells(props: { row: T }): unknown;
  status(props: { row: T }): unknown;
}>();

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byLabel = (a: { label: string }, b: { label: string }) => collator.compare(a.label, b.label);

interface DeviceGroup {
  key: string;
  label: string;
  rows: T[];
}
interface NodeGroup {
  key: string;
  label: string;
  ours: boolean;
  devices: DeviceGroup[];
  rows: T[];
}

const groups = computed<NodeGroup[]>(() => {
  const nodes = new Map<string, NodeGroup & { byDevice: Map<string, DeviceGroup> }>();
  for (const row of props.rows) {
    const nodeKey = row.nodeId ?? '—';
    let node = nodes.get(nodeKey);
    if (!node) {
      node = { key: nodeKey, label: row.nodeLabel ?? 'Unknown node', ours: row.ours, devices: [], rows: [], byDevice: new Map() };
      nodes.set(nodeKey, node);
    }
    let device = node.byDevice.get(row.device_id);
    if (!device) {
      device = { key: row.device_id, label: row.deviceLabel, rows: [] };
      node.byDevice.set(row.device_id, device);
    }
    device.rows.push(row);
    node.rows.push(row);
  }
  return [...nodes.values()]
    .map(({ byDevice, ...node }) => ({
      ...node,
      devices: [...byDevice.values()].map((d) => ({ ...d, rows: d.rows.sort(byLabel) })).sort(byLabel),
    }))
    .sort(byLabel);
});

const openNodes = reactive(new Set<string>());
const closedDevices = reactive(new Set<string>());
const nodeOpen = (key: string) => props.searching || openNodes.has(key);
const deviceOpen = (key: string) => props.searching || !closedDevices.has(key);
function flip(set: Set<string>, key: string) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}
function expandAll(open: boolean) {
  openNodes.clear();
  closedDevices.clear();
  if (open) for (const g of groups.value) openNodes.add(g.key);
}
defineExpose({ expandAll });

/** Tick state of a group: every copyable row ticked, some, or none. */
function tickState(rows: T[]) {
  const ids = rows.filter(props.copyable).map((r) => r.id);
  const on = ids.filter((id) => props.selected.has(id)).length;
  return { ids, all: ids.length > 0 && on === ids.length, some: on > 0 && on < ids.length };
}

const summary = (rows: T[]) => `${rows.length} ${props.noun}${rows.length === 1 ? '' : 's'}`;

/** Columns right of the checkbox: name, the extra ones, state. */
const span = computed(() => props.colClasses.length + 2);
</script>

<template>
  <table class="pick grouped">
    <colgroup>
      <col class="c-check" />
      <col />
      <col v-for="c in colClasses" :key="c" :class="c" />
      <col class="c-state" />
    </colgroup>
    <thead>
      <tr>
        <th>
          <input
            type="checkbox"
            :checked="tickState(rows).all"
            :indeterminate="tickState(rows).some"
            :disabled="busy || !tickState(rows).ids.length"
            title="every one that can be copied"
            @change="emit('toggle', tickState(rows).ids, ($event.target as HTMLInputElement).checked)"
          />
        </th>
        <th>Name</th>
        <slot name="head" />
        <th></th>
      </tr>
    </thead>
    <tbody v-if="!groups.length">
      <tr><td></td><td :colspan="span" class="empty">{{ searching ? 'Nothing matches the search.' : `No ${noun}s in this registry.` }}</td></tr>
    </tbody>
    <tbody v-for="g in groups" :key="g.key">
      <tr class="node" :class="{ open: nodeOpen(g.key) }" @click="searching || flip(openNodes, g.key)">
        <td @click.stop>
          <input
            type="checkbox"
            :checked="tickState(g.rows).all"
            :indeterminate="tickState(g.rows).some"
            :disabled="busy || !tickState(g.rows).ids.length"
            :title="`every ${noun} of this node that can be copied`"
            @change="emit('toggle', tickState(g.rows).ids, ($event.target as HTMLInputElement).checked)"
          />
        </td>
        <td :colspan="span">
          <span class="chev" :class="{ hidden: searching }">{{ nodeOpen(g.key) ? '▾' : '▸' }}</span>
          <strong>{{ g.label }}</strong>
          <small class="meta">
            {{ g.devices.length }} device{{ g.devices.length === 1 ? '' : 's' }} · {{ summary(g.rows) }}
            <template v-if="tickState(g.rows).ids.filter((id) => selected.has(id)).length">
              · {{ tickState(g.rows).ids.filter((id) => selected.has(id)).length }} ticked
            </template>
            <template v-if="g.ours"> · one of ours</template>
          </small>
        </td>
      </tr>
      <template v-if="nodeOpen(g.key)">
        <template v-for="d in g.devices" :key="d.key">
          <tr class="device" @click="searching || flip(closedDevices, d.key)">
            <td @click.stop>
              <input
                type="checkbox"
                :checked="tickState(d.rows).all"
                :indeterminate="tickState(d.rows).some"
                :disabled="busy || !tickState(d.rows).ids.length"
                :title="`every ${noun} of this device that can be copied`"
                @change="emit('toggle', tickState(d.rows).ids, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td :colspan="span">
              <span class="chev" :class="{ hidden: searching }">{{ deviceOpen(d.key) ? '▾' : '▸' }}</span>
              {{ d.label }} <small class="meta">{{ summary(d.rows) }}</small>
            </td>
          </tr>
          <template v-if="deviceOpen(d.key)">
            <tr v-for="row in d.rows" :key="row.id" class="item" :class="{ ticked: selected.has(row.id) }">
              <td>
                <!-- A row that cannot be ticked keeps an invisible box, so it is exactly as
                     tall as one that can and marking a row copied moves nothing below it. -->
                <input
                  v-if="copyable(row)"
                  type="checkbox"
                  :disabled="busy"
                  :checked="selected.has(row.id)"
                  @change="emit('toggle', [row.id], ($event.target as HTMLInputElement).checked)"
                />
                <input v-else type="checkbox" disabled class="placeholder" aria-hidden="true" tabindex="-1" />
              </td>
              <td class="name">{{ row.label }}</td>
              <slot name="cells" :row="row" />
              <td><slot name="status" :row="row" /></td>
            </tr>
          </template>
        </template>
      </template>
    </tbody>
  </table>
</template>

<style scoped>
/* Fixed columns: ticking a row, opening a group or marking a row copied changes no
   column's width. The extra columns' classes come from the parent through colClasses. */
table.grouped { table-layout: fixed; width: 100%; border-collapse: collapse; }
table.grouped td { overflow-wrap: anywhere; }
.c-check { width: 2.2rem; }
.c-ess { width: 18%; }
.c-cur { width: 22%; }
.c-state { width: 9rem; }
tr.node { cursor: pointer; background: #8881; border-top: 1px solid #8884; }
tr.node:hover, tr.device:hover { background: #8882; }
tr.device { cursor: pointer; }
tr.device > td:nth-child(2) { padding-left: 1.3rem; }
tr.item > td.name { padding-left: 2.6rem; font-weight: 600; }
tr.ticked { background: #4a8ad41a; }
.chev { display: inline-block; width: 1rem; opacity: 0.6; }
.chev.hidden { visibility: hidden; }
.meta { opacity: 0.6; margin-left: 0.4rem; font-size: 0.8rem; }
.placeholder { visibility: hidden; }
.empty { opacity: 0.6; font-style: italic; }
</style>
