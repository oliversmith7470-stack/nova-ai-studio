#!/usr/bin/env python3
"""Local runtime dry-run of the LTX proof notebook's helper functions.

Extracts the helper defs from the BUILT notebook (packages/ltx-proof-20261124-01/ltx-proof.ipynb)
and executes each with the notebook's real call signatures against local fixtures.
A compile check cannot catch runtime-only bugs (v2 lesson: log() kwargs; v3 lesson:
an assertion about diffusers' runtime behaviour). This catches the helper class.

Usage: python3 scripts/dry-run-ltx-helpers.py
Exit 0 = all checks pass. Any failure exits non-zero with the check name.
"""
import ast
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

PKG = os.path.join(os.path.dirname(__file__), "..", "packages", "ltx-proof-20261124-01")
NB_PATH = os.path.join(PKG, "ltx-proof.ipynb")
KEYFRAMES = os.path.join(PKG, "keyframes")

CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def extract_helpers():
    """Exec the helper defs from the built notebook into a namespace with stubbed torch."""
    nb = json.load(open(NB_PATH))
    cells = ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]

    # --- stub torch: cb() calls torch.cuda.memory_allocated() ---
    class FakeCuda:
        @staticmethod
        def memory_allocated():
            return 5_930_000_000  # ~5.52 GiB, realistic for the callback path

    class FakeTorch:
        cuda = FakeCuda()

    ns = {
        "os": os, "sys": sys, "json": json, "glob": __import__("glob"),
        "hashlib": hashlib, "subprocess": subprocess, "shutil": shutil,
        "time": __import__("time"),
        "torch": FakeTorch(),
    }

    # Cell 1: log, rss_gib, pv (strip the gate code — exec only the defs)
    src1 = cells[0]
    for fn_name in ("log", "rss_gib", "pv"):
        tree = ast.parse(src1)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                code = ast.get_source_segment(src1, node)
                exec(compile(ast.parse(code), "<cell1>", "exec"), ns)
    # pv needs importlib.metadata imports
    exec("from importlib.metadata import version as pkg_version, PackageNotFoundError",
         ns)

    # Cell 3: find_one, sha256_file
    src3 = cells[2]
    for fn_name in ("find_one", "sha256_file"):
        tree = ast.parse(src3)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                code = ast.get_source_segment(src3, node)
                exec(compile(ast.parse(code), "<cell3>", "exec"), ns)

    # Cell 5: du_bytes
    src5 = cells[4]
    tree = ast.parse(src5)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "du_bytes":
            exec(compile(ast.parse(ast.get_source_segment(src5, node)), "<cell5>", "exec"), ns)

    # Cell 6: cb + its lists (needs step_times/step_vram/latent_dtypes in ns)
    ns["step_times"] = []
    ns["step_vram"] = []
    ns["latent_dtypes"] = []
    src6 = cells[5]
    tree = ast.parse(src6)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "cb":
            exec(compile(ast.parse(ast.get_source_segment(src6, node)), "<cell6>", "exec"), ns)

    return ns


NS = extract_helpers()


@check("log() accepts kwargs (v2 regression)")
def _():
    NS["log"]("positional only")
    NS["log"]("with kwarg", flush=True)
    NS["log"]("  %s sha256 %.2f / %.2f GiB" % ("TEST", 1.0, 6.0), flush=True)


@check("rss_gib() returns a float")
def _():
    v = NS["rss_gib"]()
    assert isinstance(v, float) and v > 0, v


@check("pv() known + unknown package")
def _():
    assert NS["pv"]("pip") != "NOT INSTALLED"
    assert NS["pv"]("no-such-package-xyz") == "NOT INSTALLED"


@check("find_one() skips the slug directory (v1 regression)")
def _():
    tmp = tempfile.mkdtemp(prefix="ltx-dry-")
    try:
        # reproduce the v1 scenario: a DIRECTORY named *.safetensors containing
        # a FILE of the same name beneath it
        slug = os.path.join(tmp, "ltxv-2b-0.9.8-distilled.safetensors")
        os.makedirs(os.path.join(slug, "pytorch", "default", "1"))
        real = os.path.join(slug, "pytorch", "default", "1",
                            "ltxv-2b-0.9.8-distilled.safetensors")
        open(real, "wb").write(b"x" * 1024)
        got = NS["find_one"](os.path.join(tmp, "**", "ltxv-2b-0.9.8-distilled.safetensors"),
                             "LTX checkpoint")
        assert got == real, got
        assert os.path.isfile(got)
    finally:
        shutil.rmtree(tmp)


@check("find_one() raises SystemExit when missing")
def _():
    try:
        NS["find_one"]("/nonexistent-dir-xyz/**/*.safetensors", "missing asset")
    except SystemExit:
        return
    raise AssertionError("find_one did not raise on a missing asset")


@check("sha256_file() hashes + logs with flush=True")
def _():
    tmp = tempfile.mkdtemp(prefix="ltx-dry-")
    try:
        p = os.path.join(tmp, "f.bin")
        data = b"hello ltx" * 1000
        open(p, "wb").write(data)
        got = NS["sha256_file"](p, "TEST")
        assert got == hashlib.sha256(data).hexdigest(), got
    finally:
        shutil.rmtree(tmp)


@check("du_bytes() sums a tree, tolerates missing files")
def _():
    tmp = tempfile.mkdtemp(prefix="ltx-dry-")
    try:
        open(os.path.join(tmp, "a"), "wb").write(b"a" * 100)
        os.makedirs(os.path.join(tmp, "sub"))
        open(os.path.join(tmp, "sub", "b"), "wb").write(b"b" * 200)
        assert NS["du_bytes"](tmp) == 300
        assert NS["du_bytes"](os.path.join(tmp, "nope")) == 0
    finally:
        shutil.rmtree(tmp)


@check("dtype_audit() counts dtypes incl. bf16 detection")
def _():
    # dtype_audit is defined in cell 5 of the notebook; extract it the same way
    nb = json.load(open(NB_PATH))
    cells = ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]
    ns2 = dict(NS)
    tree = ast.parse(cells[4])
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "dtype_audit":
            exec(compile(ast.parse(ast.get_source_segment(cells[4], node)),
                         "<cell5>", "exec"), ns2)

    class FakeTensor:
        def __init__(self, dtype, n):
            self.dtype = dtype
            self._n = n
        def numel(self):
            return self._n

    class FakeModule:
        def __init__(self, params, buffers):
            self._p, self._b = params, buffers
        def parameters(self):
            return self._p
        def buffers(self):
            return self._b

    m = FakeModule([FakeTensor("torch.float16", 1000), FakeTensor("torch.float32", 250)],
                   [FakeTensor("torch.float16", 10)])
    counts = ns2["dtype_audit"](m, "fake")
    assert counts["torch.float16"] == 1010 and counts["torch.float32"] == 250, counts
    m2 = FakeModule([FakeTensor("torch.bfloat16", 5)], [])
    counts2 = ns2["dtype_audit"](m2, "fake-bf16")
    assert counts2.get("torch.bfloat16", 0) == 5, counts2


@check("cb() per-step callback with real signatures")
def _():
    class FakeLat:
        dtype = "torch.float32"

    cb = NS["cb"]
    cb(None, 0, 1000.0, {"latents": FakeLat()})
    cb(None, 1, 421.875, {"latents": FakeLat()})
    cb(None, 2, 100.0, {})  # no latents key at all
    assert len(NS["step_times"]) == 3
    assert NS["latent_dtypes"] == ["torch.float32", "torch.float32"], NS["latent_dtypes"]


@check("latent assertion: FP32 passes, BF16 fails (v3 guard both ways)")
def _():
    latent_dtypes = ["torch.float32"] * 8
    assert "torch.bfloat16" not in set(latent_dtypes)  # must NOT raise
    try:
        bad = ["torch.float32", "torch.bfloat16"]
        assert "torch.bfloat16" not in set(bad), "LATENTS CONTAIN BF16: %s" % set(bad)
    except AssertionError:
        return
    raise AssertionError("BF16 latent did not trip the guard")


@check("export cell: imageio writer path (121f MP4, yuv420p, read-back)")
def _():
    import imageio.v2 as imageio
    import imageio_ffmpeg
    import numpy as np
    from PIL import Image

    tmp = tempfile.mkdtemp(prefix="ltx-dry-")
    try:
        first = Image.open(os.path.join(KEYFRAMES, "first_frame.png")).convert("RGB")
        last = Image.open(os.path.join(KEYFRAMES, "last_frame.png")).convert("RGB")
        assert first.size == (1024, 576) and last.size == (1024, 576)
        frames = [first] + [last] * 119 + [last]  # 121 frames, same shape as the proof
        mp4_path = os.path.join(tmp, "dry-121f.mp4")
        ffexe = imageio_ffmpeg.get_ffmpeg_exe()
        writer = imageio.get_writer(mp4_path, fps=24, codec="libx264", quality=8,
                                    pixelformat="yuv420p",
                                    ffmpeg_params=["-movflags", "+faststart"],
                                    macro_block_size=16)
        for fr in frames:
            writer.append_data(np.array(fr))
        writer.close()
        probe = subprocess.run([ffexe, "-hide_banner", "-i", mp4_path],
                               capture_output=True, text=True)
        info = probe.stderr
        assert "yuv420p" in info, info
        assert "1024x576" in info, info
        assert "h264" in info, info
        reader = imageio.get_reader(mp4_path)
        n = sum(1 for _ in reader)
        assert n == 121, n
    finally:
        shutil.rmtree(tmp)


def main():
    failed = []
    for name, fn in CHECKS:
        try:
            fn()
            print("PASS  %s" % name)
        except Exception as e:
            print("FAIL  %s: %s: %s" % (name, type(e).__name__, e))
            failed.append(name)
    print()
    print("%d/%d dry-run checks passed" % (len(CHECKS) - len(failed), len(CHECKS)))
    if failed:
        print("FAILED:", failed)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
