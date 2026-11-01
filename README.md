# leetclaude

A local, LeetCode-style programming trainer where **your coding agent writes the problems,
and you solve them**. Ask for an exercise on a topic you want to learn, work through it in the
browser, and ask the same agent for hints or feedback. Run your solution on a local CPU or GPU,
or send it to a remote GPU over SSH or Slurm.

There is no fixed problem bank: the repo includes examples, and your agent can create new
problems or adapt existing ones to your level. Exercises can cover algorithms, async Python,
multi-file services, PyTorch, Triton, or CUDA kernels.

## How it works with your coding agent

leetclaude provides the browser editor, test runner, and an **MCP (Model Context Protocol)
server**. Your coding agent—such as Codex or Claude Code—connects to that server to author
exercises and act as your tutor. You use your existing agent and chat; leetclaude itself does
not require a model API key.

The browser reports your open problem, current code (including unsaved edits), cursor, and
test results to the server. Through MCP, your agent can read that context, run tests, leave
comments on exact code ranges, and propose edits that you accept or reject in the editor.
You can ask for help without copying your code and error messages into chat.

The four screenshots below follow one PyTorch learning session in Codex. Click any image to
open the full-size screenshot stored in this repo.

### 1. Generate a problem through MCP

Ask your agent: **“Generate a tutorial problem on getting started with PyTorch, with a GPU
backend.”** The agent reads the authoring guide, checks available environments, and creates a
YAML problem containing the description, starter code, visible and hidden tests, and a
reference solution. The MCP authoring tools validate the exercise by checking that the
reference passes every test and the starter fails at least one, when a compatible executor
is available. The saved exercise appears in the problem list.

[![Codex using the leetclaude MCP integration to generate and validate a PyTorch GPU tutorial beside the problem list](docs/images/problem-generation.png)](docs/images/problem-generation.png)

[Full-size screenshot: problem generation](docs/images/problem-generation.png)

### 2. Solve it and run real tests

Read the description on the left and write your solution in the editor on the right. The
Testcase and Test Result tabs let you inspect cases and their results. In this example, a
tensor scale-and-shift solution passes all four tests on the local Apple GPU (`local · mps`),
including two hidden cases. The result panel shows the input and output tensors, their
shapes, dtypes, and device.

Once it feels too easy, ask **“Make the problem harder.”** The agent can update the exercise,
including its description and tests; here it moves from elementwise arithmetic to a small
neural network layer with matrix multiplication, bias broadcasting, and ReLU.

[![A PyTorch solution accepted with four passing tests on local MPS while the user asks Codex for a harder exercise](docs/images/test-results.png)](docs/images/test-results.png)

[Full-size screenshot: test results](docs/images/test-results.png)

### 3. Get feedback directly on your code

Ask **“What’s the error saying?”** The agent calls `get_session` to inspect your current
attempt and failing tests, and can use `run_tests` to check its diagnosis. It leaves targeted
feedback with `annotate`, which appears as editor highlights and comments in the Review tab.
In this screenshot, the comments identify elementwise multiplication where matrix
multiplication is needed, an incorrect activation name, and an undefined variable.

For changes, `propose_edit` presents a diff for you to accept or reject. The tutoring protocol
asks agents to give hints in small steps and provide a complete solution only when requested.

[![Codex explaining three errors with matching highlights in the editor and comments in the Review tab](docs/images/agent-comments.png)](docs/images/agent-comments.png)

[Full-size screenshot: agent comments](docs/images/agent-comments.png)

### 4. Execute on a remote GPU

Choose a compatible executor from the toolbar to run the same exercise elsewhere. Here the
selection changes from local MPS to `watgpu · cuda`, a remote NVIDIA GPU reached through SSH
and Slurm. The screenshot shows the job queued for cluster resources, with its Slurm job ID
and a cancel control. Once allocated, the remote executor runs the tests and returns the
results to the same UI.

The local executor detects CPU, Apple MPS, and NVIDIA CUDA capabilities. Remote `ssh` and
`slurm` executors are configured in `~/.config/leetclaude/executors.yaml` and use your existing
SSH authentication. Environments are provisioned with uv on first use and cached for later
runs. The toolbar offers executors compatible with the exercise’s hardware requirements;
PyTorch exercises can target either MPS or CUDA, while CUDA and Triton kernels require NVIDIA
hardware.

[![A PyTorch exercise queued on the remote watgpu CUDA executor with a Slurm job ID and cancel control](docs/images/remote-gpu.png)](docs/images/remote-gpu.png)

[Full-size screenshot: remote GPU execution](docs/images/remote-gpu.png)

See [executor configuration](docs/executors.md) for SSH and Slurm setup, and
[the cluster setup guide](docs/clusters/README.md) for onboarding a remote backend.

## Quick start

Requirements: [uv](https://docs.astral.sh/uv/) and Node.js with npm. From the repo root:

```bash
make start        # installs dependencies, builds the UI if needed, and starts the server
```

Open [http://127.0.0.1:13370](http://127.0.0.1:13370). One process serves the UI, REST API,
WebSocket updates, and MCP endpoint at `http://127.0.0.1:13370/mcp`. Keep it running while
using the app or its MCP tools. Use `make stop` from another terminal to stop it.

### Connect your agent

For **Codex**, register the local MCP server:

```bash
codex mcp add leetclaude --url http://127.0.0.1:13370/mcp
codex mcp get leetclaude
```

For **Claude Code**, the repo’s [`.mcp.json`](.mcp.json) already declares the server. To add
it manually from another project:

```bash
claude mcp add --transport http leetclaude http://127.0.0.1:13370/mcp
```

Other clients that support MCP over streamable HTTP can use the same URL. If your agent does
not show the newly configured tools, restart the client. Agent integration works with the app
in a regular browser; the screenshots show Codex’s browser beside its chat.

Then ask your agent to create a problem, or open one and ask for a hint. The repo’s
[`AGENTS.md`](AGENTS.md) explains the authoring and tutoring protocols.

## Under the hood

Each problem is a self-contained YAML file in `problems/`. It declares the exercise content,
editable and supporting files, tests, reference solution, environment, and hardware needs.
Your saved solution and review state live in the gitignored `workspace/<id>/` directory.

When you run a solution, the backend builds a temporary job bundle. The judge defines how it
is tested, the language adapter defines how it is built and launched, the environment supplies
the runtime and dependencies, and the executor determines where it runs. Every executor
returns the same result format to the UI and MCP tools.

| Layer | Supported options |
| --- | --- |
| Judges | `function` for input/output and method-call tests; `pytest` for async, stateful, and multi-file exercises; `script` for custom harnesses and compiled programs |
| Environments | Python, C++, PyTorch, Triton, and CUDA; dependencies are managed by uv where applicable |
| Executors | Local CPU/MPS/CUDA, remote SSH hosts, and Slurm clusters |
| Browser UI | Monaco editor, Markdown and math descriptions, hints, test cases and results, review comments, and proposed edits; light and dark themes |

## Development and documentation

`make dev` runs the backend with auto-reload and the Vite UI with hot reload at
[http://127.0.0.1:13371](http://127.0.0.1:13371). Ctrl-C stops both. Set `LEETCLAUDE_PORT`
(default `13370`) or `LEETCLAUDE_WEB_PORT` (default `13371`) to override the ports; update
your MCP URL if the backend port changes.

`make check` runs backend tests, problem validation, and the frontend build. `make smoke`
runs the browser smoke test against a running server using an installed Chrome.

- [Agent manual and architecture](AGENTS.md)
- [Problem authoring guide](docs/authoring.md)
- [Problem JSON Schema](schema/problem.schema.json)
- [Executor configuration](docs/executors.md)
- [Cluster setup guide](docs/clusters/README.md)
- [Screenshots](docs/images/)
