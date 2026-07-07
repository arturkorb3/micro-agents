# shell-agent

> **A minimal LLM agent for your local CLI** — one tool: `shell`.

A complete agent loop in a single file (`agent.js`, ~200 lines). No framework, no
dependencies, just Node.js 18+. **Cross-platform:** it runs commands in
**PowerShell** on Windows and **POSIX `sh`** on Linux/macOS, and tells the model
which one it has so it uses the right syntax.

---

## ⚠️ Security warning

**This is a learning / demonstration snippet. It is explicitly NOT meant for
production use.**

- The model can run **arbitrary shell commands** on your system — no
  confirmation, no restrictions.
- There is **no sandbox, no isolation, no access control**.
- A compromised or manipulated model (prompt injection) could run destructive
  commands.
- **Never** run it as root / Administrator.
- **Never** use it on networks or machines with sensitive data.

**Run it only on a dedicated throwaway VM or an isolated container — if at all.**

---

## How it works

```
user → [history] → OpenAI Responses API
                        ↓
                  function_call: shell
                        ↓
                  exec(command)   # PowerShell on Windows, POSIX sh elsewhere
                        ↓
                  function_call_output → [history] → next turn
```

The loop runs up to 10 steps per user message, then stops. The system prompt is
built dynamically from `process.platform`, so the model knows the host OS and
which shell it has.

---

## Requirements

- Node.js 18+ (for global `fetch`)
- An OpenAI API key with access to `gpt-5.5` (or any model you set)

---

## Quick start

Set your API key and run:

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
root to `.env` first — no dependency needed):

```bash
node --env-file=../.env agent.js
```

Override the model:

```bash
OPENAI_MODEL="gpt-5.5" node agent.js
```

---

## Example session

```
Minimal shell agent started (POSIX sh).
Type /exit to quit.

you> which node version is running here?

[shell] node --version

agent> You're running Node.js v22.3.0.

you> /exit
```

---

## Architecture at a glance

| Part | What it does |
|---|---|
| `callOpenAI(input)` | Sends the full history array to the Responses API |
| `runShell(command)` | Runs a command in the platform shell, returns JSON with stdout/stderr/exit |
| `agentTurn(history)` | Loop: call API → run tool calls → repeat until a text answer |
| `main()` | REPL: read user input → `agentTurn` → print the answer |

The single system prompt is assembled from `process.platform`, so the model is
told whether to use PowerShell or POSIX commands.

---

## Why the Responses API?

The OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses)
keeps the agent loop simple: the model returns native `function_call` items, and
`output_text` gives the final text directly — no manual
`choices[0].message.content` parsing.

---

## License

[MIT](../LICENSE).

