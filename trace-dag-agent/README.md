# trace-dag-agent

> **A minimal LLM agent with one pseudo-tool: `trace_program`.** Composes
> small pure procedures into a pipeline/DAG — still no shell, no filesystem,
> no real code execution.

The next layer on top of [`trace-agent`](../trace-agent/): instead of one big
mental dry-run, the agent builds **many small dry-runs with explicit
interfaces** and a host-side orchestrator composes them.

> Not: "LLM interprets a large program."
> But: "composition of small, checked trace procedures via an orchestrator."

---

## Architecture

```
Persistent outer agent context
   ↓
trace_program function call
   ↓
local orchestrator executes a Procedure DAG/Pipeline
   ↓
for each node: stateless LLM trace-eval call
   ↓
node return values are composed (via {"$ref": "node_id"})
   ↓
final program result is injected back into outer context
```

The tool input is a tiny dataflow program:

- a **procedure registry**: small pure JS-like procedures, each with a
  manifest (`name`, `purpose`, `input_schema`, `output_schema`, `code`,
  `max_iterations`) — because with composition, most bugs are **interface
  bugs**, not arithmetic bugs
- an **ordered list of nodes**: each node calls exactly one procedure with a
  JSON input that may reference earlier node results:

```json
{ "names": { "$ref": "normalize" }, "limit": 10 }
```

Each node is trace-evaluated by a **stateless** LLM call that must return
strict JSON (`status`, `trace`, `return_value`, `final_state`, `confidence`,
`assumptions`, `notes`). The orchestrator validates the program shape
(identifiers, duplicate ids, ref targets, size limits), resolves refs
host-side, and **halts the pipeline** as soon as a node reports anything other
than `ok`.

## Why composition beats one long trace

- shorter traces per call → less drift and attention loss
- explicit input/output contracts between steps
- better error isolation (a failing node halts with a reason)
- child traces stay compact instead of blowing up the outer context

Deliberately avoided: recursion, mutual procedure calls, global mutable state,
dynamic procedure selection, unbounded loops.

## Limits (host-side)

| Limit | Value |
|---|---|
| Agent loop steps | 8 |
| Program nodes | 12 |
| Procedures | 16 |
| Code per procedure | 16,000 chars |
| Input JSON per node | 24,000 chars |
| Loop iterations per procedure | 1–200 (default 80) |

---

## Requirements

- Node.js 18+ (for global `fetch`)
- An OpenAI API key

## Quick start

```bash
# bash / zsh
OPENAI_API_KEY="sk-..." node agent.js
```

```powershell
# PowerShell
$env:OPENAI_API_KEY = "sk-..."
node agent.js
```

Optional overrides:

```bash
OPENAI_MODEL="gpt-5.5"          # outer agent model
OPENAI_TRACE_MODEL="gpt-5.5"    # model used for per-node trace calls
OPENAI_BASE_URL="https://..."   # alternative API base URL
```

REPL commands: `/exit`, `/reset` (clears the outer history).

## Example prompt

```txt
Nutze deinen Trace-Fallback als komponierte Pipeline.

Input:
[" Alice ", "", "BOB ", "bob", " Clara "]

Aufgabe:
1. Namen trimmen
2. lowercase machen
3. leere Einträge entfernen
4. Vorkommen nach Anfangsbuchstaben zählen
5. Ergebnis als sortiertes Array von Paaren zurückgeben
```

---

## Architecture at a glance

| Part | What it does |
|---|---|
| `trace_program` tool schema | Procedure registry + ordered nodes with `$ref` inputs |
| `resolveRefs(value, results)` | Host-side substitution of `{"$ref": "node_id"}` with earlier return values |
| `traceEvalProcedure(...)` | One stateless LLM trace call per node, strict-JSON result |
| `runTraceProgram(args)` | Validation + orchestration + halt-on-error over the node list |
| `agentTurn(history)` | Loop: call API → run tool → repeat until a text answer |
| `main()` | REPL: read user input → `agentTurn` → print the answer |

**Reminder:** the result is an LLM-emulated trace, not real execution. No
correctness guarantee — it's a structured dry-run fallback for tiny pure
dataflow programs.

## License

[MIT](../LICENSE).
