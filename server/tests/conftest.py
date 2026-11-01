"""Tests run against copies of problems/ and environments/ with a temporary workspace.

The env-var setup happens at import time, before any leetclaude module reads settings().
The venv cache (~/.cache/leetclaude) is shared with normal use so environments aren't rebuilt.
"""

import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_TMP = Path(tempfile.mkdtemp(prefix="leetclaude-tests-"))
shutil.copytree(ROOT / "problems", _TMP / "problems")
shutil.copytree(ROOT / "environments", _TMP / "environments")
os.environ["LEETCLAUDE_PROBLEMS"] = str(_TMP / "problems")
os.environ["LEETCLAUDE_ENVIRONMENTS"] = str(_TMP / "environments")
os.environ["LEETCLAUDE_WORKSPACE"] = str(_TMP / "workspace")
os.environ["LEETCLAUDE_EXECUTORS"] = str(_TMP / "executors.yaml")  # absent -> local only

import pytest  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def tmp_root() -> Path:
    return _TMP


def pytest_sessionfinish(session, exitstatus):  # noqa: ANN001
    shutil.rmtree(_TMP, ignore_errors=True)
