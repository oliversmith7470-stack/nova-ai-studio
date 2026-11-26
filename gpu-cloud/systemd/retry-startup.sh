#!/bin/sh
# retry-startup.sh — startup retry supervisor for the NOVA API chain.
#
# Phase 5, Rev 4.8 §14 (retry supervisor) + §10 (canonical log format).
# Run by nova-startup-retry.service (Type=oneshot, RemainAfterExit=no,
# TimeoutSec=780). Triggered by OnFailure= on the two dependency units
# ONLY (nova-startup-id.service, nova-storage-recovery.service) — never by
# the API unit — plus its own step-(9) re-arm timer and the operator.
#
# Flow, in order (§14 steps (1)–(9)):
#   (1) Sleep 30 s (the backoff — the same 30 s as the API unit's
#       RestartSec).
#   (2) If `systemctl is-active nova-api-server.service` reports active OR
#       activating, exit 0 — an operator (or another path) already
#       restarted it, nothing to do. Both states are recognised: a unit
#       still activating is a chain in flight, not a failed chain.
#       Before the reserve step, if the recovery unit's Result is
#       `timeout`, log startup-recovery-timeout (Recovery family, §10).
#   (3) Acquire the counter lock (/var/lib/nova-api/startup-attempts.lock,
#       flock -w 10) for the READ-AND-RESERVE step only, and reserve the
#       next attempt slot via the counter CLI (`reserve` — one call does
#       the read, the checks, and the write, all under the lock):
#         counter absent     -> startup-retry-counter-unavailable, exit 0
#         counter unreadable -> startup-retry-counter-unavailable, exit 0
#         counter malformed  -> startup-retry-counter-malformed, exit 0
#         write fails (code 3) / internal error (code 4)
#                            -> startup-retry-counter-unavailable, exit 0
#         lock not acquired in 10 s
#                            -> startup-retry-counter-unavailable with
#                               detail lock-timeout, exit 0
#   (4) The CLI's reserve also implements the window rule: an expired
#       window is written as a coherent new window WITH the reservation
#       AND a new generation; a reservation already held refuses with
#       startup-retry-slot-reserved; attempts >= 5 refuses with
#       startup-retry-limit-reached (both exit 0, no re-attempt).
#   (5) Otherwise the slot is RESERVED: the supervisor's own fresh token
#       is in `reservation` (attempts unchanged). The lock is RELEASED
#       here — it is never held across the start that follows.
#   (6) Run `systemctl start nova-api-server.service` (a plain call, not
#       exec, so this script stays alive to handle the result) and record
#       its exit status as start_status. A non-zero start_status does NOT
#       end the supervisor's work: steps (7)–(9) run for EVERY start
#       result, in order, with no early exit between them.
#   (7) RELEASE CHECK (always runs). Re-acquire the counter lock
#       (bounded wait, 10 s) and release ONLY the supervisor's own token
#       (CLI `release` — token-checked):
#         stored token == own token -> release it, log
#           startup-retry-start-failed with detail `released`
#         stored token is a DIFFERENT token -> release NOTHING, log
#           startup-retry-start-failed with detail `not-owner`
#         no reservation stored (reservation === null) -> preparation
#           consumed the token (attempts += 1): nothing to release and
#           nothing is logged here
#         window expired since the reserve -> the token died with the old
#           window: nothing to release; log startup-retry-start-failed
#           with detail `window-expired`
#         lock timeout / counter read failure -> log
#           startup-retry-counter-unavailable (or -malformed) and exit 0:
#           no release, no re-arm (fail-closed).
#   (8) OUTCOME CHECK (Rev 4.9 §5). The API unit is Type=notify; therefore
#       the preceding `systemctl start` returns successfully only after the
#       API has completed its startup path and sent READY=1 after a
#       successful listen. Read `systemctl is-active` after the start job
#       returns. If the state is `active`, the chain reached application
#       readiness and this supervisor exits 0 without re-arming. If the
#       start job failed, timed out, or the unit is not active, continue to
#       step (9). Do not treat the transient `activating` state as success;
#       Type=simple is not used for this service.
#   (9) RE-ARM DECISION (Rev 4.8, F5-33). Re-read the counter FRESH under
#       the lock (the step-(7) read is never reused for this decision):
#         attempts >= 5  -> log startup-retry-limit-reached, exit 0
#         a reservation is held -> exit 0 (another supervisor owns the
#           next slot; its OnFailure= or its own re-arm drives it)
#         otherwise (chain failed, attempts < 5, no reservation held) ->
#           release the lock and schedule a fresh supervisor activation
#           AFTER this supervisor exits:
#             systemd-run --on-active=5s
#               --unit=nova-startup-rearm-<own-token>
#               /usr/bin/systemctl start nova-startup-retry.service
#           The 5 s delay guarantees this supervisor unit has exited
#           before the start is attempted. A re-arm scheduling failure
#           (systemd-run non-zero) is logged as
#           startup-retry-start-failed with detail `rearm-failed` and the
#           supervisor exits 0 (deliberate exit-0 conversion — the
#           supervisor ran and completed its decision; only the
#           scheduling failed).
#
# FAILURE CONTRACT (Rev 4.8, F5-33): a re-arm scheduling failure is a
# deliberate exit 0 (logged `rearm-failed` before the exit, never silent).
# A supervisor EXECUTION failure is a non-zero exit — the supervisor
# terminated before completing its work (it has no restart of its own;
# the failure is visible in systemctl status and the supervisor-failure
# alert fires on its named event). A counter re-read failure in step (7)
# or (9) exits 0 only AFTER logging the counter failure, and with no
# re-arm.
#
# RACE BOUNDARY (Rev 4.8, F5-33): the step-(9) read and the timer creation
# are separated by the lock release, so another actor may reserve a slot
# between the check and the timer creation. Safe BY CONSTRUCTION: the
# re-armed supervisor performs its own fresh locked eligibility check in
# its step (3) and refuses with startup-retry-slot-reserved (or
# startup-retry-limit-reached) if the state changed.
#
# POSIX sh (dash). No `set -e`: every status is checked explicitly and
# every path ends in an explicit exit, so an unexpected failure can never
# silently become a successful completion.

set -u

STATE_DIR=/var/lib/nova-api
LOCK_FILE=$STATE_DIR/startup-attempts.lock
COUNTER_CLI=/opt/nova-ai-studio/bin/startup-counter.mjs
API_UNIT=nova-api-server.service
RECOVERY_UNIT=nova-storage-recovery.service
TAG=nova-startup-retry

# The counter lock file is flocked by root-side callers (this script,
# prepare-startup-id.sh) AND by the API process (User=nova-api, reset
# path). flock creates the file on first open with the caller's umask, so
# a root-created 0660 root:root lock file is EACCES to the API and its
# post-listen reset fails (startup-recovery-counter-unwritable). Normalise
# it here, before any flock use: group nova-api, group-writable. Best
# effort (a missing group means the API cannot run as nova-api anyway);
# chmod on a locked file does not disturb the lock.
touch "$LOCK_FILE" 2>/dev/null || true
chgrp nova-api "$LOCK_FILE" 2>/dev/null || true
chmod 0660 "$LOCK_FILE" 2>/dev/null || true

RETRY_TOKEN=

# log_event <event> <level> <windowStart> <detail>
# Canonical line (§10): ts level event requestId windowStart detail.
# The supervisor has no request id for the attempt it is refusing, so
# requestId is always none; windowStart is the counter window when the
# counter was read successfully, else none. detail is a single token.
log_event() {
    _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '1970-01-01T00:00:00Z')
    logger -t "$TAG" "ts=$_ts level=$2 event=$1 requestId=none windowStart=$3 detail=$4"
}

# result_code <RESULT line> -> numeric code, or empty if not a RESULT line.
result_code() {
    printf '%s' "$1" | sed -n 's/^RESULT \([0-9][0-9]*\) .*/\1/p'
}

# result_json_string <RESULT line> <key> -> the string value, or empty.
result_json_string() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# result_json_int <RESULT line> <key> -> the integer value, or empty.
result_json_int() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}

# cli_under_lock <op> [args...]
# Runs the counter CLI under the lock (bounded wait, 10 s) and sets:
#   CLI_OUT          — the CLI's stdout (exactly one RESULT line on success)
#   CLI_FLOCK_STATUS — flock's exit status (non-zero = lock not acquired;
#                      the CLI never ran)
#   CLI_FLOCK_ERR    — path of a temp file holding flock's stderr, or empty
#                      when no temp file could be created. The caller owns
#                      removing it.
cli_under_lock() {
    CLI_FLOCK_ERR=$(mktemp "$STATE_DIR/.retry-flock-err.XXXXXX" 2>/dev/null || echo "")
    if [ -n "$CLI_FLOCK_ERR" ]; then
        CLI_OUT=$(flock --verbose --exclusive --timeout 10 "$LOCK_FILE" node "$COUNTER_CLI" "$@" 2>"$CLI_FLOCK_ERR")
        CLI_FLOCK_STATUS=$?
    else
        CLI_OUT=$(flock --verbose --exclusive --timeout 10 "$LOCK_FILE" node "$COUNTER_CLI" "$@" 2>/dev/null)
        CLI_FLOCK_STATUS=$?
    fi
}

# lock_failure_detail — classify a failed flock acquisition from its
# stderr: `lock-timeout` when the stderr proves a timeout, else
# `flock-failed`. Call only when CLI_FLOCK_STATUS is non-zero.
lock_failure_detail() {
    if [ -n "$CLI_FLOCK_ERR" ] && grep -q "timeout while waiting to get lock" "$CLI_FLOCK_ERR" 2>/dev/null; then
        printf '%s' "lock-timeout"
    else
        printf '%s' "flock-failed"
    fi
}

# counter_unavailable_exit — log startup-retry-counter-unavailable for a
# step-(7)/(9) counter failure and exit 0 (no release, no re-arm).
# $1 = RESULT code (6 absent, 5 unreadable, 3 unwritable, 4 internal, or
# empty for a broken RESULT line). The RESULT line is in CLI_OUT.
counter_unavailable_exit() {
    _reason=$(result_json_string "$CLI_OUT" "reason")
    case "$1" in
        6) log_event startup-retry-counter-unavailable error none "counter-absent" ;;
        5) log_event startup-retry-counter-unavailable error none "${_reason:-unreadable}" ;;
        3) log_event startup-retry-counter-unavailable error none "${_reason:-unwritable}" ;;
        4) log_event startup-retry-counter-unavailable error none "internal-error" ;;
        *) log_event startup-retry-counter-unavailable error none "counter-no-result" ;;
    esac
    exit 0
}

mkdir -p "$STATE_DIR" 2>/dev/null || true

# (1) Backoff.
sleep 30

# (2) Already active or activating? Nothing to do. BOTH states are
# recognised: a unit still activating is a chain in flight, not a failed
# chain.
api_state=$(systemctl is-active "$API_UNIT" 2>/dev/null || true)
case "$api_state" in
    active|activating)
        exit 0
        ;;
esac

# Recovery-timeout observation, before the reserve step: when this run
# follows a recovery-unit failure whose Result is `timeout`, log
# startup-recovery-timeout (Recovery family, §10).
rec_result=$(systemctl show "$RECOVERY_UNIT" -p Result --value 2>/dev/null || true)
if [ "$rec_result" = "timeout" ]; then
    log_event startup-recovery-timeout error none "recovery-timeout"
fi

# (3)–(5) Read-and-reserve under the lock (one CLI call); the lock is
# released when the flock command exits, before the start that follows.
cli_under_lock reserve
if [ "$CLI_FLOCK_STATUS" -ne 0 ]; then
    detail=$(lock_failure_detail)
    rm -f "$CLI_FLOCK_ERR"
    log_event startup-retry-counter-unavailable error none "$detail"
    exit 0
fi
rm -f "$CLI_FLOCK_ERR"

code=$(result_code "$CLI_OUT")
case "$code" in
    0)
        RETRY_TOKEN=$(result_json_string "$CLI_OUT" "token")
        if [ -z "$RETRY_TOKEN" ]; then
            log_event startup-retry-counter-unavailable error none "counter-no-result"
            exit 0
        fi
        ;;
    6)
        log_event startup-retry-counter-unavailable error none "counter-absent"
        exit 0
        ;;
    5)
        reason=$(result_json_string "$CLI_OUT" "reason")
        log_event startup-retry-counter-unavailable error none "${reason:-unreadable}"
        exit 0
        ;;
    2)
        reason=$(result_json_string "$CLI_OUT" "reason")
        log_event startup-retry-counter-malformed error none "${reason:-malformed}"
        exit 0
        ;;
    3)
        reason=$(result_json_string "$CLI_OUT" "reason")
        log_event startup-retry-counter-unavailable error none "${reason:-unwritable}"
        exit 0
        ;;
    4)
        log_event startup-retry-counter-unavailable error none "internal-error"
        exit 0
        ;;
    7)
        window_start=$(result_json_string "$CLI_OUT" "windowStart")
        log_event startup-retry-slot-reserved error "${window_start:-none}" "slot-reserved"
        exit 0
        ;;
    8)
        window_start=$(result_json_string "$CLI_OUT" "windowStart")
        log_event startup-retry-limit-reached error "${window_start:-none}" "limit-reached"
        exit 0
        ;;
    *)
        log_event startup-retry-counter-unavailable error none "counter-no-result"
        exit 0
        ;;
esac

# (6) Start the whole chain (plain call, not exec). The lock is NOT held
# here. start_status is recorded; a non-zero status does not end the
# supervisor's work — steps (7)–(9) run for EVERY start result.
if systemctl start "$API_UNIT"; then
    start_status=0
else
    start_status=$?
fi

# (7) RELEASE CHECK — always runs. Re-acquire the lock and release ONLY
# this supervisor's own token (CLI `release` is token-checked).
cli_under_lock release "$RETRY_TOKEN"
if [ "$CLI_FLOCK_STATUS" -ne 0 ]; then
    detail=$(lock_failure_detail)
    rm -f "$CLI_FLOCK_ERR"
    log_event startup-retry-counter-unavailable error none "$detail"
    exit 0
fi
rm -f "$CLI_FLOCK_ERR"

code=$(result_code "$CLI_OUT")
case "$code" in
    0)
        if printf '%s' "$CLI_OUT" | grep -q '"released":true'; then
            # Stored token was this supervisor's own: preparation never
            # ran (the start was refused before any chain attempt
            # started). Released; log the failed start.
            log_event startup-retry-start-failed error none "released"
        else
            reason=$(result_json_string "$CLI_OUT" "reason")
            case "$reason" in
                not-owner)
                    # Two sub-cases, distinguished by the stored value:
                    # a DIFFERENT token is held -> log not-owner and
                    # release nothing; NO token is held (reservation
                    # === null) -> preparation consumed this
                    # supervisor's token (attempts += 1): nothing to
                    # release and nothing is logged here.
                    if printf '%s' "$CLI_OUT" | grep -q '"reservation":null'; then
                        :
                    else
                        log_event startup-retry-start-failed error none "not-owner"
                    fi
                    ;;
                window-expired)
                    # The token died with the old window: nothing to
                    # release; log the failed start with the cause.
                    log_event startup-retry-start-failed error none "window-expired"
                    ;;
                *)
                    log_event startup-retry-start-failed error none "release-${reason:-unknown}"
                    ;;
            esac
        fi
        ;;
    6|5|3|4)
        counter_unavailable_exit "$code"
        ;;
    2)
        reason=$(result_json_string "$CLI_OUT" "reason")
        log_event startup-retry-counter-malformed error none "${reason:-malformed}"
        exit 0
        ;;
    *)
        counter_unavailable_exit ""
        ;;
esac

# (8) OUTCOME CHECK (Rev 4.9 §5). The API unit is Type=notify; therefore
# the preceding `systemctl start` returns successfully only after the API
# has completed its startup path and sent READY=1 after a successful
# listen. Read `systemctl is-active` after the start job returns. If the
# state is `active`, the chain reached application readiness and this
# supervisor exits 0 without re-arming. If the start job failed, timed out,
# or the unit is not active, continue to step (9). Do not treat the
# transient `activating` state as success; Type=simple is not used for this
# service.
api_state=$(systemctl is-active "$API_UNIT" 2>/dev/null || true)
if [ "$api_state" = "active" ]; then
    exit 0
fi

# (9) RE-ARM DECISION. Re-read the counter FRESH under the lock (the
# step-(7) read is never reused for this decision).
cli_under_lock read
if [ "$CLI_FLOCK_STATUS" -ne 0 ]; then
    detail=$(lock_failure_detail)
    rm -f "$CLI_FLOCK_ERR"
    log_event startup-retry-counter-unavailable error none "$detail"
    exit 0
fi
rm -f "$CLI_FLOCK_ERR"

code=$(result_code "$CLI_OUT")
case "$code" in
    0)
        attempts=$(result_json_int "$CLI_OUT" "attempts")
        if [ "${attempts:-0}" -ge 5 ] 2>/dev/null; then
            window_start=$(result_json_string "$CLI_OUT" "windowStart")
            log_event startup-retry-limit-reached error "${window_start:-none}" "attempts-${attempts}"
            exit 0
        fi
        if ! printf '%s' "$CLI_OUT" | grep -q '"reservation":null'; then
            # Another supervisor owns the next slot; its OnFailure= or
            # its own re-arm drives it. No re-arm, no log.
            exit 0
        fi
        # Chain failed, attempts < 5, no reservation held: schedule a
        # fresh supervisor activation AFTER this supervisor exits. The
        # 5 s delay guarantees this supervisor unit has exited before
        # the start is attempted. The transient timer unit name carries
        # this supervisor's own token, so two supervisors' re-arms
        # never collide.
        if systemd-run --on-active=5s --unit="nova-startup-rearm-$RETRY_TOKEN" /usr/bin/systemctl start nova-startup-retry.service >/dev/null 2>&1; then
            exit 0
        else
            log_event startup-retry-start-failed error none "rearm-failed"
            exit 0
        fi
        ;;
    6|5|3|4)
        counter_unavailable_exit "$code"
        ;;
    2)
        reason=$(result_json_string "$CLI_OUT" "reason")
        log_event startup-retry-counter-malformed error none "${reason:-malformed}"
        exit 0
        ;;
    *)
        counter_unavailable_exit ""
        ;;
esac

# Unreachable: every branch above exits. If control ever reaches here,
# that is an execution failure (non-zero by the failure contract).
exit 1
