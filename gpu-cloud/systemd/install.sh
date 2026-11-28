#!/bin/sh
# Install the NOVA Phase 5 (Rev 4.8 §14/§19) systemd units and helper
# scripts on the API host, and the storage-runner unit.
#
# /etc is ephemeral on this VM: after a VM replacement the unit files and
# their enablement are gone, but this script and the unit files live in the
# workspace (which persists). Run this once after a replacement to
# restore supervision. Requires root (or sudo).
#
# What it installs (canonical source -> installed path; verbatim copies,
# never regenerated or transformed — §15 test (w) proves each installed
# copy byte-identical (sha256) to its canonical source, and this script
# verifies that itself after every copy):
#   Units (all required — a missing canonical source fails the install):
#     gpu-cloud/systemd/nova-api-server.service
#       -> /etc/systemd/system/nova-api-server.service (enabled, NOT started)
#     gpu-cloud/systemd/nova-storage-runner.service
#       -> /etc/systemd/system/nova-storage-runner.service (enabled + started)
#     gpu-cloud/systemd/nova-storage-recovery.service
#       -> /etc/systemd/system/nova-storage-recovery.service
#     gpu-cloud/systemd/nova-startup-id.service
#       -> /etc/systemd/system/nova-startup-id.service
#     gpu-cloud/systemd/nova-startup-retry.service
#       -> /etc/systemd/system/nova-startup-retry.service
#   Helper scripts (required):
#     gpu-cloud/systemd/prepare-startup-id.sh
#       -> /opt/nova-ai-studio/bin/prepare-startup-id.sh (0755)
#     gpu-cloud/systemd/retry-startup.sh
#       -> /opt/nova-ai-studio/bin/retry-startup.sh (0755)
#   Sibling-owned files (copied ONLY if their canonical source exists;
#   otherwise skipped with a warning — their owners deliver them):
#     gpu-cloud/systemd/nova-health-check.timer + nova-health-check.service
#       -> /etc/systemd/system/ (timer enabled, NOT started)
#     gpu-cloud/src/api-server/run-health-check.sh
#       -> /opt/nova-ai-studio/bin/run-health-check.sh (0755)
#     gpu-cloud/src/api-server/startup-counter.mjs
#       -> /opt/nova-ai-studio/bin/startup-counter.mjs (the counter CLI)
#       -> /opt/nova-ai-studio/src/api-server/startup-counter.mjs
#     gpu-cloud/src/api-server/startup-attempts.js
#       -> /opt/nova-ai-studio/src/api-server/startup-attempts.js
#     gpu-cloud/src/api-server/alert-dispatcher.js
#       -> /opt/nova-ai-studio/src/api-server/alert-dispatcher.js
#     gpu-cloud/src/api-server/health-check.js
#       -> /opt/nova-ai-studio/src/api-server/health-check.js
#     gpu-cloud/src/api-server/runner-heartbeat.js
#       -> /opt/nova-ai-studio/src/api-server/runner-heartbeat.js
#         (REQUIRED since Rev 4.9 F-6a — health-check.js imports it; a
#         missing module is a hard import failure of the probe)
#     gpu-cloud/src/api-server/flock-binding.mjs
#       -> /opt/nova-ai-studio/src/api-server/flock-binding.mjs
#     gpu-cloud/src/api-server/flock-binding.node (the compiled N-API
#       addon the loader requires; canonical source is flock-binding.cc,
#       rebuilt with build-flock-binding.sh — install.sh copies the
#       built artifact verbatim and PROVES it loads and locks on this
#       host before the dispatcher is installed, per the loader's own
#       fail-closed rule)
#       -> /opt/nova-ai-studio/src/api-server/flock-binding.node
#     gpu-cloud/src/storage-runner.js
#       -> /opt/nova-ai-studio/src/storage-runner.js (REQUIRED since
#         Rev 4.9 §6 — the real runner is a Phase 5 deliverable; a missing
#         source fails the install instead of being skipped)
#     gpu-cloud/src/storage/ (the storage package the runner imports)
#       -> /opt/nova-ai-studio/src/storage/ (REQUIRED since Rev 4.9 §6 —
#         the runner's relative imports resolve against
#         /opt/nova-ai-studio/src/, not the staged repo tree; every file
#         is sha256-verified after copy, same as install_file)
#     gpu-cloud/src/ (the whole tree, staged)
#       -> /opt/nova-ai-studio/gpu-cloud/src/ (REQUIRED since Rev 4.9 —
#         the API unit runs from the staged tree, so it MUST track the
#         canonical tree on every install; a stale staged tree is live
#         stale code and fails (w)'s diff)
#
# NOT installed here: no tunnel unit (none exists yet — out of scope). The
# API process tree (gpu-cloud/src/api-server.js and the rest of the repo)
# IS synced by this script into /opt/nova-ai-studio/gpu-cloud/src (see
# above) — the API unit's ExecStart
# (/opt/nova-ai-studio/gpu-cloud/src/api-server.js) runs from that staged
# tree. The API unit is enabled but never started by this script: starting
# it needs the
# nova-api user/group, /etc/nova-api/api.env, the repo tree, and the
# sibling modules, and activation itself is a separate authorised step.
#
# Fail-closed checks, run before anything is installed:
#   - node present (uuidgen is NOT required — UUIDs come from node).
#   - /etc/nova-api/api.env present with a valid NOVA_WORKER_ORIGIN
#     (Finding 11, ChatGPT Rev 4.9 review): the API unit's
#     EnvironmentFile is REQUIRED (no leading '-'), so the install
#     fails closed when the file is missing or the origin is missing,
#     empty, or not a valid http(s) URL. Presence + URL shape only —
#     the dev stub http://127.0.0.1:18099 passes; the real production
#     Worker origin is supplied by the owner (still outstanding) and
#     is NOT invented here.
#   - flock present; util-linux >= 2.37 (--conflict-exit-code exists).
#   - flock binding works: acquire -> contended acquire returns the
#     timeout result (exit 1) immediately -> release -> acquire succeeds;
#     killing a holder releases the lock.
#   - fd-form operational envelope (§10, Rev 4.8 F5-31): the fd is
#     genuinely open (guard against the closed-fd trap, where flock
#     silently treats the number as a filename); a contended acquisition
#     returns 99; an exec failure returns 69; the option set is present
#     (a bad option exits 64).
#     NOTE on the fd form as flock(1) implements it (util-linux 2.39.3):
#     the usage is `flock [options] <file descriptor number>` — the
#     fd form takes NO command. `flock ... 9 <command>` parses `9` as a
#     FILENAME (proven by strace: it opens a file literally named `9` in
#     the cwd, even with fd 9 open and inheritable). The envelope check
#     below therefore tests the true fd form: open fd 9, then
#     `flock --nonblock --conflict-exit-code 99 9` with no command — the
#     lock is then held on this shell's open fd 9 until `flock -u 9` or
#     the fd closes. The design's `flock 9 true` example and the
#     run-health-check.sh wrapper line (`flock ... 9 /usr/bin/node ...`)
#     do NOT test/use the fd form on this flock; see the implementation
#     report — the wrapper is the health-check owner's file.
#   - mail transport (sendmail check, Rev 4.7 F5-01, extended Rev 5.0
#     OQ-1): runs mailTransportReady() against the INSTALLED
#     alert-dispatcher.js — passes when a sendmail resolves on the API
#     unit's PATH (host MTA) OR api.env carries a complete SMTP config
#     (outside mail service, owner decision 28 Nov 2026). Deferred
#     (warning, not a failure) while the dispatcher module (or its
#     imports) have not been delivered yet. This check runs LAST —
#     after files are installed and units verified — because it is a
#     host-readiness gate, not a file-integrity gate; a host with no
#     mail transport still fails the install as a whole (non-zero
#     exit), but its units are in place.
#
# Usage: gpu-cloud/systemd/install.sh

set -eu

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
GPU_CLOUD_DIR="$(dirname "$SRC_DIR")"
REPO_ROOT="$(dirname "$GPU_CLOUD_DIR")"
API_SRC_DIR="$GPU_CLOUD_DIR/src/api-server"

BIN_DIR=/opt/nova-ai-studio/bin
MOD_DIR=/opt/nova-ai-studio/src/api-server
RUNNER_SRC_DIR=/opt/nova-ai-studio/src
SYSTEMD_DIR=/etc/systemd/system
STATE_DIR=/var/lib/nova-api

# systemd's default PATH — the API unit sets no PATH, so this is the PATH
# the sendmail check must use (Rev 4.7, F5-01).
SYSTEMD_DEFAULT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SKIPPED=""
HOLDER_PID=""
CHECK_TMP=""

fail() {
    echo "install.sh: FAIL: $*" >&2
    exit 1
}

warn() {
    echo "install.sh: WARNING: $*"
}

cleanup() {
    if [ -n "$HOLDER_PID" ]; then
        kill -9 "$HOLDER_PID" 2>/dev/null || true
        HOLDER_PID=""
    fi
    if [ -n "$CHECK_TMP" ] && [ -d "$CHECK_TMP" ]; then
        rm -rf "$CHECK_TMP"
    fi
}
trap cleanup EXIT

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh must run as root" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Prerequisite checks (fail-closed, before anything is installed)
# ---------------------------------------------------------------------------

echo "== prerequisite checks =="

command -v node >/dev/null 2>&1 || fail "node is not on PATH (required: UUIDs come from node, not uuidgen)"
[ -x /usr/bin/node ] || fail "/usr/bin/node is not executable"
echo "node: $(node --version)"

# Finding 11 (ChatGPT Rev 4.9 review): the API unit's EnvironmentFile is
# REQUIRED (no leading '-'), so the install fails closed when api.env is
# missing or NOVA_WORKER_ORIGIN is missing, empty, or not a valid
# http(s) URL. Presence + URL shape only — the dev stub
# http://127.0.0.1:18099 passes; the real production Worker origin is
# supplied by the owner (still outstanding) and is NOT invented here.
API_ENV=/etc/nova-api/api.env
[ -f "$API_ENV" ] || fail "api.env missing: $API_ENV — create it (NOVA_API_SECRET + NOVA_WORKER_ORIGIN) before installing; the API unit requires it (Finding 11)"
origin=$(sed -n 's/^NOVA_WORKER_ORIGIN=//p' "$API_ENV" | head -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
[ -n "$origin" ] || fail "NOVA_WORKER_ORIGIN missing or empty in $API_ENV"
case "$origin" in
    *[![:print:]]*|*[[:space:]]*) fail "NOVA_WORKER_ORIGIN contains whitespace in $API_ENV: '$origin'" ;;
esac
case "$origin" in
    http://?*|https://?*) ;;
    *) fail "NOVA_WORKER_ORIGIN is not a valid http(s) URL in $API_ENV: '$origin'" ;;
esac
echo "api.env: $API_ENV present; NOVA_WORKER_ORIGIN=$origin (shape OK)"

command -v flock >/dev/null 2>&1 || fail "flock is not on PATH"
[ -x /usr/bin/flock ] || fail "/usr/bin/flock is not executable"

# systemd-notify (Rev 4.9 §5): the API unit is Type=notify and the API
# process sends READY=1 via /usr/bin/systemd-notify --ready (NotifyAccess=all,
# the notification comes from the short-lived helper process). The binary
# must exist and be executable on the target host.
[ -x /usr/bin/systemd-notify ] || fail "/usr/bin/systemd-notify is not executable (required: Type=notify readiness)"
echo "systemd-notify: present ($(stat -c %s /usr/bin/systemd-notify) bytes)"

# util-linux >= 2.37 (--conflict-exit-code was introduced in 2.37).
flock_version_line=$(flock --version | head -n 1)
flock_version=$(printf '%s' "$flock_version_line" | sed -n 's/.*util-linux \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p')
if [ -z "$flock_version" ]; then
    fail "cannot parse util-linux version from: $flock_version_line"
fi
flock_major=${flock_version%%.*}
flock_minor=${flock_version##*.}
if [ "$flock_major" -lt 2 ] || { [ "$flock_major" -eq 2 ] && [ "$flock_minor" -lt 37 ]; }; then
    fail "flock util-linux $flock_version is too old: need >= 2.37 for --conflict-exit-code"
fi
echo "flock: $flock_version_line"

for opt in --nonblock --exclusive --timeout --verbose --conflict-exit-code; do
    flock --help | grep -qF -- "$opt" || fail "flock is missing option $opt"
done
echo "flock: option set present (--nonblock --exclusive --timeout --verbose --conflict-exit-code)"

# A bad option exits 64 (the value the wrapper treats as a ruled-out
# flock operational failure).
rc=0
flock --bogus-option-xyz /dev/null true 2>/dev/null || rc=$?
[ "$rc" -eq 64 ] || fail "flock: bad option exited $rc, expected 64"

# flock binding: acquire -> contended acquire returns the timeout result
# immediately -> release -> acquire succeeds; killing a holder releases
# the lock.
echo "flock: binding check (acquire / contended timeout / release / kill-holder)"
CHECK_TMP=$(mktemp -d) || fail "cannot create temp dir for flock checks"
BIND_LOCK="$CHECK_TMP/binding.lock"
flock --timeout 2 "$BIND_LOCK" true || fail "flock: free-lock acquire failed"
# Holder construction (load-bearing): the holder must be ONE process that
# both holds the lock and sleeps. `flock <file> sleep 30 &` does NOT work:
# killing the flock parent leaves its sleep child alive holding the
# inherited lock fd, so the lock is never released. Here the subshell
# locks its own fd 9 (`flock -x 9` locks and exits at once; the lock
# persists on the subshell's open fd 9) and then execs sleep, so the
# holder PID is the sleeper itself — killing it closes fd 9 and releases
# the lock.
( flock -x 9; sleep 30 ) 9>"$BIND_LOCK" &
HOLDER_PID=$!
sleep 0.5
start_ns=$(date +%s%N)
rc=0
flock --timeout 1 "$BIND_LOCK" true || rc=$?
end_ns=$(date +%s%N)
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
if [ "$rc" -ne 1 ]; then
    fail "flock: contended acquire exited $rc, expected 1 (timeout)"
fi
if [ "$elapsed_ms" -gt 3000 ]; then
    fail "flock: contended acquire took ${elapsed_ms}ms, expected an immediate timeout result"
fi
echo "flock: contended acquire returned 1 (timeout) in ${elapsed_ms}ms"
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
flock --timeout 2 "$BIND_LOCK" true || fail "flock: acquire after killing the holder failed"
echo "flock: killing the holder released the lock"
( flock -x 9; sleep 1 ) 9>"$BIND_LOCK" &
HOLDER_PID=$!
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
flock --timeout 2 "$BIND_LOCK" true || fail "flock: acquire after normal release failed"
echo "flock: binding check passed"

# fd-form operational envelope (§10, Rev 4.8 F5-31). The fd form as
# flock(1) implements it takes NO command: `flock [options] <fd>`. With a
# command present, the number is a filename — so the checks below use
# the no-command form, and the exec-failure case (69) uses the file form.
echo "flock: fd-form envelope check (fd open / contended 99 / exec failure 69)"
FD_LOCK="$CHECK_TMP/fd.lock"
# Open the lock file ONCE, on fd 9. The `if ! command exec` form is
# load-bearing: a bare `exec 9>>...` is a special built-in, and in dash a
# failed redirection on it kills the shell before any diagnostic; `command
# exec` runs exec as an ordinary built-in, so the failure is catchable.
# (This script is POSIX sh, and uses the same form for consistency with
# the wrapper.)
if ! command exec 9>>"$FD_LOCK"; then
    fail "fd form: cannot open lock file on fd 9"
fi
# The fd must genuinely be open: guard against the closed-fd trap, where
# flock silently treats the number as a filename and locks a stray file
# named `9` in the cwd instead.
if [ ! -e "/proc/$$/fd/9" ]; then
    exec 9>&- || true
    fail "fd form: fd 9 is not open after exec (closed-fd trap)"
fi
echo "flock: fd 9 genuinely open on $FD_LOCK"
# Free fd-form acquisition (no command): locks fd 9, exits 0; the lock is
# held on this shell's open fd 9 until `flock -u 9` or the fd closes.
if ! flock --nonblock --conflict-exit-code 99 9; then
    exec 9>&- || true
    fail "fd form: free acquisition failed"
fi
flock -u 9 || { exec 9>&- || true; fail "fd form: unlock failed"; }
# Contended fd-form acquisition returns 99. Holder: same one-process
# construction as the binding check (subshell locks its fd 9, then sleeps).
( flock -x 9; sleep 30 ) 9>"$FD_LOCK" &
HOLDER_PID=$!
sleep 0.5
rc=0
flock --nonblock --conflict-exit-code 99 9 || rc=$?
if [ "$rc" -ne 99 ]; then
    fail "fd form: contended acquisition exited $rc, expected 99"
fi
echo "flock: contended fd-form acquisition returned 99"
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
if ! flock --nonblock --conflict-exit-code 99 9; then
    exec 9>&- || true
    fail "fd form: free acquisition after holder death failed"
fi
flock -u 9 || { exec 9>&- || true; fail "fd form: unlock failed"; }
# Exec failure returns 69 (EX_UNAVAILABLE) — file form, nonexistent command.
rc=0
flock "$FD_LOCK" /nonexistent-command-xyz 2>/dev/null || rc=$?
if [ "$rc" -ne 69 ]; then
    exec 9>&- || true
    fail "flock: exec failure exited $rc, expected 69"
fi
echo "flock: exec failure returned 69"
exec 9>&- || true
echo "flock: fd-form envelope check passed"

rm -rf "$CHECK_TMP"
CHECK_TMP=""

# ---------------------------------------------------------------------------
# Install files (verbatim copies; sha256-verified after each copy)
# ---------------------------------------------------------------------------

echo "== installing files =="

# install_file <source> <dest> <mode> <required: yes|no>
install_file() {
    local src="$1" dest="$2" mode="$3" required="$4"
    if [ ! -f "$src" ]; then
        if [ "$required" = "yes" ]; then
            fail "canonical source missing: $src"
        fi
        warn "SKIP (not yet delivered by its owner): $src -> $dest"
        SKIPPED="${SKIPPED}  - $src -> $dest
"
        return 0
    fi
    mkdir -p "$(dirname "$dest")"
    # The API and runner units run as User=nova-api; the install dirs must
    # be traversable by that user regardless of this shell's umask (this
    # VM's umask is 0007, which makes mkdir -p create 0770 root:root dirs
    # that nova-api cannot enter — the units then fail with
    # MODULE_NOT_FOUND on files that plainly exist).
    chmod 0755 "$(dirname "$dest")"
    cp "$src" "$dest" || fail "copy failed: $src -> $dest"
    chmod "$mode" "$dest"
    local s d
    s=$(sha256sum "$src" | awk '{print $1}')
    d=$(sha256sum "$dest" | awk '{print $1}')
    if [ "$s" != "$d" ]; then
        fail "sha256 mismatch after copy: $src -> $dest"
    fi
    echo "installed (sha256 OK): $dest"
}

# Units (required).
install_file "$SRC_DIR/nova-api-server.service"      "$SYSTEMD_DIR/nova-api-server.service"      0644 yes
install_file "$SRC_DIR/nova-storage-runner.service"  "$SYSTEMD_DIR/nova-storage-runner.service"  0644 yes
install_file "$SRC_DIR/nova-storage-recovery.service" "$SYSTEMD_DIR/nova-storage-recovery.service" 0644 yes
install_file "$SRC_DIR/nova-startup-id.service"      "$SYSTEMD_DIR/nova-startup-id.service"      0644 yes
install_file "$SRC_DIR/nova-startup-retry.service"   "$SYSTEMD_DIR/nova-startup-retry.service"   0644 yes
# Health-check timer/service (sibling-owned; copy only if delivered).
install_file "$SRC_DIR/nova-health-check.timer"      "$SYSTEMD_DIR/nova-health-check.timer"      0644 no
install_file "$SRC_DIR/nova-health-check.service"    "$SYSTEMD_DIR/nova-health-check.service"    0644 no

# Helper scripts (required).
install_file "$SRC_DIR/prepare-startup-id.sh" "$BIN_DIR/prepare-startup-id.sh" 0755 yes
install_file "$SRC_DIR/retry-startup.sh"      "$BIN_DIR/retry-startup.sh"      0755 yes
# run-health-check.sh content is sibling-owned; install.sh only copies it.
install_file "$API_SRC_DIR/run-health-check.sh" "$BIN_DIR/run-health-check.sh" 0755 no

# Counter CLI (canonical source: gpu-cloud/src/api-server/startup-counter.mjs).
install_file "$API_SRC_DIR/startup-counter.mjs" "$BIN_DIR/startup-counter.mjs" 0644 no

# API-process modules (sibling-owned; copy only if delivered).
install_file "$API_SRC_DIR/startup-counter.mjs"  "$MOD_DIR/startup-counter.mjs"  0644 no
install_file "$API_SRC_DIR/startup-attempts.js"  "$MOD_DIR/startup-attempts.js"  0644 no
install_file "$API_SRC_DIR/alert-dispatcher.js" "$MOD_DIR/alert-dispatcher.js" 0644 no
install_file "$API_SRC_DIR/health-check.js"     "$MOD_DIR/health-check.js"     0644 no
# runner-heartbeat.js is imported by health-check.js (F-6a probe watch).
# REQUIRED: a missing module is a hard import failure of the probe.
install_file "$API_SRC_DIR/runner-heartbeat.js" "$MOD_DIR/runner-heartbeat.js" 0644 yes
install_file "$API_SRC_DIR/flock-binding.mjs"   "$MOD_DIR/flock-binding.mjs"   0644 no
install_file "$API_SRC_DIR/flock-binding.node"  "$MOD_DIR/flock-binding.node"  0755 no

# Storage runner (recovery unit's ExecStart; the runner unit itself is the
# hourly sweeper and the sole deleter). REQUIRED since Rev 4.9 §6: the real
# runner is a Phase 5 deliverable, and the install must fail closed when
# its source is missing — a skipped copy must never again be reported as an
# installed recovery path.
install_file "$GPU_CLOUD_DIR/src/storage-runner.js" "$RUNNER_SRC_DIR/storage-runner.js" 0644 yes

# Storage package the runner imports (its relative imports resolve against
# /opt/nova-ai-studio/src/, not the staged repo tree). REQUIRED since
# Rev 4.9 §6, for the same fail-closed reason as the runner itself.
install_dir() {
    local src_dir="$1" dest_dir="$2"
    if [ ! -d "$src_dir" ]; then
        fail "canonical source directory missing: $src_dir"
    fi
    mkdir -p "$dest_dir"
    chmod 0755 "$dest_dir"
    local f base s d
    for f in "$src_dir"/*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        cp "$f" "$dest_dir/$base" || fail "copy failed: $f -> $dest_dir/$base"
        chmod 0644 "$dest_dir/$base"
        s=$(sha256sum "$f" | awk '{print $1}')
        d=$(sha256sum "$dest_dir/$base" | awk '{print $1}')
        if [ "$s" != "$d" ]; then
            fail "sha256 mismatch after copy: $f -> $dest_dir/$base"
        fi
    done
    echo "installed (sha256 OK): $dest_dir/ ($(ls "$src_dir" | wc -l) files)"
}
install_dir "$GPU_CLOUD_DIR/src/storage" "$RUNNER_SRC_DIR/storage"

# Staged repo tree — the API unit runs from here
# (/opt/nova-ai-studio/gpu-cloud/src/api-server.js), so the staged tree
# MUST track the canonical gpu-cloud/src tree on every install. Before
# Rev 4.9 this tree was staged once by hand (cp -a) and never re-synced,
# so later repo edits (e.g. the §1 flock-signal diagnostic) left the LIVE
# code stale and (w)'s staged-tree diff failed. Sync it here (copy +
# perms + diff -rq verification, fail-closed on any difference).
STAGED_DIR=/opt/nova-ai-studio/gpu-cloud/src
mkdir -p "$STAGED_DIR"
cp -a "$GPU_CLOUD_DIR/src/." "$STAGED_DIR/" || fail "staged-tree sync failed: $GPU_CLOUD_DIR/src -> $STAGED_DIR"
find "$STAGED_DIR" -type d -exec chmod 0755 {} +
find "$STAGED_DIR" -type f -exec chmod 0644 {} +
find "$STAGED_DIR" -type f -name '*.sh' -exec chmod 0755 {} +
diff -rq "$GPU_CLOUD_DIR/src" "$STAGED_DIR" >/dev/null || fail "staged-tree sync verification failed: $STAGED_DIR differs from $GPU_CLOUD_DIR/src"
echo "staged tree synced: $STAGED_DIR (diff -rq clean)"
# Top-level install dirs (Rev 4.8 §4/M2-P): mkdir -p under this VM's
# umask 0007 creates /opt/nova-ai-studio and /opt/nova-ai-studio/gpu-cloud
# as 0770 root:root, and the find above chmods only dirs UNDER the staged
# dir — so the two parents stay untraversable by User=nova-api and the
# API unit fails with MODULE_NOT_FOUND on files that plainly exist. The
# same gap applies to the install_file chmod of each file's parent dir
# (it never reaches the top two). Fix explicitly, before systemd reload.
chmod 0755 /opt/nova-ai-studio /opt/nova-ai-studio/gpu-cloud
echo "top install dirs: /opt/nova-ai-studio /opt/nova-ai-studio/gpu-cloud (0755)"

# Dash syntax check on every installed shell script.
for script in "$BIN_DIR/prepare-startup-id.sh" "$BIN_DIR/retry-startup.sh"; do
    sh -n "$script" || fail "dash syntax check failed: $script"
done
if [ -f "$BIN_DIR/run-health-check.sh" ]; then
    sh -n "$BIN_DIR/run-health-check.sh" || fail "dash syntax check failed: $BIN_DIR/run-health-check.sh"
fi
echo "sh -n: installed shell scripts pass"

# Native flock binding check: the dispatcher imports flock-binding.mjs,
# which requires ./flock-binding.node at import time (fail-closed by
# design — a dispatcher that cannot lock must never run). Prove the
# installed binding loads AND locks on this host before the dispatcher
# is installed: exclusive acquire, contended acquire refuses, unlock,
# re-acquire. Deferred (warning) while the binding files are absent.
if [ -f "$MOD_DIR/flock-binding.mjs" ] && [ -f "$MOD_DIR/flock-binding.node" ]; then
    bind_test=$(mktemp /tmp/flock-binding-test.XXXXXX.mjs) || fail "cannot create temp file for binding check"
    bind_lock=$(mktemp /tmp/flock-binding-lock.XXXXXX) || fail "cannot create temp file for binding check"
    cat > "$bind_test" <<'NODEEOF'
import { openSync, closeSync } from 'node:fs';
const { flockExNb, flockUn } = await import(process.argv[2]);
const lockPath = process.argv[3];
const f1 = openSync(lockPath, 'w');
const f2 = openSync(lockPath, 'w');
if (flockExNb(f1) !== true) throw new Error('first acquire failed');
if (flockExNb(f2) !== false) throw new Error('contended acquire did not refuse');
flockUn(f1);
if (flockExNb(f2) !== true) throw new Error('re-acquire after unlock failed');
flockUn(f2);
closeSync(f1); closeSync(f2);
console.log('flock-binding: ok');
NODEEOF
    if ! node "$bind_test" "$MOD_DIR/flock-binding.mjs" "$bind_lock"; then
        rm -f "$bind_test" "$bind_lock"
        fail "native flock binding failed to load or lock on this host (see above); rebuild with gpu-cloud/src/api-server/build-flock-binding.sh"
    fi
    rm -f "$bind_test" "$bind_lock"
    echo "flock-binding: loads and locks (acquire / contended-refuse / unlock / re-acquire)"
else
    warn "flock-binding check DEFERRED: flock-binding.mjs / flock-binding.node not yet delivered by their owner; the dispatcher cannot load without them"
fi

# ---------------------------------------------------------------------------
# State directory
# ---------------------------------------------------------------------------

mkdir -p "$STATE_DIR"
if getent group nova-api >/dev/null 2>&1; then
    chown root:nova-api "$STATE_DIR"
    chmod 0770 "$STATE_DIR"
    echo "state dir: $STATE_DIR (root:nova-api 0770 — the API process must be able to unlink the attempt counter on reset)"
    # Counter lock file: flocked by root-side callers (prepare/retry
    # scripts) AND by the API process (User=nova-api, reset path). A
    # root-created 0660 root:root lock file is EACCES to the API and its
    # post-listen reset fails — so the lock file is created here with
    # group nova-api, group-writable. (The root scripts also normalise
    # it before each flock use, in case it was deleted and recreated.)
    touch "$STATE_DIR/startup-attempts.lock"
    chown root:nova-api "$STATE_DIR/startup-attempts.lock"
    chmod 0660 "$STATE_DIR/startup-attempts.lock"
    # Index lock file (Finding 10C): the storage index lock
    # ($STATE_DIR/store/index.lock) is flocked by the API process
    # (User=nova-api) AND by the storage runner (same user). Pre-create
    # it here as root:nova-api 0660, mirroring the counter lock — a
    # root-created 0660 root:root lock file would be EACCES to the API
    # (the index code falls back to a read-only fd, but the pre-created
    # file avoids depending on that fallback).
    mkdir -p "$STATE_DIR/store"
    chown root:nova-api "$STATE_DIR/store"
    chmod 0770 "$STATE_DIR/store"
    touch "$STATE_DIR/store/index.lock"
    chown root:nova-api "$STATE_DIR/store/index.lock"
    chmod 0660 "$STATE_DIR/store/index.lock"
    echo "index lock: $STATE_DIR/store/index.lock (root:nova-api 0660)"
else
    chmod 0755 "$STATE_DIR"
    warn "group nova-api does not exist: $STATE_DIR left root-owned 0755; create the nova-api user/group on the target host before first start (the API process runs as User=nova-api and must be able to unlink the attempt counter)"
fi

# ---------------------------------------------------------------------------
# systemd: reload, enable, verify
# ---------------------------------------------------------------------------

systemctl daemon-reload

# The API unit is enabled but NOT started: starting it needs the nova-api
# user/group, /etc/nova-api/api.env, the repo tree at /opt/nova-ai-studio,
# and the sibling modules — and activation itself is a separate
# authorised step.
systemctl enable nova-api-server.service

if [ -f "$SYSTEMD_DIR/nova-health-check.timer" ]; then
    systemctl enable nova-health-check.timer
    warn "health-check timer enabled but NOT started (the probe needs the sibling modules; start it once they are installed)"
fi

# The storage runner keeps its existing behaviour: enabled and started.
systemctl enable --now nova-storage-runner.service
systemctl status nova-storage-runner.service --no-pager

# systemd-analyze verify on every installed unit in scope (output is
# reported verbatim; a non-zero exit fails the install).
for unit in nova-api-server nova-storage-recovery nova-startup-id nova-startup-retry nova-storage-runner; do
    echo "--- systemd-analyze verify $unit.service ---"
    systemd-analyze verify "$SYSTEMD_DIR/$unit.service" || fail "systemd-analyze verify failed for $unit.service"
done
if [ -f "$SYSTEMD_DIR/nova-health-check.service" ]; then
    echo "--- systemd-analyze verify nova-health-check.service ---"
    systemd-analyze verify "$SYSTEMD_DIR/nova-health-check.service" || fail "systemd-analyze verify failed for nova-health-check.service"
fi
if [ -f "$SYSTEMD_DIR/nova-health-check.timer" ]; then
    echo "--- systemd-analyze verify nova-health-check.timer ---"
    systemd-analyze verify "$SYSTEMD_DIR/nova-health-check.timer" || fail "systemd-analyze verify failed for nova-health-check.timer"
fi

# ---------------------------------------------------------------------------
# sendmail check (Rev 4.7, F5-01; extended Rev 5.0, OQ-1): mailTransportReady()
# against the INSTALLED alert-dispatcher.js, on the API unit's PATH.
# Passes when EITHER a sendmail resolves (host MTA) OR api.env carries a
# complete SMTP config (NOVA_ALERT_SMTP_HOST/USER/PASS — the outside mail
# service the owner chose 28 Nov 2026). Fails if neither is ready.
# Deferred while the dispatcher module or its imports have not been
# delivered yet.
#
# ORDERING (deliberate, and the design does not fix an order): this check
# runs LAST, after files are installed and units are verified. It is a
# host-readiness gate, not a file-integrity gate. A host with no mail
# transport still gets its units installed and verified, but the install
# as a whole FAILS here (non-zero exit, exact reason below) — never a
# silent pass. On the target host the MTA must be installed (or the SMTP
# config added to api.env) first; a re-run then passes cleanly (all
# copies are idempotent).
# ---------------------------------------------------------------------------

if [ -f "$MOD_DIR/alert-dispatcher.js" ] && [ -f "$MOD_DIR/flock-binding.mjs" ] && [ -f "$MOD_DIR/startup-counter.mjs" ]; then
    # SMTP config for the mail check comes from api.env (the same file the
    # API unit reads as its EnvironmentFile). Values are passed through the
    # environment only for this check and are never echoed.
    smtp_host=$(sed -n 's/^NOVA_ALERT_SMTP_HOST=//p' "$API_ENV" | head -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
    smtp_user=$(sed -n 's/^NOVA_ALERT_SMTP_USER=//p' "$API_ENV" | head -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
    smtp_pass=$(sed -n 's/^NOVA_ALERT_SMTP_PASS=//p' "$API_ENV" | head -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
    mail_err=$(mktemp) || fail "cannot create temp file for mail transport check"
    if mail_out=$(PATH="$SYSTEMD_DEFAULT_PATH" NOVA_ALERT_SMTP_HOST="$smtp_host" NOVA_ALERT_SMTP_USER="$smtp_user" NOVA_ALERT_SMTP_PASS="$smtp_pass" node --input-type=module -e "import { mailTransportReady } from '$MOD_DIR/alert-dispatcher.js'; const r = mailTransportReady(); console.log(r.ok ? r.via + ':' + r.detail : 'none:' + r.reason); process.exit(r.ok ? 0 : 1);" 2>"$mail_err"); then
        mail_rc=0
    else
        mail_rc=$?
    fi
    if [ "$mail_rc" -ne 0 ]; then
        mail_detail=$(cat "$mail_err" 2>/dev/null | head -n 3 | tr '\n' ' ')
        rm -f "$mail_err"
        fail "mail transport check: no mail transport ready — no executable sendmail on the API unit's PATH $SYSTEMD_DEFAULT_PATH and no complete SMTP config (NOVA_ALERT_SMTP_HOST/USER/PASS) in $API_ENV; check error: ${mail_detail:-unknown}"
    fi
    rm -f "$mail_err"
    echo "mail transport: $mail_out"
else
    warn "sendmail check DEFERRED: alert-dispatcher.js (or its imports flock-binding.mjs / startup-counter.mjs) not yet delivered by its owner; this check will run — and fail closed — once the module lands"
fi

echo "== install complete =="
echo "Installed units: nova-api-server (enabled, NOT started), nova-storage-runner (enabled + started), nova-storage-recovery, nova-startup-id, nova-startup-retry."
echo "Installed scripts: /opt/nova-ai-studio/bin/prepare-startup-id.sh, /opt/nova-ai-studio/bin/retry-startup.sh."
if [ -n "$SKIPPED" ]; then
    echo "Skipped (not yet delivered by their owners):"
    printf '%s' "$SKIPPED"
fi
echo "Note: the API unit is installed but not started and production is NOT activated (activation flags default false; activation is a separate authorised step)."
