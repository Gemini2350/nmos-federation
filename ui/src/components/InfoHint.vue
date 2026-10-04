<script setup lang="ts">
import { nextTick, ref } from 'vue';

/**
 * A small "?" next to a field or column name that reveals its explanation on hover.
 *
 * Focusable on purpose: hover alone leaves the text unreachable by keyboard and on a
 * touch screen, where a tap moves focus instead.
 *
 * Positioned in JavaScript rather than by CSS alone. A fixed `left: 0` under the marker
 * runs off the right edge as soon as the column sits in the right half of the window —
 * which silently cuts the end off the explanation, the one thing a hint must not do.
 */
defineProps<{ text?: string; wide?: boolean }>();

const open = ref(false);
const marker = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({});

const MARGIN = 8;

/**
 * Place it under the marker first, then correct against the rendered box.
 *
 * Guessing the size does not work: padding and border land outside the width that was
 * asked for, and the text wraps to a height nobody can predict. Measuring once after
 * the render is exact, and it is what keeps the end of a sentence from being cut off at
 * the window edge — the one failure a hint cannot afford.
 */
async function show() {
  const el = marker.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  style.value = {
    width: `${Math.min(el.dataset['wide'] === 'true' ? 480 : 352, window.innerWidth - 2 * MARGIN)}px`,
    left: `${r.left}px`,
    top: `${r.bottom + 6}px`,
  };
  open.value = true;

  await nextTick();
  const b = bubble.value?.getBoundingClientRect();
  if (!b) return;
  const left = b.right > window.innerWidth - MARGIN ? Math.max(MARGIN, window.innerWidth - MARGIN - b.width) : b.left;
  // Below the marker if it fits, otherwise above it, and never outside the window.
  const top =
    b.bottom > window.innerHeight - MARGIN
      ? Math.max(MARGIN, Math.min(r.top - 6 - b.height, window.innerHeight - MARGIN - b.height))
      : b.top;
  style.value = { ...style.value, left: `${left}px`, top: `${top}px` };
}
</script>

<template>
  <span
    ref="marker"
    class="info"
    tabindex="0"
    role="note"
    :data-wide="String(!!wide)"
    @mouseenter="show"
    @focus="show"
    @mouseleave="open = false"
    @blur="open = false"
  >
    <span class="q" aria-hidden="true">?</span>
    <Teleport to="body">
      <span v-if="open" ref="bubble" class="bubble" :style="style"><slot>{{ text }}</slot></span>
    </Teleport>
  </span>
</template>

<style scoped>
.info {
  position: relative;
  display: inline-block;
  margin-left: 0.3rem;
  cursor: help;
  outline: none;
  vertical-align: middle;
}
.q {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  opacity: 0.55;
}
.info:hover .q,
.info:focus .q {
  opacity: 1;
}
</style>

<style>
/* Teleported to body, so it cannot be scoped to this component. */
.bubble {
  position: fixed;
  box-sizing: border-box; /* padding and border inside the width we computed */
  z-index: 50;
  max-height: calc(100vh - 16px);
  overflow: auto;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8886;
  border-radius: 6px;
  background: Canvas;
  color: CanvasText;
  box-shadow: 0 6px 20px #0003;
  font-size: 0.8rem;
  font-weight: 400;
  line-height: 1.45;
  text-transform: none;
  letter-spacing: normal;
  white-space: normal;
  text-align: left;
}
.bubble code {
  font-size: 0.95em;
}
</style>
