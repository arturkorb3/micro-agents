# trace-agent

> **A minimal LLM agent with one pseudo-tool: `trace_eval`.** No shell, no
> filesystem, no real code execution.

A thought experiment in a single file (`agent.js`): what if an agent has **no
programming environment at all** — can an LLM itself serve as a rudimentary
(pseudo-)scripting fallback?

`trace_eval` is *not* a runtime. It is a **second, stateless LLM call** acting
as a deliberately limited *trace emulator*: the outer agent synthesizes a
small, pure, "trace-hardened" JS-like procedure on demand, and the trace call
simulates it step by step with an explicit state protocol.

---

## The idea

To be clear up front: an LLM never *computes* anything deterministically.
Every "evaluation step" here is next-token prediction — a probabilistic
guess that merely tends to coincide with the correct arithmetic. There is
no interpreter underneath, and no protocol changes that. What a protocol
*can* change is the error profile: LLMs are more reliable at **small local
transformations** than at keeping a long computation globally consistent
"in their head". So instead of asking:

> "LLM, compute the result."

we ask:

> "LLM, follow an explicit execution protocol."

That does not turn prediction into computation — it decomposes one large
guess into many small, individually checkable guesses.

The generated code is instrumented ("trace-hardened") so that every mutation,
loop iteration, branch decision and control-flow event must be logged. A
synthesized procedure looks like this — the `trace(...)` calls are part of the
generated code itself:

```js
function sumUntilLimit(arr, limit) {
  let sum = 0;
  trace("initial state", { arr, limit, sum });

  // TRACE_BLOCK: FOR_LOOP_1
  for (let i = 0; i < arr.length; i++) {
    trace("FOR_LOOP_1 condition", { i, cond: i < arr.length });
    let value = arr[i];
    trace("statement value = arr[i]", { i, value });
    sum += value;
    trace("statement sum += value", { sum });
    if (sum >= limit) {
      trace("branch sum >= limit", { sum, limit, taken: true });
      break; // trace: control break
    }
  }

  trace("final state", { sum });
  return sum;
}
```

The emulation call must then **linearize the loop** into explicit state
sequences — turning the model from a narrator into a step-by-step simulator:

```txt
FOR_LOOP_1 / iteration 2
condition: i < arr.length => true
before: i=2, sum=6
statement: value = arr[2]
after: value=5
statement: sum += value
after: sum=11
branch: sum >= limit => true
control: break
```

## Two-phase flow

```
User task
  ↓
Agent synthesizes a small trace-hardened procedure   (synthesis)
  ↓
Agent calls trace_eval
  ↓
trace_eval simulates state transitions step by step  (trace emulation)
  ↓
Agent summarizes result + uncertainty
```

## What it is (and is not)

**Suitable** (as a mini-fallback): pure functions, small inputs, deterministic
control flow, bounded loops, simple data types — e.g. small string/array
transformations, parsing simple formats, filter/map/reduce logic, control-flow
checks, didactic dry-runs.

**Not suitable**: large data, long loops, tricky language semantics (JS
coercion, floating point, aliasing), async, I/O, anything correctness- or
security-critical. There is **no formal execution semantics** — the model
remains the interpreter, and errors can be introduced early and carried
forward consistently.

Guardrails built in:

- a safe language subset (no I/O, no `Date`/random/`eval`/async, no prototype
  tricks, no coercion edge cases)
- a hard loop-iteration cap (`max_iterations`, default 80, max 200)
- a mandatory result structure with `status` (`ok | unsupported |
  iteration_limit | uncertain`), assumptions, and a confidence rating

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
OPENAI_MODEL="gpt-5.5"        # outer agent model
OPENAI_TRACE_MODEL="gpt-5.5"  # model used for the trace emulation call
```

## Example prompt

```txt
Normalize these names: [" Alice ", "", "BOB ", "  Clara"].
Trim, lowercase, remove empty strings.
Use your trace fallback.
```

---

## Architecture at a glance

| Part | What it does |
|---|---|
| `traceEvalTool` | Function-tool schema: `objective`, `code`, `invocation`, `max_iterations` |
| `runTraceEval(args)` | The "tool": a second LLM call with strict TRACE_EVAL instructions |
| `agentTurn(history)` | Loop: call API → run trace calls → repeat until a text answer |
| `main()` | REPL: read user input → `agentTurn` → print the answer |

See also [`trace-dag-agent`](../trace-dag-agent/) for the next layer:
composing multiple trace-evaluated procedures into a pipeline/DAG.

## License

[MIT](../LICENSE).
