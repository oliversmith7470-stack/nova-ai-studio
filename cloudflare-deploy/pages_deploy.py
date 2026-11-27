#!/usr/bin/env python3
"""Direct-upload deploy of the NOVA index.html to Cloudflare Pages.

Flow (mirrors wrangler's pages deploy, verified against workers-sdk source):
  1. BLAKE3 hash of base64(file) + extension, first 32 hex chars.
  2. POST upload-token (API token) -> short-lived JWT.
  3. POST /pages/assets/check-missing (JWT).
  4. POST /pages/assets/upload (JWT) with base64 file, if missing.
  5. POST /pages/assets/upsert-hashes (JWT).
  6. POST deployments (API token), multipart manifest + branch=main.
     With --worker-file, the deployment form also carries a
     _worker.bundle field (Advanced Mode): a nested multipart body
     holding metadata {"main_module": "_worker.js"} plus the worker
     script as an application/javascript+module file part — the
     shape wrangler builds in create-worker-bundle-contents.ts.

Usage:
  pages_deploy.py <account_id> <project_name> <file> [--branch main]
                  [--worker-file _worker.js]

Prints the deployment JSON. Exits non-zero on any failed step.
"""

import base64
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.expanduser("~/.local/lib/python3.12/site-packages"))
sys.path.insert(0, os.path.expanduser(
    "~/workspace/custom-connectors/custom.cloudflare/bin"))
import blake3  # noqa: E402
from cf_api import build_multipart, build_multipart_mixed, call  # noqa: E402


def asset_hash(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    b64 = base64.b64encode(raw)
    ext = os.path.splitext(path)[1][1:]  # "html", no dot
    digest = blake3.blake3(b64 + ext.encode("ascii")).hexdigest()
    return digest[:32], b64.decode("ascii"), len(raw)


def build_worker_bundle(worker_path, extra_modules=None):
    """Build the _worker.bundle contents for an Advanced Mode deploy.

    Mirrors wrangler's createUploadWorkerBundleContents with no config:
    a nested multipart body with a metadata part
    {"main_module": "_worker.js"} (bindings deleted when no config)
    and the worker script as an ESM file part. Returns
    (inner_body_bytes, inner_content_type_header).

    extra_modules: list of (bundle_path, fs_path) — additional ESM
    modules the entry point imports by relative path. Each is added as
    a file part named by its bundle path so the Workers runtime can
    resolve the entry's relative imports. Without this, a relative
    import in _worker.js has nothing to resolve to and Cloudflare
    fails the deploy stage (proven 27 Nov 2026: round-3 _worker.js
    imports ./gpu-cloud/src/api-server/non-commercial-purposes.js;
    two deploys failed the deploy stage in ~1 s until the module was
    bundled alongside it).
    """
    with open(worker_path, "rb") as fh:
        worker_source = fh.read()
    parts = [
        {"name": "metadata",
         "data": json.dumps({"main_module": "_worker.js"})},
        {"name": "_worker.js", "filename": "_worker.js",
         "content_type": "application/javascript+module",
         "data": worker_source},
    ]
    for bundle_path, fs_path in (extra_modules or []):
        with open(fs_path, "rb") as fh:
            parts.append({"name": bundle_path, "filename": bundle_path,
                          "content_type": "application/javascript+module",
                          "data": fh.read()})
    inner_boundary = "----CloudflareWorkerBundle" + uuid.uuid4().hex
    inner_body, inner_ct = build_multipart_mixed(parts, inner_boundary)
    return inner_body, inner_ct


def require_ok(step, status, payload):
    if status >= 400 or not payload.get("success", False):
        print(f"FAILED at {step}: HTTP {status}")
        print(json.dumps(payload, indent=2))
        raise SystemExit(1)
    return payload.get("result")


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    account_id, project, filepath = argv[1], argv[2], argv[3]
    branch = "main"
    if "--branch" in argv:
        branch = argv[argv.index("--branch") + 1]
    worker_file = None
    if "--worker-file" in argv:
        worker_file = argv[argv.index("--worker-file") + 1]

    file_hash, b64, size = asset_hash(filepath)
    filename = os.path.basename(filepath)
    print(f"file: {filename} ({size} bytes)")
    print(f"asset hash: {file_hash}")

    # 1. upload token (API token auth; GET, no body)
    status, payload = call(
        "GET",
        f"/accounts/{account_id}/pages/projects/{project}/upload-token",
    )
    result = require_ok("upload-token", status, payload)
    jwt = result["jwt"]
    print("upload token: received")

    # 2. check missing (JWT auth)
    status, payload = call(
        "POST", "/pages/assets/check-missing",
        body={"hashes": [file_hash]}, jwt=jwt,
    )
    missing = require_ok("check-missing", status, payload)
    print(f"missing hashes: {missing}")

    # 3. upload asset if missing (JWT auth)
    if file_hash in missing:
        status, payload = call(
            "POST", "/pages/assets/upload",
            body=[{
                "key": file_hash,
                "value": b64,
                "metadata": {"contentType": "text/html"},
                "base64": True,
            }],
            jwt=jwt,
        )
        require_ok("assets/upload", status, payload)
        print("asset uploaded")
    else:
        print("asset already present, upload skipped")

    # 4. upsert hashes (JWT auth)
    status, payload = call(
        "POST", "/pages/assets/upsert-hashes",
        body={"hashes": [file_hash]}, jwt=jwt,
    )
    require_ok("upsert-hashes", status, payload)
    print("hashes upserted")

    # 5. create deployment (API token auth, multipart)
    manifest = json.dumps({"/" + filename: file_hash})
    if worker_file:
        bundle_body, bundle_ct = build_worker_bundle(worker_file)
        print(f"worker bundle: {len(bundle_body)} bytes "
              f"from {worker_file}")
        raw_body, content_type = build_multipart_mixed([
            {"name": "manifest", "data": manifest},
            {"name": "branch", "data": branch},
            {"name": "_worker.bundle", "filename": "_worker.bundle",
             "content_type": bundle_ct, "data": bundle_body},
        ], "----cfdeployboundary7d4f2a9c1e")
    else:
        raw_body, content_type = build_multipart([
            ("manifest", manifest),
            ("branch", branch),
        ])
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
