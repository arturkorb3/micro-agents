#!/usr/bin/env node

/**
 * Minimal LLM agent with a single pseudo-tool: trace_eval.
 *
 * This does NOT execute code.
 * It uses an LLM call as a tiny trace emulator for pure, deterministic,
 * environment-context-free pseudo-code / small JS-like procedures.
 *
 * Requirements:
 *   Node.js 18+ for global fetch
 *
 * Run:
 *   OPENAI_API_KEY="sk-..." node agent.js
 *
 * Optional:
 *   OPENAI_MODEL="gpt-5.5" node agent.js
 *   OPENAI_TRACE_MODEL="gpt-5.5" node agent.js
 *
 * WARNING:
 *   This is not a real interpreter and gives no correctness guarantee.
 *   It is a structured dry-run fallback for small, pure procedures.
 */

const readline = require("node:readline/promises");
const { stdin: inputStream, stdout: outputStream } = require("node:process");

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const TRACE_MODEL = process.env.OPENAI_TRACE_MODEL || MODEL;

if (!API_KEY) {
  console.error("Missing environment variable: OPENAI_API_KEY");
  process.exit(1);
}

const traceEvalTool = {
  type: "function",
  name: "trace_eval",
  description:
    "LLM-based dry-run emulator for small, pure, deterministic, trace-hardened pseudo-JS procedures. It does not execute code.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description:
          "What the procedure is supposed to compute or transform.",
      },
      code: {
        type: "string",
        description:
          "Small pure JS-like function/procedure, heavily instrumented with trace/log comments or trace() calls.",
      },
      invocation: {
        type: "string",
        description:
          "Concrete call with concrete arguments, e.g. normalizeNames([' Alice ', '', 'BOB ']).",
      },
      max_iterations: {
        type: "integer",
        description:
          "Hard cap for loop iterations to emulate. Default 80, maximum 200.",
      },
    },
    required: ["objective", "code", "invocation"],
    additionalProperties: false,
  },
  strict: true,
};

const tools = [traceEvalTool];

const instructions = `
You are a minimal CLI micro-agent.

You have exactly one tool: trace_eval.

trace_eval is NOT a runtime, NOT a JS engine, and NOT a shell.
It is an LLM-based dry-run emulator for tiny pure procedures.

Use trace_eval when the user asks for a small deterministic computation,
transformation, parsing task, algorithmic check, or pseudo-code execution
where a trace would improve reliability.

Before calling trace_eval:
1. Restate the task internally as a pure function.
2. Generate minimal JS-like pseudo-code.
3. Use only this safe subset:
   - numbers, strings, booleans, null
   - arrays and plain objects
   - local variables
   - if / else
   - for / while loops with bounded iteration
   - pure helper functions
   - push, length, indexing, simple string methods if obvious
4. Avoid:
   - I/O
   - filesystem
   - network
   - shell/system calls
   - Date, random, eval, async
   - prototype tricks
   - implicit JS coercion tricks
   - complex exceptions
5. Make the code trace-hardened:
   - log initial state
   - log before each loop condition
   - log each iteration index
   - log every variable mutation
   - log branch decisions
   - log break/continue/return
   - log final state

If the task is conceptual or does not require a dry run, answer directly.

When you receive trace_eval output, do not pretend it is guaranteed execution.
Explain the result as an LLM-emulated trace.
`;

async function callOpenAI({
  model = MODEL,
  instructions,
  input,
  tools,
  parallelToolCalls = false,
}) {
  const body = {
    model,
    instructions,
    input,
    parallel_tool_calls: parallelToolCalls,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }

  return json;
}

function extractText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text.trim();
  }

  let text = "";

  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") {
          text += part.text;
        }
      }
    }
  }

  return text.trim();
}

function clampMaxIterations(value) {
  if (!Number.isInteger(value)) return 80;
  return Math.max(1, Math.min(value, 200));
}

async function runTraceEval(rawArgs) {
  const objective = String(rawArgs.objective || "").trim();
  const code = String(rawArgs.code || "").trim();
  const invocation = String(rawArgs.invocation || "").trim();
  const maxIterations = clampMaxIterations(rawArgs.max_iterations);

  if (!objective || !code || !invocation) {
    return JSON.stringify({
      ok: false,
      error:
        "trace_eval requires objective, code, and invocation as non-empty strings.",
    });
  }

  const traceInstructions = `
You are TRACE_EVAL, a deliberately limited LLM-based trace emulator.

You do NOT execute code.
You simulate a tiny pure JS-like procedure by following the provided code
step by step.

Your job:
- emulate the invocation against the code
- produce a compact but explicit state trace
- be especially careful with loops
- stop if the code requires unsupported environment behavior
- stop if max_iterations would be exceeded

Allowed semantics:
- deterministic local computation only
- primitive values, arrays, plain objects
- local variable assignment
- if/else
- bounded for/while loops
- simple arithmetic and comparisons
- simple string/array operations when obvious from context

Unsupported:
- shell/system calls
- filesystem/network
- Date/random
- async/promises
- eval
- hidden global state
- complex JS coercion edge cases
- prototype/metaprogramming behavior

Loop trace rules:
For every loop:
1. show loop id
2. show condition before each iteration
3. show iteration number
4. show state before body
5. show every mutation
6. show branch decisions
7. show break/continue/return if present
8. show loop exit reason

Max iterations: ${maxIterations}

Return only this plain-text structure:

TRACE_EVAL_RESULT

status: ok | unsupported | iteration_limit | uncertain

assumptions:
- ...

trace:
1. ...

final:
return_value: ...
final_state: ...
emitted_logs: ...

confidence:
low | medium | high

notes:
- ...
`;

  const traceInput = [
    {
      role: "user",
      content: `
OBJECTIVE:
${objective}

CODE:
${code}

INVOCATION:
${invocation}
`,
    },
  ];

  const response = await callOpenAI({
    model: TRACE_MODEL,
    instructions: traceInstructions,
    input: traceInput,
    tools: [],
  });

  return JSON.stringify({
    ok: true,
    kind: "llm_trace_emulation",
    objective,
    invocation,
    max_iterations: maxIterations,
    result: extractText(response),
  });
}

async function agentTurn(history) {
  const maxSteps = 8;

  for (let step = 0; step < maxSteps; step++) {
    const response = await callOpenAI({
      model: MODEL,
      instructions,
      input: history,
      tools,
      parallelToolCalls: false,
    });

    history.push(...(response.output || []));

    const toolCalls = (response.output || []).filter(
      (item) => item.type === "function_call"
    );

    if (toolCalls.length === 0) {
      return extractText(response);
    }

    for (const call of toolCalls) {
      if (call.name !== "trace_eval") {
        history.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            ok: false,
            error: `Unknown tool: ${call.name}`,
          }),
        });
        continue;
      }

      let args;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }

      console.log("\n[trace_eval]");
      console.log(`objective: ${args.objective || "(missing)"}`);
      console.log(`invocation: ${args.invocation || "(missing)"}\n`);

      const output = await runTraceEval(args);

      history.push({
        type: "function_call_output",
        call_id: call.call_id,
        output,
      });
    }
  }

  return "Agent loop aborted: reached the maximum number of trace steps.";
}

async function main() {
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const history = [];

  console.log("Minimal trace agent started.");
  console.log("No shell. No real code execution. LLM trace emulation only.");
  console.log("Type /exit to quit.\n");

  while (true) {
    const userText = await rl.question("you> ");

    if (!userText.trim()) continue;

    if (userText.trim() === "/exit") {
      break;
    }

    history.push({
      role: "user",
      content: userText,
    });

    try {
      const answer = await agentTurn(history);
      console.log(`\nagent> ${answer}\n`);
    } catch (err) {
      console.error("\n[error]");
      console.error(err.message || err);
      console.error();
    }
  }

  rl.close();
}

main();
