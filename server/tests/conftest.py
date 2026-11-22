"""Tests run against copies of data/problems, data/tutorials and environments/, with a temporary
workspace inside the copied data root.

The env-var setup happens at import time, before any leegen module reads settings().
The venv cache (~/.cache/leegen) is shared with normal use so environments aren't rebuilt.
"""

import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_TMP = Path(tempfile.mkdtemp(prefix="leegen-tests-"))
for _part in ("problems", "tutorials"):
    shutil.copytree(ROOT / "data" / _part, _TMP / "data" / _part)
shutil.copytree(ROOT / "environments", _TMP / "environments")
os.environ["LEEGEN_DATA"] = str(_TMP / "data")   # workspace/ is created inside it
os.environ["LEEGEN_ENVIRONMENTS"] = str(_TMP / "environments")
os.environ["LEEGEN_EXECUTORS"] = str(_TMP / "executors.yaml")  # absent -> local only

import pytest  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def tmp_root() -> Path:
    return _TMP


def pytest_sessionfinish(session, exitstatus):  # noqa: ANN001
    shutil.rmtree(_TMP, ignore_errors=True)
