# micro-agents

> **A collection of small thought experiments around agentic AI** — each one
> explored as a complete agent loop in a single file. No framework, no
> dependencies, just Node.js 18+.

Every agent lives in its own directory with its own README and uses the same
skeleton: a tiny REPL, the OpenAI
[Responses API](https://platform.openai.com/docs/api-reference/responses)
with native function calling, and exactly **one tool**.

---

## The agents

| Agent | Tool | Idea |
|---|---|---|
| [`shell-agent`](shell-agent/) | `shell` | The classic minimal CLI agent: the model runs real shell commands (PowerShell / POSIX sh). ⚠️ Unsandboxed — read its security warning. |
| [`trace-agent`](trace-agent/) | `trace_eval` | A thought experiment: no runtime at all. The agent synthesizes small, pure, trace-hardened procedures and a second LLM call *emulates* them step by step ("LLM trace emulator"). |
| [`trace-dag-agent`](trace-dag-agent/) | `trace_program` | The composition layer: small pure procedures with explicit I/O contracts, orchestrated as a pipeline/DAG with one stateless trace call per node. |
| [`action-gate-agent`](action-gate-agent/) | mocked email/CRM tools | Runtime governance: a **fixed host policy gate** (validation, injection blocking, human approval, execution ledger) between the model's tool-call intents and their execution. Standalone pattern — does not depend on the trace idea. |
| [`reasoning-agent`](reasoning-agent/) | `shell` | A **reasoning wrapper**: a fixed plan → execute → critique → finalize scaffold that makes a small non-reasoning model (e.g. `gpt-5.4-mini`) look like a reasoning model from the outside — visible "thinking" that never enters the persistent history, plus an effort knob. |

Three independent ideas live here, deliberately not sold as one:

- **The trace agents** (`trace-agent`, `trace-dag-agent`) execute **no code
  whatsoever** — they explore how far an LLM can get as a rudimentary
  (pseudo-)scripting fallback when no programming environment is available.
  Theory-motivated experiments, not tools of industrial value.
- **`action-gate-agent`** demonstrates a practical architecture pattern:
  deterministic host-side gating of consequential agent actions. It stands
  entirely on its own and does not depend on the trace idea. The only
  connection is a shared attitude: force the model through fixed, checkable
  structures instead of free text.
- **`reasoning-agent`** explores the flip side of native reasoning models: if
  reasoning models are partly an *internalized* agent scaffold, then an
  external scaffold (plan / execute / critique / finalize, hidden "thinking",
  effort knob) should be able to emulate reasoning behavior around an
  unmodified small model — error damping through structured context, not
  guaranteed correctness.

---

## Requirements

- Node.js 18+ (for global `fetch`)
- An OpenAI API key

## Quick start

```bash
cd shell-agent        # or trace-agent / trace-dag-agent

# bash / zsh
OPENAI_API_KEY="sk-..." node agent.js
```

```powershell
# PowerShell
cd shell-agent
$env:OPENAI_API_KEY = "sk-..."
node agent.js
```

Or, with **Node 20.6+**, load a `.env` file (copy `.env.example` in the repo
root to `.env` first — no dependency needed):

```bash
cd shell-agent
node --env-file=../.env agent.js
```

Common environment variables:

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | required |
| `OPENAI_MODEL` | override the (outer) model, default `gpt-5.5` |
| `OPENAI_TRACE_MODEL` | trace agents only: model for the emulation calls |

---

## Shared skeleton

```
user → [history] → OpenAI Responses API
                        ↓
                  function_call: <the one tool>
                        ↓
                  tool implementation
                        ↓
                  function_call_output → [history] → next turn
```

Each agent's README explains what its tool actually does — and, for the trace
agents, what it deliberately does *not* do.

## License

[MIT](LICENSE).
