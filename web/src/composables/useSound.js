// useSound — WebAudio alarm tones for NetMon (no audio files).
//
// Module-level singleton: every caller shares one AudioContext and one reactive
// state, so the TopBar mute button, the AlertStack "Enable sound" button and the
// renderless AlarmController all see the same thing.
//
// Browser autoplay policy: an AudioContext created/resumed outside a user gesture
// stays "suspended". We therefore
//   1. create the context lazily,
//   2. install one-time capture listeners (pointerdown / keydown / touchend) that
//      resume it on the first user gesture anywhere on the page, and
//   3. expose `needsUnlock` so the UI can offer an explicit "Enable sound" button
//      when an alarm wants to sound but audio is still blocked.
//
// Gating: `playAlarm` / `playChime` / the repeating loop honour the server setting
// `settings.soundAlerts` and the per-browser session mute `ui.muted` (unless called
// with { force: true }, used by the Settings "Test sound" link). Muting silences any
// tones already scheduled immediately.

import { ref, computed, watch } from 'vue';
import { state, ui } from '../store.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/** true once the AudioContext is running (a user gesture unlocked it). */
const unlocked = ref(false);
/** true while the repeating critical alarm loop is active (whether or not audible). */
const alarmActive = ref(false);
/** true when the last attempt to play was blocked by the autoplay policy. */
const blocked = ref(false);

let ctx = null;              // AudioContext | null
let listenersInstalled = false;
let loopTimer = null;
let loopLevel = 'critical';
let loopIntervalMs = 30000;
let muteWatcherInstalled = false;
const activeBuses = new Set(); // GainNodes of patterns currently sounding

const AudioCtor =
  typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext || null : null;

const supported = !!AudioCtor;

/** Whether policy (setting + mute) allows sound right now. */
function allowed() {
  const soundOn = state?.settings?.soundAlerts !== false; // default true when unknown
  return soundOn && !ui?.muted;
}

function getCtx() {
  if (!supported) return null;
  if (!ctx) {
    try {
      ctx = new AudioCtor();
      ctx.onstatechange = () => {
        unlocked.value = ctx.state === 'running';
        if (unlocked.value) blocked.value = false;
      };
      unlocked.value = ctx.state === 'running';
    } catch (err) {
      console.warn('[useSound] AudioContext unavailable', err);
      ctx = null;
    }
  }
  return ctx;
}

function onFirstGesture() {
  unlock();
}

function installGestureListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', onFirstGesture, opts);
  window.addEventListener('keydown', onFirstGesture, opts);
  window.addEventListener('touchend', onFirstGesture, opts);
}

function removeGestureListeners() {
  if (!listenersInstalled || typeof window === 'undefined') return;
  const opts = { capture: true };
  window.removeEventListener('pointerdown', onFirstGesture, opts);
  window.removeEventListener('keydown', onFirstGesture, opts);
  window.removeEventListener('touchend', onFirstGesture, opts);
  listenersInstalled = false;
}

/**
 * Try to unlock audio. Safe to call any time; must be called from a user gesture
 * to actually succeed under autoplay restrictions. Resolves to `unlocked.value`.
 */
async function unlock() {
  const c = getCtx();
  if (!c) return false;
  try {
    if (c.state !== 'running') await c.resume();
    // iOS Safari needs a sound to be started inside the gesture: play 1 silent frame.
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* ignore — stays locked */
  }
  unlocked.value = c.state === 'running';
  if (unlocked.value) {
    blocked.value = false;
    removeGestureListeners();
  }
  return unlocked.value;
}

/** Stop every tone that is currently scheduled/sounding. */
function silenceAll() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const bus of activeBuses) {
    try {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(0, now);
      bus.disconnect();
    } catch {
      /* ignore */
    }
  }
  activeBuses.clear();
}

/**
 * Schedule a list of tones on a fresh bus.
 * tone = { at (s, relative), dur (s), freq, freqEnd?, gain, type? }
 * Returns true if scheduled, false if audio is unavailable/blocked.
 */
function playPattern(tones) {
  const c = getCtx();
  if (!c) return false;
  if (c.state !== 'running') {
    // Attempt a resume (works if we are inside a gesture); report blocked otherwise.
    c.resume().catch(() => {});
    if (c.state !== 'running') {
      blocked.value = true;
      return false;
    }
  }
  try {
    const bus = c.createGain();
    bus.gain.value = 1;
    bus.connect(c.destination);
    activeBuses.add(bus);
    const t0 = c.currentTime + 0.02;
    let end = t0;
    for (const t of tones) {
      const start = t0 + t.at;
      const stop = start + t.dur;
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = t.type || 'sine';
      osc.frequency.setValueAtTime(t.freq, start);
      if (t.freqEnd) osc.frequency.exponentialRampToValueAtTime(t.freqEnd, stop);
      // Envelope: 10 ms attack, sustain, 60 ms release (clamped for short tones).
      const attack = 0.01;
      const release = Math.min(0.06, t.dur / 2);
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(t.gain, start + attack);
      env.gain.setValueAtTime(t.gain, Math.max(start + attack, stop - release));
      env.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(env).connect(bus);
      osc.start(start);
      osc.stop(stop + 0.02);
      end = Math.max(end, stop);
    }
    // Clean up the bus once the pattern has finished.
    const ms = (end - c.currentTime + 0.1) * 1000;
    setTimeout(() => {
      if (activeBuses.has(bus)) {
        activeBuses.delete(bus);
        try { bus.disconnect(); } catch { /* ignore */ }
      }
    }, Math.max(0, ms));
    blocked.value = false;
    return true;
  } catch (err) {
    console.warn('[useSound] failed to play', err);
    return false;
  }
}

// --- Patterns ---------------------------------------------------------------

/** Critical: three two-tone beeps (880 Hz → 660 Hz, 160 ms each, 40 ms gap). */
function criticalPattern() {
  const tones = [];
  const beep = 0.16;
  const gap = 0.04;
  const pairGap = 0.28;
  for (let i = 0; i < 3; i++) {
    const base = i * (beep * 2 + gap + pairGap);
    tones.push({ at: base, dur: beep, freq: 880, gain: 0.18 });
    tones.push({ at: base + beep + gap, dur: beep, freq: 660, gain: 0.18 });
  }
  return tones;
}

/** Warning: one soft 660 → 990 Hz glide, 220 ms. */
function warningPattern() {
  return [{ at: 0, dur: 0.22, freq: 660, freqEnd: 990, gain: 0.12 }];
}

/** Chime (restored / info): single soft 990 Hz blip, 120 ms. */
function chimePattern() {
  return [{ at: 0, dur: 0.12, freq: 990, gain: 0.1 }];
}

/**
 * Play an alarm once. level: 'critical' | 'warning'.
 * Returns true if sound was actually scheduled.
 */
function playAlarm(level = 'critical', { force = false } = {}) {
  if (!force && !allowed()) return false;
  return playPattern(level === 'critical' ? criticalPattern() : warningPattern());
}

/** Play the soft "restored" chime once. */
function playChime({ force = false } = {}) {
  if (!force && !allowed()) return false;
  return playPattern(chimePattern());
}

function tick() {
  if (!alarmActive.value) return;
  if (allowed()) playAlarm(loopLevel);
}

/**
 * Start a repeating alarm: plays immediately, then every `intervalMs` while active.
 * Mute / soundAlerts=false keep the loop alive but silent (it resumes audibly once
 * un-muted, at the next tick).
 */
function startAlarmLoop(level = 'critical', intervalMs = 30000) {
  installMuteWatcher();
  loopLevel = level;
  loopIntervalMs = intervalMs;
  if (loopTimer) clearInterval(loopTimer);
  alarmActive.value = true;
  tick();
  loopTimer = setInterval(tick, loopIntervalMs);
}

function stopAlarmLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  alarmActive.value = false;
  blocked.value = false;
  silenceAll();
}

/** Restart the loop from now (used after the user explicitly enables sound). */
function restartAlarmLoop() {
  if (alarmActive.value) startAlarmLoop(loopLevel, loopIntervalMs);
}

function installMuteWatcher() {
  if (muteWatcherInstalled) return;
  muteWatcherInstalled = true;
  // Mute or turning sound alerts off silences scheduled tones immediately.
  watch(
    () => allowed(),
    (ok) => {
      if (!ok) silenceAll();
    },
  );
}

/** Alarm wants to sound, audio is allowed by settings, but the browser blocks it. */
const needsUnlock = computed(
  () => supported && alarmActive.value && !unlocked.value && allowed(),
);
/** Alarm loop active and audible right now (used to highlight the mute button). */
const sounding = computed(() => alarmActive.value && allowed());

export function useSound() {
  installGestureListeners();
  return {
    supported,
    unlocked,
    blocked,
    alarmActive,
    needsUnlock,
    sounding,
    unlock,
    playAlarm,
    playChime,
    startAlarmLoop,
    stopAlarmLoop,
    restartAlarmLoop,
    silenceAll,
  };
}

export default useSound;
