# reasoning-agent

> **A reasoning wrapper for a non-reasoning model** — a fixed orchestration
> scaffold that makes a non-reasoning model like `gpt-4.1` behave, from the
> outside, like a reasoning model.

A complete agent loop in a single file (`agent.js`). No framework, no
dependencies, just Node.js 18+.

---

## The idea

Native reasoning models are (partly) an **internalized version** of what used
to be built around base models with prompting, agent loops and control
protocols: they spend extra test-time compute on hidden intermediate work
before the final answer.

This agent inverts that: the model stays a plain next-token predictor, and the
**scaffold supplies the reasoning behavior from the outside**. Every user turn
is forced through fixed phases:

```
user message
   ↓
 PLAN       decompose the task, name unknowns and risks
   ↓
 EXECUTE    work through the plan step by step (shell tool available)
   ↓
 CRITIQUE   a critic pass reviews the draft: ACCEPT or REVISE
   ↓          └── REVISE → back to EXECUTE (bounded by effort level)
 FINALIZE   clean final answer, free of scaffold traces
   ↓
final answer
```

The scaffold's control flow is hardened with
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs):
PLAN and CRITIQUE must return schema-enforced JSON (`text.format` with
`json_schema`, `strict: true`), so the model cannot drift out of its phase
role, refuse mid-plan, or produce an unparseable verdict.

The plan classifies each step as **`mechanical`** (exact symbol work —
counting, arithmetic, transformation — where one slipped symbol changes the
result) or **`conceptual`** (judgment, explanation, recall), and declares
`needs_system_access` for tasks about the local system. The host grants the
shell tool when either applies — and if the plan had mechanical steps but the
draft never ran a shell command, the host **forces a revision** with mandatory
shell verification. Tool use is enforced by the host, not by prompt
discipline: non-reasoning models reliably ignore "you MUST use the tool"
prompts.

Two properties mimic a native reasoning model:

- **Visible "thinking", hidden from history.** Plans, drafts and critiques are
  printed dimmed as `[thinking:…]`, but — like reasoning tokens — they are
  discarded after the turn. Only the user message and the final answer enter
  the persistent conversation.
- **An effort knob.** `REASONING_EFFORT=low|medium|high` sets the
  critique/revision budget (0/1/2 rounds), analogous to reasoning-effort
  parameters on native reasoning models.

The scaffold applies to **every** request, not just system tasks: ordinary
questions still get plan → stepwise draft → critique. The `shell` tool is the
one place where *real* external verification enters — everything else is
prompt-level error damping, not truth.

## What this is not

- Not a reasoning model. The intermediate steps are still next-token
  prediction; the scaffold shapes the context so the next tokens more likely
  emerge from a controlled, inspectable process — it cannot guarantee
  correctness.
- Not efficient. One user turn costs 3+ model calls (plan, execute, finalize,
  plus critique/revision rounds).
- Not robust. A wrapper is more prompt-dependent and fragile than natively
  trained reasoning behavior; the model can still talk itself into a wrong
  draft and consistently defend it.

### An honest limit, observed

The critic is the **same model** as the solver, so it shares the solver's
blind spots — more critique rounds are damping, not independent verification.
A letter-series puzzle made this concrete: after hardening, the agent
shell-verified the entire pattern structure correctly (blocks, exact
differences), then still slipped on the final forward step and confidently
picked a neighboring wrong option. The scaffold made the error *visible and
localizable* in the trace — it could not make it impossible. That is exactly
the boundary between error damping and real verification.

---

## ⚠️ Security warning

The `shell` tool runs **real, arbitrary commands** — no sandbox, no
confirmation. Same caveats as [`shell-agent`](../shell-agent/): only use on a
throwaway VM or isolated container, never as root/Administrator, never near
sensitive data.

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

Or, with **Node 20.6+**, load a `.env` file (copy `.env.example` in the repo
root to `.env` first):

```bash
node --env-file=../.env agent.js
```

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | required |
| `OPENAI_MODEL` | the (non-reasoning) inner model to wrap, default `gpt-4.1` |
| `REASONING_EFFORT` | `low` \| `medium` \| `high` — critique/revision budget, default `medium` |

---

## Example session

```
Reasoning-wrapper agent started.
Inner model: gpt-4.1 (non-reasoning) · effort: medium · shell: POSIX sh
Dimmed output is the scaffold's forced 'thinking'.
Type /exit to quit.

you> A train leaves at 9:40 and arrives at 13:05. How long is the trip?

[thinking:plan]
  task: Compute the duration between 9:40 and 13:05.
  expected answer: a duration in hours and minutes
    1. [mechanical] Minutes from 9:40 to 10:00.
    2. [mechanical] Hours from 10:00 to 13:00.
    3. [mechanical] Add the remaining 5 minutes.
  risks: carrying minutes across the hour boundary
  shell: granted

[thinking:draft]
  9:40 → 10:00 is 20 min. 10:00 → 13:00 is 3 h. Plus 5 min. Total 3 h 25 min.

[thinking:critique]
  verdict: accept

agent> The trip takes 3 hours and 25 minutes.
```

---

## Architecture at a glance

| Part | What it does |
|---|---|
| `PLAN/EXECUTE/CRITIQUE/REVISE/FINALIZE_INSTRUCTIONS` | Phase prompts; the same inner model plays every role |
| `PLAN_FORMAT` / `CRITIQUE_FORMAT` | Strict JSON schemas (Structured Outputs) for plan and verdict |
| `reasoningTurn(conversation, userText)` | Runs one full phase pipeline on a throwaway working history; forces a revision if mechanical steps skipped the shell |
| `executeLoop(history, instructions, allowShell)` | Tool loop for the execute phases; reports whether the shell was actually used |
| `planNeedsShell(plan)` | Host-side gating: system access or any mechanical step |
| `thinking(label, text)` | Prints dimmed scaffold output |
| `main()` | REPL; persistent history holds only user messages + final answers |

## License

[MIT](../LICENSE).
