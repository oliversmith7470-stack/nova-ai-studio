# VM Recovery Checklist — NOVA GPU Cloud + NOVA AI Studio

**Purpose:** what to restore after a VM replacement. The home directory
(`~/workspace`, `~/.kaggle`, unit-file copies) survives; `/etc`,
running processes and system services do not.

## 1. Storage runner supervision (do first — the store is untended until this runs)

```bash
sudo ~/workspace/nova-ai-studio/gpu-cloud/systemd/install.sh
systemctl is-active nova-storage-runner
systemctl is-enabled nova-storage-runner
```

Then verify the store object is intact:

```bash
sha256sum ~/workspace/nova-ai-studio/gpu-cloud/data/store/chunks/outputs/*/*/0.chunk
```

Compare against the index (`gpu-cloud/data/store/index.json`) and the
evidence record. The service runs an initial sweep on boot — check the
journal: `journalctl -u nova-storage-runner -n 50`.

## 2. Workspace state (should be intact — verify, don't assume)

- `~/workspace/nova-ai-studio/` — NOVA code, A2 implementation, GPU Cloud.
- `~/workspace/nexora-ai/` — NEXORA code + `.env` (keys live here only).
- `~/.kaggle/access_token` — Kaggle API token (chmod 600).
- `git -C ~/workspace/nova-ai-studio status --short` and
  `git -C ~/workspace/nexora-ai status --short` — confirm no work lost.

## 3. Long-running work (check, don't restart blindly)

- Kaggle kernels run on Kaggle's side — check status, never re-push a
  running kernel: `kaggle kernels status <slug>`.
- The Wan proof subagent and S13 subagent are runtime-managed — check
  with the parent agent, don't duplicate them.
- Cron jobs and scheduled watches are runtime-managed — verify with
  `cron.list`, don't recreate them.

## 4. Credentials and connections

- Cloudflare API token: verify with
  `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_api.py GET /user/tokens/verify`.
- Browser sessions (ChatGPT reviewer threads, Kaggle web editor) may
  need a fresh sign-in — prefer resuming an existing window over a new
  one; hand sign-in only, saved passwords are stale.

## 5. Record the recovery

Note the date, what was restored, and any state that did not survive
in `~/MEMORY.md` and the relevant goal notes. A VM replacement is a
recovery event, not a fresh start — nothing already delivered is
re-done without a reason.
