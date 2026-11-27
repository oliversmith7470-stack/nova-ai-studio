#!/usr/bin/env python3
"""Multi-file direct-upload deploy to Cloudflare Pages.

Generalised from pages_deploy.py (single-file uploader, proven 23-25 Nov
2026). Reuses its asset_hash, build_worker_bundle, require_ok and the
cf_api.call helpers. Deploys a fixed file list from a git-archive extract
dir: /index.html, /about.html, /assets/js/main.js,
/assets/about/owner-photo.jpg, plus _worker.js as the _worker.bundle
(Advanced Mode). Touches no environment variables and no D1.

Usage:
  pages_deploy_multi.py <account_id> <project_name> <extract_dir>
                        [--branch main]

Prints the deployment JSON. Exits non-zero on any failed step.
"""

import json
import os
import sys

sys.path.insert(0, os.path.expanduser(
    "~/workspace/nova-ai-studio/cloudflare-deploy"))
sys.path.insert(0, os.path.expanduser(
    "~/workspace/custom-connectors/custom.cloudflare/bin"))
sys.path.insert(0, os.path.expanduser("~/.local/lib/python3.12/site-packages"))

from pages_deploy import asset_hash, build_worker_bundle, require_ok  # noqa: E402
from cf_api import build_multipart_mixed, call  # noqa: E402

FILES = [
    ("index.html", "/index.html", "text/html"),
    ("about.html", "/about.html", "text/html"),
    ("assets/js/main.js", "/assets/js/main.js", "application/javascript"),
    ("assets/about/owner-photo.jpg", "/assets/about/owner-photo.jpg",
     "image/jpeg"),
]


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    account_id, project, extract = argv[1], argv[2], argv[3]
    branch = "main"
    if "--branch" in argv:
        branch = argv[argv.index("--branch") + 1]

    # 0. hash all files from the extract dir
    entries = []  # (deploy_path, hash, b64, content_type)
    for rel, deploy_path, ctype in FILES:
        h, b64, size = asset_hash(os.path.join(extract, rel))
        print(f"{deploy_path}: {size} bytes, hash {h}")
        entries.append((deploy_path, h, b64, ctype))

    # 1. upload token (API token auth; GET, no body)
    status, payload = call(
        "GET",
        f"/accounts/{account_id}/pages/projects/{project}/upload-token",
    )
    jwt = require_ok("upload-token", status, payload)["jwt"]
    print("upload token: received")

    # 2. check missing (JWT auth)
    hashes = [h for _, h, _, _ in entries]
    status, payload = call(
        "POST", "/pages/assets/check-missing",
        body={"hashes": hashes}, jwt=jwt,
    )
    missing = require_ok("check-missing", status, payload)
    print(f"missing hashes: {missing}")

    # 3. upload missing assets (JWT auth)
    to_upload = [e for e in entries if e[1] in missing]
    if to_upload:
        status, payload = call(
            "POST", "/pages/assets/upload",
            body=[{
                "key": h,
                "value": b64,
                "metadata": {"contentType": ct},
                "base64": True,
            } for _, h, b64, ct in to_upload],
            jwt=jwt,
        )
        require_ok("assets/upload", status, payload)
        print(f"uploaded {len(to_upload)} asset(s)")
    else:
        print("all assets already present, upload skipped")

    # 4. upsert hashes (JWT auth)
    status, payload = call(
        "POST", "/pages/assets/upsert-hashes",
        body={"hashes": hashes}, jwt=jwt,
    )
    require_ok("upsert-hashes", status, payload)
    print("hashes upserted")

    # 5. create deployment (API token auth, multipart manifest + branch
    #    + _worker.bundle)
    manifest = json.dumps({p: h for p, h, _, _ in entries})
    # The bundle is a single ESM module by default, so a relative import
    # in _worker.js has nothing to resolve to and Cloudflare fails the
    # deploy stage. Scan the entry for relative imports and include each
    # resolved file as an additional bundle module at its relative path.
    # Fail loudly (before creating the deployment) if one cannot be
    # resolved from the extract.
    import re
    worker_src = open(os.path.join(extract, "_worker.js"),
                      encoding="utf-8").read()
    extra_modules = []
    for spec in sorted(set(re.findall(
            r"""from\s+["'](\./[^"']+)["']""", worker_src))):
        rel = spec[2:]  # strip "./"
        fs_path = os.path.join(extract, rel)
        if not os.path.isfile(fs_path):
            print(f"FAILED: _worker.js imports {spec} but {fs_path} "
                  "is not in the extract")
            return 1
        extra_modules.append((rel, fs_path))
        print(f"bundle module: {rel}")
    bundle_body, bundle_ct = build_worker_bundle(
        os.path.join(extract, "_worker.js"), extra_modules=extra_modules)
    print(f"worker bundle: {len(bundle_body)} bytes")
    raw_body, content_type = build_multipart_mixed([
        {"name": "manifest", "data": manifest},
        {"name": "branch", "data": branch},
        {"name": "_worker.bundle", "filename": "_worker.bundle",
         "content_type": bundle_ct, "data": bundle_body},
    ], "----cfdeployboundary7d4f2a9c1e")
    status, payload = call(
        "POST",
        f"/accounts/{account_id}/pages/projects/{project}/deployments",
        raw_body=raw_body, content_type=content_type,
    )
    deployment = require_ok("create deployment", status, payload)
    print("deployment created:")
    print(json.dumps(deployment, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
