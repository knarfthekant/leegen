"""MCP tools, in-process."""

from mcp import Client

from leetclaude.mcp_server import build_mcp
from leetclaude.state import app_state
from leetclaude.store.problems import ProblemStore, dump_problem_yaml


def connect() -> Client:
    return Client(build_mcp())


def data(result):
    assert not result.is_error, result.content
    return result.structured_content


async def test_tools_listed():
    async with connect() as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert {"get_session", "annotate", "propose_edit", "run_tests", "create_problem",
                "validate_problem_yaml", "get_authoring_guide"} <= names


async def test_create_problem_validates_before_saving():
    async with connect() as client:
        p = ProblemStore().get("merge-ranges").model_copy(deep=True)
        p.id = "merge-ranges-copy"
        good = dump_problem_yaml(p)
        # broken reference -> not saved
        p.reference.files[0].content = "def merge_ranges(b):\n    return b\n"
        bad = data(await client.call_tool("create_problem", {"yaml": dump_problem_yaml(p)}))
        assert bad["saved"] is False and bad["issues"]
        assert ProblemStore().get("merge-ranges-copy") is None
        ok = data(await client.call_tool("create_problem", {"yaml": good}))
        assert ok["saved"] is True and ok["validated"] is True
        assert ProblemStore().get("merge-ranges-copy") is not None
        dup = data(await client.call_tool("create_problem", {"yaml": good}))
        assert dup["saved"] is False
        data(await client.call_tool("delete_problem", {"problem_id": "merge-ranges-copy"}))


async def test_schema_errors_are_reported():
    async with connect() as client:
        r = data(await client.call_tool("validate_problem_yaml", {"yaml": "id: x\n"}))
        assert r["ok"] is False and r["stage"] == "schema" and "judge" in r["errors"]


async def test_tutoring_flow():
    async with connect() as client:
        st = app_state()
        st.session.update(problem_id="merge-ranges", buffers={"solution.py": "def merge_ranges(b):\n    return b\n"})
        s = data(await client.call_tool("get_session", {}))
        assert s["problem_id"] == "merge-ranges"
        assert "return b" in s["user_files"]["solution.py"]  # unsaved buffer wins

        r = data(await client.call_tool("annotate", {"annotations": [
            {"file": "solution.py", "start_line": 2, "severity": "hint", "message": "sort first"},
            {"message": "overall: close!", "severity": "praise"}]}))
        assert len(r["created"]) == 2
        bad = await client.call_tool("annotate", {"annotations": [
            {"file": "solution.py", "start_line": 50, "message": "x"}]})
        assert bad.is_error and "outside solution.py" in bad.content[0].text

        prop = data(await client.call_tool("propose_edit", {
            "file": "solution.py", "rationale": "sort",
            "edits": [{"old": "return b", "new": "return sorted(b)"}]}))
        pending = st.workspace.read_state("merge-ranges", "proposals", [])
        assert pending[0]["id"] == prop["proposal_id"] and "sorted(b)" in pending[0]["content"]
        missing = await client.call_tool("propose_edit", {
            "file": "solution.py", "rationale": "x", "edits": [{"old": "nope", "new": "y"}]})
        assert missing.is_error and "exactly once" in missing.content[0].text

        run = data(await client.call_tool("run_tests", {}))
        assert run["status"] == "failed" and run["failing_tests"]
        data(await client.call_tool("add_test_case", {"args": [[[1, 2]]]}))
        assert st.workspace.read_state("merge-ranges", "custom_tests", [])[-1]["input"]["args"] == [[[1, 2]]]
        cleared = data(await client.call_tool("clear_annotations", {}))
        assert cleared["removed"] == 2


async def test_resolve_proposal_accept_writes_file():
    from leetclaude import tutor

    p = ProblemStore().get("merge-ranges")
    st = app_state()
    st.session.update(problem_id=p.id, buffers={})
    st.workspace.reset(p)
    prop = await tutor.propose_edit(p, "solution.py", content="def merge_ranges(b):\n    return []\n")
    written = await tutor.resolve_proposal(p, prop["id"], "accept")
    assert written and st.workspace.files(p)["solution.py"].endswith("return []\n")
    assert tutor.list_proposals(p.id) == []
