<script setup>
// Row actions: Save/Edit (always), Re-detect (optional here — the table shows it inline in the
// type line instead), Forget (saved devices only). Never hover-only (PLAN.md §11).
import Icon from '../ui/Icon.vue';
import RedetectButton from './RedetectButton.vue';

defineProps({
  device: { type: Object, required: true },
  /** 'compact' = icon-only Forget (table) | 'full' = labelled buttons (mobile card). */
  variant: { type: String, default: 'compact' },
  showRedetect: { type: Boolean, default: false }
});
const emit = defineEmits(['edit', 'forget', 'refingerprint']);
</script>

<template>
  <div class="flex items-center justify-end gap-1" @click.stop>
    <RedetectButton
      v-if="showRedetect"
      :device="device"
      :variant="variant === 'full' ? 'labelled' : 'mini'"
      @refingerprint="emit('refingerprint', device)"
    />

    <button
      v-if="device.saved"
      type="button"
      data-testid="forget-device-btn"
      :class="
        variant === 'full'
          ? 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted ring-1 ring-border-strong ring-inset transition-colors hover:bg-danger/10 hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          : 'inline-grid size-8 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-danger/10 hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
      "
      title="Forget this saved device"
      @click="emit('forget', device)"
    >
      <Icon name="trash" :size="15" />
      <span :class="variant === 'full' ? '' : 'sr-only'">Forget</span>
    </button>

    <button
      type="button"
      data-testid="save-device-btn"
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      :class="
        device.saved
          ? 'text-text ring-1 ring-border-strong ring-inset hover:bg-surface-3'
          : 'text-accent-fg ring-1 ring-accent/45 ring-inset hover:bg-accent/10'
      "
      :title="device.saved ? 'Edit name, type and notes' : 'Save this device to name it and know when it goes offline'"
      @click="emit('edit', device)"
    >
      <Icon :name="device.saved ? 'edit' : 'star'" :size="14" class="shrink-0" />
      <span>{{ device.saved ? 'Edit' : 'Save' }}</span>
    </button>
  </div>
</template>
