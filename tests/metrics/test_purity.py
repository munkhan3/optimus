"""The metrics engine must stay importable with no framework installed.

vision.md §27 requires the metrics engine to be a "pure Python module, no
framework dependencies, unit-tested standalone". That is not a stylistic
preference: it is what keeps §24 swappable, fast to test, and free of hidden
database reads that would make a "pure function over stored state" quietly
impure.

A comment saying so decays. This test does not.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

METRICS_DIR = Path(__file__).resolve().parents[2] / "optimus" / "metrics"

# Anything outside the standard library is a dependency. Named explicitly so the
# failure message can be specific about what leaked in.
FORBIDDEN_ROOTS = {
    "fastapi",
    "sqlmodel",
    "sqlalchemy",
    "pydantic",
    "pydantic_settings",
    "starlette",
    "google",
    "google.genai",
    "httpx",
    "alembic",
    "psycopg",
    "uvicorn",
}


def _module_files() -> list[Path]:
    files = sorted(METRICS_DIR.glob("*.py"))
    assert files, f"no modules found under {METRICS_DIR}"
    return files


def _imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import within optimus.metrics -- always fine
                continue
            if node.module:
                roots.add(node.module.split(".")[0])
    return roots


def test_no_framework_imports() -> None:
    offenders: list[str] = []
    for path in _module_files():
        for root in sorted(_imported_roots(path)):
            if root in FORBIDDEN_ROOTS:
                offenders.append(f"{path.name} imports {root}")
    assert not offenders, (
        "the metrics engine must not depend on a framework (§27):\n  "
        + "\n  ".join(offenders)
    )


def test_only_stdlib_imports() -> None:
    """Stronger form: nothing outside the standard library, full stop."""
    offenders: list[str] = []
    for path in _module_files():
        for root in sorted(_imported_roots(path)):
            if root == "optimus":
                continue
            if root not in sys.stdlib_module_names:
                offenders.append(f"{path.name} imports non-stdlib module {root!r}")
    assert not offenders, (
        "optimus/metrics must import stdlib only so it can be tested standalone:\n  "
        + "\n  ".join(offenders)
    )
