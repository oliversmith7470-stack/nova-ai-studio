// NOVA AI Studio — Phase 3 API process: shared constants.
//
// Single source for the numbers the approved design fixes. Every value
// cites its design section so a reviewer can check it without hunting.
// Values the design calls a "controlled-test starting value" or a
// "specified maximum, not a measured figure" are labelled as such here
// and are NEVER reported as measurements.

export const API_SERVER_VERSION = 'phase3-api-1.0.0';

// Rev 3.1 §A-3.1.2.2: executor acknowledgement window. Controlled-test
// starting value, adjustable only by the owner. NOT a measured figure.
export const ACK_WINDOW_MS = 60 * 1000;
// Rev 2 §6.3: job timeout (video default).
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;
// Rev 2 §9.2 / §15: sweep interval ≤ 15 minutes.
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Rev 3.2 §B-3.2.7.2: reconciliation timer, every 15 minutes, independent
// of the sweep timer.
export const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
// Rev 3.2 §B-3.2.7.2: escalation after 24 hours in reconciliation-needed.
export const RECONCILIATION_ESCALATION_MS = 24 * 60 * 60 * 1000;
// Rev 2 §18: maximum output size; one headroom reservation per execution.
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
// Rev 2 §9 / storage retention: generated outputs live 24 hours.
export const OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
// Rev 2 §15.2: O-23 daily cleanup-operation ceiling (hard stop).
export const CLEANUP_DAILY_CEILING = 20000;
// Rev 2 §15.3: O-23 account-wide usage threshold. The threshold is
// CONDITIONAL (Rev 3 §C-3 Q6): it is not operative as a guarantee until
// the usage source is measurable; when unreadable the sweep defers
// (fail closed).
export const CLEANUP_USAGE_THRESHOLD = 0.8;
// Rev 3.1 §A-3.1.4.2: retention alert threshold (rows OR logical bytes).
export const RETENTION_ALERT_ROWS = 10000;
export const RETENTION_ALERT_BYTES = 10 * 1024 * 1024;
// Q3 APPROVED by the owner 25 Nov 2026 ~18:21 WAT: 30-day job-record
// retention is ENABLED (supersedes "disabled, days unset"). Rev 2 §16.1:
// 30 days after the parent job reaches a terminal state, then deleted by
// the O-23-counted cleanup (§15).
export const RETENTION_ENABLED = true;
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// Rev 3.2 §B-3.2.5.2: retention hard ceiling (rows, jobs + scenes).
// Enforced atomically by the Worker creation batch; the API process
// reports against it but never enforces it itself.
export const RETENTION_CEILING_ROWS = 100000;
// Rev 3.2 §B-3.2.4.2: revocation propagation — specified maximum, NOT a
// measured figure.
export const REVOCATION_MAX_PROPAGATION_MS = 5000;
// Rev 2 §11 / Rev 3 §C-1.10: HMAC timestamp window.
export const HMAC_TIMESTAMP_WINDOW_S = 60;
// Rev 2 §3.5: Worker submit timeout (the API process must answer
// /internal/submit inside it — hence the 202-at-slot-claim rule,
// Rev 3.2 §B-3.2.8).
export const SUBMIT_TIMEOUT_MS = 10000;
// Rev 2 §18.1: validation timeouts.
export const VALIDATION_FFPROBE_TIMEOUT_MS = 30 * 1000;
export const VALIDATION_DECODE_TIMEOUT_MS = 120 * 1000;
// Proven LTX parameters (Rev 2 §4 step 5 / §5.1). Anything else → 400.
export const PROVEN_MODEL = 'ltx-video-2b';
export const PROVEN_FRAMES = 121;
export const PROVEN_RESOLUTION = '1024x576';
export const PROVEN_FPS = 24;
