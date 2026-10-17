<script setup>
// Save / Edit device modal: name (required, 1–64), type override (Auto-detect or a category),
// notes (≤ 500), plus "Re-detect" and (edit mode) "Forget device".
// Testids: device-name-input, device-type-select, device-notes-input, save-confirm-btn.
import { computed, nextTick, ref, watch } from 'vue';
import Modal from '../ui/Modal.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import { pushToast, saveDevice } from '../../store.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  deviceIcon,
  deviceTypeLabel
} from '../../lib/deviceTypes.js';
import { OFFLINE_TILE, categoryTint, confidencePercent } from './deviceUi.js';
import { isRedetecting, redetectDevice } from './devicesState.js';

const NAME_MAX = 64;
const NOTES_MAX = 500;

const props = defineProps({
  device: { type: Object, default: null },
  open: { type: Boolean, default: false },
  /** Focus the type select instead of the name (opened from "Wrong? Change type"). */
  focusType: { type: Boolean, default: false }
});
const emit = defineEmits(['close', 'saved', 'forget']);

const nameEl = ref(null);
const typeEl = ref(null);
const formId = `device-edit-form-${Math.random().toString(36).slice(2, 8)}`;

const name = ref('');
const type = ref('');
const notes = ref('');
const errors = ref({});
const formError = ref('');
const submitting = ref(false);
const touched = ref(false);

const isEdit = computed(() => Boolean(props.device?.saved));
const title = computed(() => (isEdit.value ? 'Edit device' : 'Save device'));

/** Suggested name for an unsaved device: friendly name/hostname, else the type label. */
function suggestedName(d) {
  if (!d) return '';
  if (d.name) return d.name;
  if (d.hostname) return d.hostname;
  if (d.model) return d.model;
  return deviceTypeLabel(d);
}

function resetForm() {
  const d = props.device;
  name.value = suggestedName(d).slice(0, NAME_MAX);
  type.value = d?.userType ?? (d?.typeSource === 'user' ? d?.category ?? '' : '');
  notes.value = d?.notes ?? '';
  errors.value = {};
  formError.value = '';
  submitting.value = false;
  touched.value = false;
}

watch(
  () => [props.open, props.device?.mac],
  async ([open], [wasOpen, prevMac] = []) => {
    if (!open) return;
    // Re-initialise when the modal opens or a different device is shown — never on live updates.
    if (!wasOpen || prevMac !== props.device?.mac) {
      resetForm();
      await nextTick();
      // Modal may move focus itself on open; take it after that.
      setTimeout(() => {
        if (props.focusType) typeEl.value?.focus();
        else {
          nameEl.value?.focus();
          nameEl.value?.select();
        }
      }, 30);
    }
  },
  { immediate: true }
);

/** "Auto-detect" option text shows what auto-detection currently says. */
const autoOptionLabel = computed(() => {
  const d = props.device;
  if (!d) return 'Auto-detect';
  const auto = d.autoCategory ?? (d.typeSource === 'user' ? null : d.category);
  if (!auto) return 'Auto-detect';
  const label = deviceTypeLabel({ ...d, category: auto });
  const pct = confidencePercent(d.typeConfidence);
  return pct > 0 ? `Auto-detect — ${label} (${pct}%)` : `Auto-detect — ${label}`;
});

const categoryOptions = computed(() => CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] ?? id })));

/** Live preview of the label the device will get. */
const previewLabel = computed(() => {
  const d = props.device;
  if (!d) return '';
  if (type.value) return deviceTypeLabel({ ...d, category: type.value });
  return deviceTypeLabel({ ...d, category: d.autoCategory ?? d.category });
});
const previewCategory = computed(() => type.value || props.device?.autoCategory || props.device?.category || 'unknown');
const tileClass = computed(() =>
  props.device?.online ? categoryTint(previewCategory.value).tile : OFFLINE_TILE
);

const trimmedName = computed(() => name.value.trim());
const nameError = computed(() => {
  if (errors.value.name) return errors.value.name;
  if (!touched.value) return '';
  if (!trimmedName.value) return 'Give this device a name.';
  if (trimmedName.value.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  return '';
});
const notesError = computed(() => errors.value.notes || (notes.value.length > NOTES_MAX ? `Notes can be up to ${NOTES_MAX} characters.` : ''));
const valid = computed(
  () => trimmedName.value.length >= 1 && trimmedName.value.length <= NAME_MAX && notes.value.length <= NOTES_MAX
);

const redetecting = computed(() => isRedetecting(props.device?.mac));

async function submit() {
  touched.value = true;
  errors.value = {};
  formError.value = '';
  if (!valid.value || submitting.value || !props.device) {
    if (!trimmedName.value) nameEl.value?.focus();
    return;
  }
  submitting.value = true;
  const payload = { name: trimmedName.value, type: type.value || null, notes: notes.value };
  try {
    const res = await saveDevice(props.device.mac, payload);
    const saved = res && typeof res === 'object' ? res.device ?? (res.mac ? res : null) : null;
    pushToast({ level: 'success', title: `Saved “${payload.name}”`, message: isEdit.value ? '' : "You'll be alerted when it goes offline." });
    emit('saved', saved ?? { ...props.device, ...payload, saved: true });
    emit('close');
  } catch (err) {
    const details = err?.details && typeof err.details === 'object' ? err.details : null;
    if (details && (details.name || details.notes || details.type)) {
      errors.value = {
        name: details.name ? String(details.name) : '',
        notes: details.notes ? String(details.notes) : '',
        type: details.type ? String(details.type) : ''
      };
    } else if (err?.status === 404) {
      formError.value = 'This device is no longer on the network and was never saved.';
    } else {
      formError.value = "Couldn't save. The server didn't respond — try again.";
    }
  } finally {
    submitting.value = false;
  }
}

function onNotesKeydown(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  }
}

function close() {
  if (!submitting.value) emit('close');
}

async function redetect() {
  if (props.device) await redetectDevice(props.device);
}
</script>

<template>
  <Modal
    :open="open && !!device"
    :title="title"
    width="md"
    data-testid="device-edit-modal"
    :initial-focus="focusType ? '[data-testid=device-type-select]' : '[data-testid=device-name-input]'"
    @close="close"
  >
    <form v-if="device" :id="formId" class="space-y-4" novalidate @submit.prevent="submit">
      <p v-if="!isEdit" class="text-[13px] text-muted">
        Saved devices stay listed when they disconnect, so you'll know when they go offline.
      </p>

      <div
        v-if="formError"
        role="alert"
        class="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger-fg"
      >
        <Icon name="alert-triangle" :size="16" class="mt-px shrink-0" />
        <span>{{ formError }}</span>
      </div>

      <!-- Summary -->
      <div class="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="tileClass">
          <Icon :name="deviceIcon({ ...device, category: previewCategory })" :size="18" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-semibold text-text">{{ previewLabel }}</p>
          <p class="truncate text-xs text-muted">
            <span class="tabular-nums">{{ device.ip || '—' }}</span>
            <span aria-hidden="true"> · </span>
            <span class="font-mono text-[11px]">{{ device.mac }}</span>
            <template v-if="device.vendor"><span aria-hidden="true"> · </span>{{ device.vendor }}</template>
          </p>
        </div>
        <button
          type="button"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted ring-1 ring-border-strong ring-inset hover:bg-surface hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="redetecting || !device.online"
          :title="device.online ? 'Run device-type detection again' : 'Device is offline — re-detect needs it online'"
          data-testid="modal-refingerprint-btn"
          @click="redetect"
        >
          <Spinner v-if="redetecting" :size="14" />
          <Icon v-else name="refresh" :size="14" />
          Re-detect
        </button>
      </div>

      <!-- Name -->
      <div>
        <label :for="`${formId}-name`" class="mb-1.5 block text-[13px] font-medium text-text">
          Name <span class="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          :id="`${formId}-name`"
          ref="nameEl"
          v-model="name"
          data-testid="device-name-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :maxlength="NAME_MAX"
          required
          :aria-invalid="nameError ? 'true' : 'false'"
          :aria-describedby="`${formId}-name-help`"
          placeholder="e.g. Living room TV"
          class="h-9 w-full rounded-md border bg-surface px-3 text-sm text-text shadow-xs placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-0"
          :class="
            nameError
          ? 'border-danger focus-visible:outline-danger/40'
          : 'border-border-strong focus-visible:border-accent focus-visible:outline-accent/40'
      "
          @blur="touched = true"
        />
        <p
          :id="`${formId}-name-help`"
          class="mt-1 text-xs"
          :class="nameError ? 'text-danger-fg' : 'text-muted'"
        >
          {{ nameError || 'Shown everywhere instead of the hostname.' }}
        </p>
      </div>

      <!-- Type -->
      <div>
        <label :for="`${formId}-type`" class="mb-1.5 block text-[13px] font-medium text-text">
          Device type
        </label>
        <div class="relative">
          <select
            :id="`${formId}-type`"
            ref="typeEl"
            v-model="type"
            data-testid="device-type-select"
            class="h-9 w-full appearance-none rounded-md border border-border-strong bg-surface pr-8 pl-3 text-sm text-text shadow-xs focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40"
          >
            <option value="">{{ autoOptionLabel }}</option>
            <option v-for="o in categoryOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
          <Icon
            name="chevron-down"
            :size="16"
            class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-subtle"
          />
        </div>
        <p class="mt-1 text-xs" :class="errors.type ? 'text-danger-fg' : 'text-muted'">
          {{ errors.type || (type ? 'Your choice always wins over auto-detection.' : 'NetMon identifies the device from its network signals.') }}
        </p>
      </div>

      <!-- Notes -->
      <div>
        <div class="mb-1.5 flex items-baseline justify-between">
          <label :for="`${formId}-notes`" class="block text-[13px] font-medium text-text">
            Notes <span class="font-normal text-subtle">(optional)</span>
          </label>
          <span
            class="text-[11px] tabular-nums"
            :class="notes.length > NOTES_MAX ? 'text-danger-fg' : 'text-subtle'"
          >{{ notes.length }}/{{ NOTES_MAX }}</span>
        </div>
        <textarea
          :id="`${formId}-notes`"
          v-model="notes"
          data-testid="device-notes-input"
          rows="3"
          :maxlength="NOTES_MAX"
          placeholder="e.g. Office desk, wired"
          class="w-full resize-y rounded-md border bg-surface px-3 py-2 text-sm text-text shadow-xs placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-0"
          :class="
            notesError
          ? 'border-danger focus-visible:outline-danger/40'
          : 'border-border-strong focus-visible:border-accent focus-visible:outline-accent/40'
      "
          @keydown="onNotesKeydown"
        />
        <p v-if="notesError" class="mt-1 text-xs text-danger-fg">{{ notesError }}</p>
      </div>
    </form>

    <template #footer>
      <div class="flex w-full items-center gap-2">
        <button
          v-if="isEdit"
          type="button"
          data-testid="modal-forget-btn"
          class="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-danger-fg hover:bg-danger/10"
          @click="emit('forget', device)"
        >
          <Icon name="trash" :size="15" />
          Forget device
        </button>
        <div class="ml-auto flex items-center gap-2">
          <button
            type="button"
            class="inline-flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium text-text ring-1 ring-border-strong ring-inset hover:bg-surface-3"
            data-testid="save-cancel-btn"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            :form="formId"
            data-testid="save-confirm-btn"
            class="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[13px] font-medium text-accent-contrast shadow-sm hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="submitting || (touched && !valid)"
            :aria-busy="submitting ? 'true' : 'false'"
          >
            <Spinner v-if="submitting" :size="14" />
            {{ isEdit ? 'Save changes' : 'Save device' }}
          </button>
        </div>
      </div>
    </template>
  </Modal>
</template>
