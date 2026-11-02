"""Entry point: python -m leegen_harness run.json"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from leegen_harness.protocol import emit


def main() -> None:
    cfg_path = Path(sys.argv[1] if len(sys.argv) > 1 else "run.json").resolve()
    cfg = json.loads(cfg_path.read_text())
    base = cfg_path.parent
    for key in ("user_dir", "ref_dir"):
        if cfg.get(key):
            cfg[key] = str((base / cfg[key]).resolve())
    kind = cfg["judge"]["kind"]
    if kind == "function":
        from leegen_harness import function_judge

        function_judge.run(cfg)
    elif kind == "pytest":
        from leegen_harness import pytest_judge

        pytest_judge.run(cfg)
    else:
        emit({"type": "error", "message": f"harness does not handle judge kind {kind!r}"})


if __name__ == "__main__":
    main()
