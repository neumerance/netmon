<script setup>
// Confirm "forget" for a saved device. Confirm button: data-testid="forget-confirm-btn".
import { computed, ref, watch } from 'vue';
import ConfirmDialog from '../ui/ConfirmDialog.vue';
import { forgetDevice, pushToast } from '../../store.js';
import { deviceDisplayName } from '../../lib/deviceTypes.js';

const props = defineProps({
  device: { type: Object, default: null },
  open: { type: Boolean, default: false }
});
const emit = defineEmits(['close', 'forgotten']);

const pending = ref(false);
watch(
  () => props.open,
  (o) => {
    if (o) pending.value = false;
  }
);

const name = computed(() => (props.device ? deviceDisplayName(props.device) : 'this device'));
const title = computed(() => `Forget “${name.value}”?`);
const message = computed(() =>
  props.device?.online
    ? 'NetMon will stop tracking this device by name and won’t alert you when it goes offline. It stays in the list while it is online, and you can save it again anytime.'
    : 'NetMon will stop tracking this device by name and won’t alert you when it goes offline. Because it is offline right now, it will disappear from the list.'
);

async function confirm() {
  const d = props.device;
  if (!d || pending.value) return;
  const label = name.value; // capture before the device loses its saved name
  pending.value = true;
  try {
    await forgetDevice(d.mac);
    pushToast({ level: 'success', title: `Forgot “${label}”` });
    emit('forgotten', d.mac);
    emit('close');
  } catch {
    // The store already showed an error toast; keep the dialog open so the user can retry.
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <ConfirmDialog
    :open="open && !!device"
    :title="title"
    :message="message"
    confirm-label="Forget device"
    danger
    confirm-testid="forget-confirm-btn"
    :loading="pending"
    data-testid="forget-dialog"
    @confirm="confirm"
    @cancel="emit('close')"
  />
</template>
