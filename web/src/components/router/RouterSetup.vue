<script setup>
// Router integration setup form: syslog receiver + SNMP poller. Saves through PUT /api/router/config.
// The SNMP community is write-only: the field stays empty and an empty field keeps the saved value.
import { computed, reactive, ref } from 'vue';
import Toggle from '../ui/Toggle.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import { state, updateRouterConfig, testRouterSnmp, pushToast } from '../../store.js';

const emit = defineEmits(['done']);

const inputBase =
  'h-9 rounded-md border bg-surface-2 px-3 text-[13px] text-text outline-none transition-colors placeholder:text-subtle focus-visible:border-accent';

const cfg = computed(() => state.router.config);
const gateway = computed(() => state.network?.gateway || null);
const selfIp = computed(() => state.network?.ip || 'this computer’s IP');

function fromConfig(c) {
  return {
    syslog: { enabled: !!c?.syslog?.enabled, port: c?.syslog?.port ?? 514, source: c?.syslog?.source ?? '' },
    snmp: { enabled: !!c?.snmp?.enabled, host: c?.snmp?.host ?? '', community: '', intervalSec: c?.snmp?.intervalSec ?? 10 },
  };
}
// The form is created each time it opens, so it starts from the current saved config.
const draft = reactive(fromConfig(cfg.value));

const errors = ref({});
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);

async function save() {
  errors.value = {};
  const patch = {
    syslog: { enabled: draft.syslog.enabled, port: Number(draft.syslog.port), source: draft.syslog.source.trim() },
    snmp: { enabled: draft.snmp.enabled, host: draft.snmp.host.trim(), intervalSec: Number(draft.snmp.intervalSec) },
  };
  if (draft.snmp.community) patch.snmp.community = draft.snmp.community;
  saving.value = true;
  try {
    await updateRouterConfig(patch);
    draft.snmp.community = '';
    pushToast({ level: 'success', title: 'Router settings saved' });
    emit('done');
  } catch (err) {
    if (err?.details) errors.value = err.details;
  } finally {
    saving.value = false;
  }
}

async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await testRouterSnmp({ host: draft.snmp.host.trim() || undefined, community: draft.snmp.community || undefined });
  } catch (err) {
    testResult.value = { ok: false, error: err?.message || String(err) };
  } finally {
    testing.value = false;
  }
}

const communityPlaceholder = computed(() => {
  if (cfg.value?.snmp?.communityFromEnv) return 'Set by NETMON_SNMP_COMMUNITY';
  return cfg.value?.snmp?.communitySet ? '•••••• saved — type to replace' : 'Read community';
});
</script>

<template>
  <form class="flex flex-col gap-5 px-4 py-4" data-testid="router-setup" @submit.prevent="save">
    <!-- Syslog -->
    <section class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-[13px] font-semibold text-text">Router log (syslog)</h3>
          <p class="text-xs text-muted">Receive the router's own log: internet drops, DHCP, logins, blocked attacks.</p>
        </div>
        <Toggle v-model="draft.syslog.enabled" label="Receive router log" data-testid="router-syslog-toggle" />
      </div>
      <div v-if="draft.syslog.enabled" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-muted">
          UDP port
          <input
            v-model.number="draft.syslog.port"
            type="number"
            min="1"
            max="65535"
            :class="[inputBase, errors['syslog.port'] ? 'border-danger' : 'border-border-strong']"
            data-testid="router-syslog-port"
          />
          <span v-if="errors['syslog.port']" class="text-danger-fg">{{ errors['syslog.port'] }}</span>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Accept messages from
          <input
            v-model="draft.syslog.source"
            type="text"
            inputmode="decimal"
            :placeholder="gateway ? `${gateway} (gateway)` : 'Router IP'"
            :class="[inputBase, errors['syslog.source'] ? 'border-danger' : 'border-border-strong']"
            data-testid="router-syslog-source"
          />
          <span v-if="errors['syslog.source']" class="text-danger-fg">{{ errors['syslog.source'] }}</span>
        </label>
        <p class="rounded-md bg-surface-2 px-3 py-2 text-xs leading-5 text-muted sm:col-span-2">
          <Icon name="info" :size="12" class="mr-1 inline-block align-[-1px] text-subtle" />
          In your router's admin page, find the remote logging setting (often called <span class="text-text">Remote log</span>,
          <span class="text-text">Syslog server</span> or <span class="text-text">Send log</span>) and set the server to
          <span class="font-mono text-text">{{ selfIp }}</span>, UDP port {{ draft.syslog.port }}. Many routers always use 514.
          Give this computer a DHCP reservation so the address does not change.
        </p>
      </div>
    </section>

    <!-- SNMP -->
    <section class="flex flex-col gap-3 border-t border-border pt-4">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-[13px] font-semibold text-text">Port traffic (SNMP)</h3>
          <p class="text-xs text-muted">Poll the router for per-port status and throughput, including the internet link.</p>
        </div>
        <Toggle v-model="draft.snmp.enabled" label="Poll router over SNMP" data-testid="router-snmp-toggle" />
      </div>
      <div v-if="draft.snmp.enabled" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-xs text-muted">
          Router address
          <input
            v-model="draft.snmp.host"
            type="text"
            inputmode="decimal"
            :placeholder="gateway ? `${gateway} (gateway)` : 'Router IP'"
            :class="[inputBase, errors['snmp.host'] ? 'border-danger' : 'border-border-strong']"
            data-testid="router-snmp-host"
          />
          <span v-if="errors['snmp.host']" class="text-danger-fg">{{ errors['snmp.host'] }}</span>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Community (v2c)
          <input
            v-model="draft.snmp.community"
            type="password"
            autocomplete="off"
            :disabled="cfg?.snmp?.communityFromEnv"
            :placeholder="communityPlaceholder"
            :class="[inputBase, errors['snmp.community'] ? 'border-danger' : 'border-border-strong']"
            data-testid="router-snmp-community"
          />
          <span v-if="errors['snmp.community']" class="text-danger-fg">{{ errors['snmp.community'] }}</span>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Poll every (s)
          <input
            v-model.number="draft.snmp.intervalSec"
            type="number"
            min="5"
            max="300"
            :class="[inputBase, errors['snmp.intervalSec'] ? 'border-danger' : 'border-border-strong']"
            data-testid="router-snmp-interval"
          />
          <span v-if="errors['snmp.intervalSec']" class="text-danger-fg">{{ errors['snmp.intervalSec'] }}</span>
        </label>
        <div class="flex flex-wrap items-center gap-2 sm:col-span-3">
          <Button size="sm" variant="secondary" icon="activity" :loading="testing" data-testid="router-snmp-test" @click="test">Test connection</Button>
          <span v-if="testResult?.ok" class="text-xs text-success-fg" data-testid="router-snmp-test-result">
            <Icon name="check" :size="12" class="inline-block align-[-1px]" />
            {{ testResult.system?.name || testResult.host }} answered · {{ testResult.ports?.length ?? 0 }} ports
          </span>
          <span v-else-if="testResult" class="text-xs text-danger-fg" data-testid="router-snmp-test-result">{{ testResult.error }}</span>
        </div>
        <p class="rounded-md bg-surface-2 px-3 py-2 text-xs leading-5 text-muted sm:col-span-3">
          <Icon name="info" :size="12" class="mr-1 inline-block align-[-1px] text-subtle" />
          In your router's admin page, enable <span class="text-text">SNMP v2c</span> with a read-only community that is not
          <span class="font-mono">public</span>. The internet port is found from the router's default route. The community is
          stored on this computer only and never shown again.
        </p>
      </div>
    </section>

    <div class="flex justify-end gap-2 border-t border-border pt-4">
      <Button variant="ghost" size="sm" @click="emit('done')">Cancel</Button>
      <Button type="submit" size="sm" :loading="saving" data-testid="router-save">Save</Button>
    </div>
  </form>
</template>
