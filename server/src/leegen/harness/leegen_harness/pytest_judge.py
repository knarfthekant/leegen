"""pytest judge: run the problem's test files with our plugin."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any


def run(cfg: dict[str, Any]) -> None:
    user_dir = Path(cfg["user_dir"]).resolve()
    os.environ["LEEGEN_VISIBLE_FILES"] = ",".join(cfg.get("visible_files", []))
    os.environ["LEEGEN_DEADLINE"] = str(time.monotonic() + cfg["timeout_s"])
    os.chdir(user_dir)
    sys.path.insert(0, str(user_dir))
    import pytest

    from leegen_harness.protocol import emit

    args = [*cfg["test_files"], "-p", "leegen_harness.pytest_plugin", "-q", "--no-header",
            "-p", "no:cacheprovider", "--tb=short", "-rN", "--color=no",
            "--rootdir", str(user_dir), "-o", "python_files=test_*.py *_test.py"]
    code = pytest.main(args)
    if code in (pytest.ExitCode.INTERNAL_ERROR, pytest.ExitCode.USAGE_ERROR):
        emit({"type": "error", "message": f"pytest exited with {code!r}"})
