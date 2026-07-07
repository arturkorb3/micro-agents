# micro-agents

> **A collection of minimal agentic AI ideas** — each one a complete agent
> loop in a single file. No framework, no dependencies, just Node.js 18+.

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

The trace agents execute **no code whatsoever** — they explore how far an LLM
can get as a rudimentary (pseudo-)scripting fallback when no programming
environment is available. They are theory-motivated experiments, not tools of
industrial value.

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
