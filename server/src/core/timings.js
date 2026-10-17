// Interval / timeout configuration for real (production) mode.
// Mock mode uses MOCK_TIMINGS exported by ../mock/index.js (same keys, much faster).
export const REAL_TIMINGS = Object.freeze({
  scanIntervalMs: 30000,
  pingIntervalMs: 10000,
  throughputIntervalMs: 2000,
  probeIntervalMs: 5000,
  probeTimeoutMs: 3000,
  ispRefreshMs: 1800000,
  devicesBroadcastMs: 2000,
  offlineAfterMs: 90000,
  dropUnsavedAfterMs: 600000,
  refingerprintMs: 21600000,
  startupSpeedTestDelayMs: 5000,
  fingerprintPassiveBrowseMs: 300000,
  networkCheckMs: 15000,
});
