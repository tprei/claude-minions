export const LOG_READ_CHUNK_SIZE = 64 * 1024;
// Under docker mode each probe adds ~10–50 ms of exec overhead; tune if observed CPU floor is unacceptable.
export const PANE_PROBE_INTERVAL_MS = 250;
export const SENTINEL_POLL_INTERVAL_MS = 25;
export const SENTINEL_TIMEOUT_MS = 1000;
