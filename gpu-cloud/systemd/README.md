# Storage runner supervision

The GPU Cloud storage runner (`node scripts/run-gpu-cloud.mjs`) tends the
live store at `gpu-cloud/data/store/`: it runs an expiry sweep at boot and
then hourly. It must stay up — while it is down, expired objects are not
freed (expiry is still enforced lazily on read, but disk space is only
recovered when a sweep runs).

## Service

- Unit: `nova-storage-runner.service`
- Persistent unit file: `systemd/nova-storage-runner.service` (this directory)
- Live unit file: `/etc/systemd/system/nova-storage-runner.service`
- Enabled at boot (`WantedBy=multi-user.target`), `Restart=always`,
  `RestartSec=10`.
- Logs: `journalctl -u nova-storage-runner -n 100`
- Status: `systemctl status nova-storage-runner`
- Stop (admin only): `systemctl stop nova-storage-runner`

## Why a system unit, not a user unit

`systemctl --user` does not work on this VM (no user bus:
"Failed to connect to bus: No medium found"; loginctl unusable, no
lingering). The system bus works (PID 1 is systemd), so the service is a
system unit running as root — the same user that owns the workspace files.

## VM replacement

`/etc` is ephemeral: a VM replacement wipes the installed unit and its
enablement. The unit file and `install.sh` live in the workspace, which
persists. After a replacement, run once (as root):

```
gpu-cloud/systemd/install.sh
```

That restores the unit, enables it, and starts it. Auto-start after a VM
replacement is therefore a one-command recovery, not automatic — nothing
on this VM can reinstall itself after a replacement.

## Restart behaviour

`Restart=always` (deliberate, not the Oliver example's `on-failure`):
the runner's SIGTERM handler exits 0, so `on-failure` would not restart
it after a SIGTERM reap. Verified 24 Nov 2026: SIGKILL and SIGTERM both
restart the service within ~10s, the sweep resumes, and the stored
object survives intact.
