#!/usr/bin/env python3
"""Validate a generated .ipynb: JSON parses, nbformat sane, every code
cell compiles with py_compile. Usage: python3 validate-notebook.py <notebook.ipynb>
Exits non-zero on any failure. (Part B notebook validation, B-3.)"""
import json
import py_compile
import sys
import tempfile
import os


def main():
    path = sys.argv[1]
    with open(path) as f:
        nb = json.load(f)
    assert nb.get("nbformat") == 4, f"nbformat is {nb.get('nbformat')}, expected 4"
    cells = nb["cells"]
    print(f"{path}: {len(cells)} cells, nbformat 4.{nb.get('nbformat_minor')}")
    n_code = 0
    for i, cell in enumerate(cells):
        if cell["cell_type"] != "code":
            continue
        n_code += 1
        src = "".join(cell["source"])
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(src)
            tmp = f.name
        try:
            py_compile.compile(tmp, doraise=True)
        finally:
            os.unlink(tmp)
        print(f"  cell {i}: py_compile OK ({len(src)} chars)")
    assert n_code > 0, "notebook has no code cells"
    print(f"VALID: {n_code} code cells compile")
    return 0


if __name__ == "__main__":
    sys.exit(main())
