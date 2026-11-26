#!/bin/sh
# Runs the health-check probe under a non-blocking lock. A run that finds the lock
# held exits 0 and logs the skip — the next timer run picks the work up.
# Contention is detected by flock's EXIT CODE, not by grepping its stderr
# (Rev 4.7, F5-17): --conflict-exit-code 99 makes flock exit 99 when the lock
# cannot be acquired. The probe's stderr is NOT redirected to a shared temp file
# — it inherits the wrapper's stderr (the service's journal). The wrapper
# preserves the probe's exit status exactly (Rev 4.7, F5-18): any code other
# than 99 is the probe's own status and is returned unchanged. Requires
# util-linux >= 2.37 (the option's introduction); install.sh verifies the
# option exists. Flock behavior verified on the dev VM 26 Nov 2026
# (util-linux 2.39.3): held lock -> 99; free lock -> 0. The fd form takes NO
# command: `flock --nonblock --conflict-exit-code 99 9` locks the already-open
# fd 9 and exits, and the lock stays held on this shell's open fd 9 until the
# fd closes. With a command present, util-linux 2.39.3 parses `9` as a
# FILENAME (a file literally named `9` was created in the cwd) — so the probe
# is NEVER passed to flock; it runs as a separate command below while fd 9
# stays open, and its exit status is preserved exactly (a stub probe exiting
# 7 passes through as 7). That verifies flock's behavior, NOT the final
# wrapper: the final wrapper script must pass the same tests at install time
# (including the single-descriptor open failure path), and the seven-day
# standing health check, tunnel connectivity, public health-check access, and
# VM-replacement recovery remain M2 acceptance gates — requirements, not
# completed results.
# Wrapper infrastructure failures (Rev 4.8, F5-31) are a DISTINCT,
# machine-readable diagnostic, not a probe exit 1: the wrapper checks the
# flock binary is executable, then opens the lock file ONCE on fd 9 (see the
# `command exec` note below) BEFORE invoking flock; either failure logs the
# canonical line health-check-wrapper-failed and exits 2. The lock is then
# held on that already-open descriptor, so a flock failure after a passing
# open can only be contention (99). Exit-code contract: 0 = probe ok /
# contention skip; 1 = the probe's own failure status (the probe exits ONLY 0
# or 1 — see its exit contract in health-check.js; the wrapper preserves any
# exit status exactly); 2 = wrapper infrastructure failure; 99 = lock contention
# (RESERVED: the probe NEVER exits 99, enforced by §15 test (y) — a probe exit
# of 99 is therefore impossible, not merely unlikely; the probe never exits 2
# either, same enforcement). Exit 69 (flock's exec-failure code) CANNOT occur
# from flock in the no-command fd form — flock never execs anything — so it is
# not part of the live contract; the dispatch branch below is retained only as
# a guard, and the node/probe pre-checks above are the launch guard. --verbose
# is dropped: contention is detected by exit code 99 and nothing consumes
# flock's verbose output. Four-way distinction (Rev 4.8, F5-31 — chunk-10
# review): the wrapper distinguishes lock contention (flock exit 99 → overlap,
# exit 0), failure to operate flock (the binary check, the fd-9 open, and any
# other non-zero flock exit → health-check-wrapper-failed, exit 2), failure to
# launch the probe (node binary / probe script pre-checks →
# health-check-wrapper-failed, exit 2), and the probe's own exit status (0 or
# 1 → passed through unchanged). The fd form is only safe because fd 9 is
# genuinely open: flock with a closed fd silently treats the number as a
# FILENAME (verified on this VM 26 Nov 2026: `flock 9 /bin/true` with fd 9
# closed created a file literally named `9` in the cwd and exited 0) — so the
# immediately preceding `command exec` success is the guarantee the fd is
# open, and install.sh verifies the full operational envelope before
# installing the wrapper (the fd form with no command, a contended
# acquisition returning 99, an exec failure returning 69 in the FILE form,
# and the option set).
set -u
LOCK=/var/lib/nova-api/health-check.lock
if [ ! -x /usr/bin/flock ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=flock-binary-missing"
  exit 2
fi
# Open the lock file ONCE, on fd 9, and use that same descriptor for flock.
# There is NO separate preflight open: the old `: >> "$LOCK"` check and the
# later `exec 9>>"$LOCK"` were two opens with a gap between them, and the
# second could still fail. The `command` prefix is load-bearing: a bare
# `exec 9>>...` is a special built-in, and in dash (/bin/sh) a failed
# redirection on a special built-in kills the shell before any diagnostic can
# be written (verified on this VM 26 Nov 2026: `if ! exec 9>>/bad` exits
# immediately with no diagnostic branch taken). `command exec` runs exec as an
# ordinary built-in, so the failure is catchable and the canonical
# health-check-wrapper-failed line is written before exit 2. Do NOT add
# `2>/dev/null` to this line: exec redirections persist in the shell, and it
# would redirect the probe's stderr away from the journal.
if ! command exec 9>>"$LOCK"; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=lock-file-unopenable"
  exit 2
fi
# Launch prerequisites, checked BEFORE flock so a failure to launch the probe
# is a wrapper infrastructure failure (exit 2), never mistaken for a probe
# failure: the node binary must be executable and the probe script readable.
# (If either vanishes between this check and the exec, node exits 1 and the
# run is reported as a probe failure — the timer retries it; that residual
# window is a filesystem failure, not a wrapper misclassification.) The
# pre-check catches a steady-state misconfiguration (a botched install, a
# deleted file) — it does not eliminate the permission/file-change race
# between the check and Node opening the script. install.sh verifies node and
# the probe script are present before installing the wrapper, so the
# pre-checks are a second layer, not the only one.
if [ ! -x /usr/bin/node ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=node-binary-missing"
  exit 2
fi
if [ ! -r /opt/nova-ai-studio/src/api-server/health-check.js ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=probe-script-unreadable"
  exit 2
fi
/usr/bin/flock --nonblock --conflict-exit-code 99 9
code=$?
if [ "$code" -eq 99 ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=warn event=health-check-skipped-overlap requestId=none windowStart=none detail=probe-already-running"
  exit 0
fi
if [ "$code" -ne 0 ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=flock-failed"
  exit 2
fi
/usr/bin/node /opt/nova-ai-studio/src/api-server/health-check.js
code=$?
# Exit-code dispatch (Rev 4.8, F5-31 — the four outcomes are distinguished by
# construction, not assumed): 99 is contention (above); 69 is flock's own
# failure to execute the probe (util-linux flock exits 69, EX_UNAVAILABLE,
# when the exec fails — verified on this VM 26 Nov 2026 with a missing
# command) — a wrapper infrastructure failure, exit 2. NOTE (26 Nov 2026
# fix): with the no-command fd form above, flock never execs anything, so
# exit 69 CANNOT occur from flock — the branch below is retained only as a
# guard. The guard that replaces it is the node/probe pre-checks above (node
# binary executable, probe script readable); if either vanishes between the
# check and the exec, node exits 1 and the run is reported as a probe
# failure — the timer retries it. 0 or 1 is the probe's own status (the probe
# exits ONLY 0 or 1 — see its exit contract) and passes through unchanged. Any OTHER code can only come from the probe dying abnormally
# (a node-internal failure or a signal death — the probe itself failed), or
# from a flock operational failure install.sh rules out (a bad option exits
# 64; install.sh verifies the option set before installing) — it passes
# through unchanged as a non-zero failure, and the timer retries it; it is
# never reported as success and never converted to exit 2. install.sh verifies
# the full operational envelope before installing: the fd form with no command
# (`flock 9` under an open fd), a contended acquisition returning 99, an exec
# failure returning 69 in the FILE form (the wrapper itself never execs), and
# the option set (a bad option exits 64). The one residual a
# code cannot distinguish is a flock(2) operational failure other than
# contention on a valid open fd (e.g. an interrupted syscall): flock exits 1
# with its own stderr line, which the wrapper reports as a probe failure
# (exit 1) — indistinguishable by code, distinguishable in the journal by
# flock's message, and the outcome is identical either way (exit 1, timer
# retries in 5 min).
if [ "$code" -eq 69 ]; then
  logger -t nova-health-check "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) level=error event=health-check-wrapper-failed requestId=none windowStart=none detail=probe-launch-failed"
  exit 2
fi
exit "$code"
