<script setup>
// Confirmation dialog (PLAN §8.6, DESIGN §4.2). Cancel gets initial focus (safest choice).
import Modal from './Modal.vue';
import Button from './Button.vue';

defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  cancelLabel: { type: String, default: 'Cancel' },
  danger: { type: Boolean, default: false },
  confirmTestid: { type: String, default: undefined },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['confirm', 'cancel']);
</script>

<template>
  <Modal
    :open="open"
    :title="title"
    width="sm"
    role="alertdialog"
    :sheet="false"
    initial-focus="[data-confirm-cancel]"
    @close="emit('cancel')"
  >
    <p v-if="message" class="text-[13px] leading-5 text-muted">{{ message }}</p>
    <slot />
    <template #footer>
      <Button variant="secondary" data-confirm-cancel @click="emit('cancel')">{{ cancelLabel }}</Button>
      <Button
        :variant="danger ? 'danger' : 'primary'"
        :loading="loading"
        :data-testid="confirmTestid"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </Button>
    </template>
  </Modal>
</template>
