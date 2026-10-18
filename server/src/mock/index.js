// Mock mode entry point (NETMON_MOCK=1). Drop-in replacements with the same signatures as
// net/sys.js, net/discovery.js, net/pinger.js, net/throughput.js, net/fingerprint/index.js and internet/*,
// plus mock world control. See PLAN.md §2.8 and §7. No network calls, no child processes.

export { getNetworkInfo, createDiscovery, createPinger, createThroughputMonitor, ping, readCounters } from './net.js';
export { createFingerprinter } from './fingerprint.js';
export { createProbe, runSpeedTest, fetchIsp, seedSpeedHistory } from './internet.js';
export { applyMockState, getMockState, resetMockState, validateMockPatch } from './state.js';
export { MOCK_DEVICES, MOCK_NEW_DEVICE, MOCK_NETWORK, MOCK_ISP } from './devices.js';
export { createSyslogReceiver, createSnmpClient, pollRouter } from './router.js';

/** PLAN.md §6.6 */
export const MOCK_TIMINGS = Object.freeze({
  scanIntervalMs: 1000,
  pingIntervalMs: 1000,
  throughputIntervalMs: 1000,
  probeIntervalMs: 1000,
  probeTimeoutMs: 500,
  ispRefreshMs: 60000,
  devicesBroadcastMs: 500,
  offlineAfterMs: 2500,
  dropUnsavedAfterMs: 30000,
  refingerprintMs: 21600000,
  startupSpeedTestDelayMs: 300,
  fingerprintPassiveBrowseMs: 60000,
  networkCheckMs: 5000,
});
