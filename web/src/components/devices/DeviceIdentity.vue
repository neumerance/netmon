<script setup>
// Type icon tile + display name + badges (This device / Gateway / Saved / New).
// Used by both the table row and the mobile card.
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { deviceDisplayName, deviceIcon, deviceTypeLabel } from '../../lib/deviceTypes.js';
import { useNow } from '../../composables/useNow.js';
import { OFFLINE_TILE, categoryTint } from './deviceUi.js';
import { isNewDevice } from './devicesState.js';

const props = defineProps({
  device: { type: Object, required: true },
  size: { type: String, default: 'md' }, // 'md' 32px tile (table) | 'lg' 36px tile (card)
  openable: { type: Boolean, default: false } // name is a button that emits 'open' (detail panel)
});
const emit = defineEmits(['open']);

const now = useNow(1000);

const name = computed(() => deviceDisplayName(props.device));
const tileClass = computed(() => (props.device.online ? categoryTint(props.device.category).tile : OFFLINE_TILE));
const isNew = computed(() => isNewDevice(props.device, now.value));

/** Tooltip on the name: everything that identifies the device, one fact per line. */
const nameTitle = computed(() => {
  const d = props.device;
  const lines = [name.value];
  if (d.hostname && d.hostname !== name.value) lines.push(`Hostname: ${d.hostname}`);
  lines.push(`Type: ${deviceTypeLabel(d)}`);
  if (d.vendor) lines.push(`Vendor: ${d.vendor}`);
  if (d.ip) lines.push(`IP: ${d.ip}`);
  if (d.mac) lines.push(`MAC: ${d.mac}`);
  if (d.notes) lines.push(`Notes: ${d.notes}`);
  return lines.join('\n');
});
</script>

<template>
  <div class="flex min-w-0 items-center gap-3">
    <span
      class="relative grid shrink-0 place-items-center rounded-lg transition-colors duration-300"
      :class="[size === 'lg' ? 'size-9' : 'size-8', tileClass]"
      data-testid="device-type-icon"
      :title="device.typeSource === 'user' ? 'Type set by you' : undefined"
    >
      <Icon :name="deviceIcon(device)" :size="18" />
      <span
        v-if="device.typeSource === 'user'"
        class="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full border border-border bg-surface text-muted"
        aria-hidden="true"
      >
        <Icon name="edit" :size="8" />
      </span>
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <button
          v-if="openable"
          type="button"
          data-testid="device-name"
          class="min-w-0 truncate rounded-sm text-left text-[13px] font-medium text-text decoration-border-strong decoration-dotted underline-offset-4 hover:underline"
          :title="nameTitle + '\n\nClick for details'"
          :aria-label="`${name} — show details`"
          @click.stop="emit('open', device)"
        >{{ name }}</button>
        <span
          v-else
          data-testid="device-name"
          class="min-w-0 truncate text-[13px] font-medium text-text"
          :title="nameTitle"
        >{{ name }}</span>
        <Icon
          v-if="device.saved"
          name="star-filled"
          :size="12"
          class="shrink-0 text-warning"
          aria-hidden="false"
          role="img"
          aria-label="Saved"
          title="Saved"
        />
        <span
          v-if="device.isSelf"
          data-testid="self-badge"
          class="inline-flex h-[18px] shrink-0 items-center rounded-md bg-accent/12 px-1.5 text-[11px] font-medium text-accent-fg ring-1 ring-inset ring-accent/25"
        >This device</span>
        <span
          v-if="device.isGateway"
          data-testid="gateway-badge"
          class="inline-flex h-[18px] shrink-0 items-center rounded-md bg-cat-network/12 px-1.5 text-[11px] font-medium text-cat-network ring-1 ring-inset ring-cat-network/25"
        >Gateway</span>
        <span
          v-if="isNew"
          data-testid="new-badge"
          class="inline-flex h-[18px] shrink-0 items-center rounded-md bg-info/12 px-1.5 text-[11px] font-medium text-info-fg ring-1 ring-inset ring-info/25"
        >New</span>
      </div>
      <slot />
    </div>
  </div>
</template>
