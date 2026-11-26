#!/bin/sh
# prepare-startup-id.sh — startup-ID preparation for the NOVA API chain.
#
# Phase 5, Rev 4.8 §14 (preparation unit) + §10 (canonical log format).
# Run by nova-startup-id.service (Type=oneshot, RemainAfterExit=no) once
# per start attempt. One function, nothing else:
#   1. Generate a fresh UUID with node (crypto.randomUUID() — not uuidgen,
#      which is absent from the host). The id is generated FIRST, in memory,
#      so a counter failure can still be logged with a real requestId (§10:
#      preparation lines always carry a requestId). The id is written to
#      the file ONLY after the counter step succeeds.
#   2. Count this chain attempt in the shared attempt counter
#      (/var/lib/nova-api/startup-attempts) via the counter CLI under the
#      flock lock (single call to `prepare`). Five cases, all fail-closed:
#        absent      -> initialise {attempts: 1, windowStart: now, ...}
#        unreadable  -> log startup-preparation-counter-unreadable, exit 1
#        malformed   -> log startup-preparation-counter-malformed, exit 1
#        unwritable  -> log startup-preparation-counter-unwritable, exit 1
#        at limit    -> log startup-preparation-limit-reached, exit 1
#        (a lock timeout is an unreadable counter: the same event, detail
#        lock-timeout — §10 ALERT_EVENTS.)
#      A held reservation is consumed by prepare (attempts += 1,
#      reservation -> null); at the limit the counter bytes are UNCHANGED
#      and a held reservation is NOT consumed.
#   3. Write the UUID atomically (temp file + rename) to
#      /var/lib/nova-api/startup-request-id and verify it by reading it
#      back. A failure to write the id file is a plain (non-canonical)
#      journal line + exit 1: no registered event names that failure, and
#      the unit failure is visible in systemctl status (§14 alert table).
#
# Exit 0 on success, non-zero on failure. On failure the chain stops: the
# recovery unit never runs and the API never starts.
#
# POSIX sh (dash). No `set -e`: every status is checked explicitly and
# every path ends in an explicit exit, so an unexpected failure can never
# silently become a success.

set -u

STATE_DIR=/var/lib/nova-api
LOCK_FILE=$STATE_DIR/startup-attempts.lock
COUNTER_CLI=/opt/nova-ai-studio/bin/startup-counter.mjs
ID_FILE=$STATE_DIR/startup-request-id
TAG=nova-startup-preparation

REQUEST_ID=

# log_event <event> <level> <windowStart> <detail>
# Canonical line (§10): ts level event requestId windowStart detail.
# requestId is always the id generated in step 1; windowStart is the
# counter window when the counter was read successfully, else none.
# detail is a single token (CLI reasons are encoded single tokens).
log_event() {
    _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '1970-01-01T00:00:00Z')
    logger -t "$TAG" "ts=$_ts level=$2 event=$1 requestId=${REQUEST_ID:-none} windowStart=$3 detail=$4"
}

# result_code <RESULT line> -> numeric code, or empty if not a RESULT line.
result_code() {
    printf '%s' "$1" | sed -n 's/^RESULT \([0-9][0-9]*\) .*/\1/p'
}

# result_json_string <RESULT line> <key> -> the string value, or empty.
# Matches "key":"value" (last occurrence wins for duplicate keys).
result_json_string() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# result_json_int <RESULT line> <key> -> the integer value, or empty.
result_json_int() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}

mkdir -p "$STATE_DIR" 2>/dev/null || true

# The counter lock file is flocked by root-side callers (this script,
# retry-startup.sh) AND by the API process (User=nova-api, reset path).
# flock creates the file on first open with the caller's umask, so a
# root-created 0660 root:root lock file is EACCES to the API and its
# post-listen reset fails (startup-recovery-counter-unwritable). Normalise
# it here, before any flock use: group nova-api, group-writable. Best
# effort; chmod on a locked file does not disturb the lock.
touch "$LOCK_FILE" 2>/dev/null || true
chgrp nova-api "$LOCK_FILE" 2>/dev/null || true
chmod 0660 "$LOCK_FILE" 2>/dev/null || true

# (1) Fresh UUID first, in memory (see header: the id must exist before
# any counter failure is logged, so the event carries a real requestId).
REQUEST_ID=$(node -e 'console.log(require("node:crypto").randomUUID())' 2>/dev/null) || REQUEST_ID=""
case "$REQUEST_ID" in
    ????????-????-4???-[89ab]???-????????????) ;;
    *)
        echo "prepare-startup-id: failed to generate a UUID with node" >&2
        exit 1
        ;;
esac

# (2) Count this chain attempt (single CLI call, under the lock).
flock_err=$(mktemp "$STATE_DIR/.prepare-flock-err.XXXXXX" 2>/dev/null || echo "")
if [ -n "$flock_err" ]; then
    prep_out=$(flock --verbose --exclusive --timeout 10 "$LOCK_FILE" node "$COUNTER_CLI" prepare 2>"$flock_err")
    flock_status=$?
else
    prep_out=$(flock --verbose --exclusive --timeout 10 "$LOCK_FILE" node "$COUNTER_CLI" prepare 2>/dev/null)
    flock_status=$?
fi
if [ "$flock_status" -ne 0 ]; then
    detail="flock-failed"
    if [ -n "$flock_err" ] && grep -q "timeout while waiting to get lock" "$flock_err" 2>/dev/null; then
        detail="lock-timeout"
    fi
    rm -f "$flock_err"
    log_event startup-preparation-counter-unreadable error none "$detail"
    exit 1
fi
rm -f "$flock_err"

code=$(result_code "$prep_out")
case "$code" in
    0)
        # Counter counted; fall through to the id write below.
        ;;
    2)
        reason=$(result_json_string "$prep_out" "reason")
        log_event startup-preparation-counter-malformed error none "${reason:-malformed}"
        exit 1
        ;;
    3)
        reason=$(result_json_string "$prep_out" "reason")
        log_event startup-preparation-counter-unwritable error none "${reason:-unwritable}"
        exit 1
        ;;
    5)
        reason=$(result_json_string "$prep_out" "reason")
        log_event startup-preparation-counter-unreadable error none "${reason:-unreadable}"
        exit 1
        ;;
    8)
        window_start=$(result_json_string "$prep_out" "windowStart")
        attempts=$(result_json_int "$prep_out" "attempts")
        log_event startup-preparation-limit-reached error "${window_start:-none}" "attempts-${attempts:-5}"
        exit 1
        ;;
    4)
        log_event startup-preparation-counter-unreadable error none "internal-error"
        exit 1
        ;;
    *)
        log_event startup-preparation-counter-unreadable error none "counter-no-result"
        exit 1
        ;;
esac

# (3) Write the fresh id atomically, then verify it by reading it back.
tmp_id=$(mktemp "$STATE_DIR/.startup-request-id.tmp.XXXXXX" 2>/dev/null) || {
    echo "prepare-startup-id: cannot create temp file in $STATE_DIR" >&2
    exit 1
}
printf '%s' "$REQUEST_ID" > "$tmp_id" || {
    rm -f "$tmp_id"
    echo "prepare-startup-id: cannot write temp id file" >&2
    exit 1
}
mv "$tmp_id" "$ID_FILE" || {
    rm -f "$tmp_id"
    echo "prepare-startup-id: cannot rename temp id file to $ID_FILE" >&2
    exit 1
}
# The id file must be readable by the API and recovery processes, which
# run as User=nova-api: mktemp creates 0600, and mv preserves it, so a
# root-written 0600 id file is unreadable to them (the recovery then reads
# requestId=none and verifyStartupReadiness fails on the id). The request
# id is a correlation id, not a credential (it appears in journal lines),
# and the counter file beside it is 0644 — match that.
chmod 0644 "$ID_FILE"
read_back=$(cat "$ID_FILE" 2>/dev/null) || read_back=""
if [ "$read_back" != "$REQUEST_ID" ]; then
    echo "prepare-startup-id: read-back of $ID_FILE does not match the generated id" >&2
    exit 1
fi

exit 0
