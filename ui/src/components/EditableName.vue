<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * A name that is edited where it is shown. Saves on Enter or when the field loses
 * focus, Escape restores. An empty name falls back to `fallback` when one is given
 * (a bridge without a name is "NMOS Federation"), otherwise it is refused.
 *
 * Tab and Shift+Tab move to the next or previous name on the page, skipping the
 * buttons in between, with the text selected — renaming a column of receivers is
 * type, Tab, type, Tab. Leaving the field saves it as usual.
 */
const props = defineProps<{ value: string; fallback?: string; disabled?: boolean }>();
const emit = defineEmits<{ save: [label: string] }>();

const text = ref(props.value);
watch(() => props.value, (v) => (text.value = v));

// Enter and Escape only end editing; saving happens once, on blur. Saving on Enter
// as well would send the rename twice, since the blur that follows sees the old prop.
function commit() {
  const next = text.value.trim() || props.fallback || '';
  if (!next) {
    text.value = props.value;
    return;
  }
  text.value = next;
  if (next !== props.value) emit('save', next);
}

function step(e: KeyboardEvent) {
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input.name:not(:disabled)'));
  const here = fields.indexOf(e.target as HTMLInputElement);
  const next = fields[here + (e.shiftKey ? -1 : 1)];
  if (here < 0 || !next) return; // the last one: let the browser move on as usual
  e.preventDefault();
  next.focus();
  next.select();
}

function cancel(e: Event) {
  text.value = props.value;
  (e.target as HTMLInputElement).blur();
}
</script>

<template>
  <input
    class="name"
    v-model="text"
    :disabled="disabled"
    :size="Math.max(text.length, 6)"
    title="Click to rename · Tab: next name"
    @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
    @keydown.esc.prevent="cancel"
    @keydown.tab="step"
    @blur="commit"
  />
</template>

<style scoped>
.name {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 0.05rem 0.25rem;
  margin-left: -0.3rem;
  max-width: 100%;
}
.name:hover:not(:disabled) { border-color: #8886; }
.name:focus { border-color: #4a8ad4; outline: none; background: #8881; }
</style>
