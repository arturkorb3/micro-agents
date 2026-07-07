#!/usr/bin/env node

/**
 * trace-dag-agent.js
 *
 * Minimal LLM micro-agent with one pseudo-tool: trace_program.
 *
 * No shell.
 * No filesystem access.
 * No real code execution.
 *
 * The "tool" is a stateless LLM-based trace emulator.
 *
 * Architecture:
 *
 *   Persistent outer agent context
 *      ->
 *   trace_program function call
 *      ->
 *   local orchestrator executes a Procedure DAG/Pipeline
 *      ->
 *   for each node: stateless LLM trace-eval call
 *      ->
 *   node return values are composed
 *      ->
 *   final program result is injected back into outer context
 *
 * Requirements:
 *   Node.js 18+ for global fetch
 *
 * Run:
 *   OPENAI_API_KEY="sk-..." node trace-dag-agent.js
 *
 * Optional:
 *   OPENAI_MODEL="gpt-5.5" node trace-dag-agent.js
 *   OPENAI_TRACE_MODEL="gpt-5.5" node trace-dag-agent.js
 *
 * Commands:
 *   /exit
 *   /reset
 *
 * WARNING:
 *   This is not a real interpreter.
 *   It is an LLM-based structured dry-run fallback.
 */

const readline = require("node:readline/promises");
const { stdin: inputStream, stdout: outputStream } = require("node:process");

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const TRACE_MODEL = process.env.OPENAI_TRACE_MODEL || MODEL;
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const MAX_AGENT_STEPS = 8;
const MAX_PROGRAM_NODES = 12;
const MAX_PROCEDURES = 16;
const MAX_CODE_CHARS = 16_000;
const MAX_INPUT_JSON_CHARS = 24_000;
const MAX_TOOL_OUTPUT_CHARS = 80_000;

if (!API_KEY) {
  console.error("Missing environment variable: OPENAI_API_KEY");
  process.exit(1);
}

/**
 * The outer agent has exactly one visible tool.
 *
 * trace_program accepts:
 * - a set of pure procedures
 * - an ordered list of program nodes
 * - each node calls exactly one procedure
 * - each node has input_json
 * - input_json may contain refs to previous node return values:
 *
 *     {"$ref": "node_id"}
 *
 *   or nested:
 *
 *     {
 *       "names": {"$ref": "normalize.return_value"},
 *       "limit": 10
 *     }
 *
 * For this minimal version, "$ref": "node_id" and
 * "$ref": "node_id.return_value" are equivalent.
 */
const tools = [
  {
    type: "function",
    name: "trace_program",
    description:
      "Compose and dry-run a small pure dataflow program. Uses stateless LLM trace-eval per procedure node. Does not execute code.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "What the whole composed program is supposed to compute or transform.",
        },
        program: {
          type: "object",
          description:
            "Procedure registry plus ordered DAG/pipeline nodes. Nodes may refer to previous node outputs via {\"$ref\":\"node_id\"}.",
          properties: {
            procedures: {
              type: "array",
              description:
                "Small pure JS-like procedures. Every procedure should accept exactly one argument named input.",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description:
                      "Procedure name. Must be a simple identifier and unique.",
                  },
                  purpose: {
                    type: "string",
                    description: "What this procedure does.",
                  },
                  input_schema: {
                    type: "string",
                    description:
                      "Human-readable input shape, e.g. array<string> or { names: array<string> }.",
                  },
                  output_schema: {
                    type: "string",
                    description:
                      "Human-readable output shape, e.g. array<string> or object<string, number>.",
                  },
                  code: {
                    type: "string",
                    description:
                      "Small pure JS-like function with exactly one parameter named input. Must be trace-hardened with trace(...) calls/comments.",
                  },
                  max_iterations: {
                    type: "integer",
                    description:
                      "Hard loop iteration cap for this procedure. Suggested range 20-120.",
                  },
                },
                required: [
                  "name",
                  "purpose",
                  "input_schema",
                  "output_schema",
                  "code",
                  "max_iterations",
                ],
                additionalProperties: false,
              },
            },
            nodes: {
              type: "array",
              description:
                "Ordered program nodes. Each node invokes one procedure. Refs may only target earlier nodes.",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Unique node id, e.g. normalize or count.",
                  },
                  procedure: {
                    type: "string",
                    description:
                      "Name of the procedure from the procedure registry.",
                  },
                  input_json: {
                    type: "string",
                    description:
                      "JSON string for the node input. May include refs like {\"$ref\":\"previous_node\"}.",
                  },
                },
                required: ["id", "procedure", "input_json"],
                additionalProperties: false,
              },
            },
          },
          required: ["procedures", "nodes"],
          additionalProperties: false,
        },
      },
      required: ["objective", "program"],
      additionalProperties: false,
    },
  },
];

const outerInstructions = `
You are a minimal CLI micro-agent.

You have exactly one tool: trace_program.

The tool is NOT a runtime, NOT a JavaScript engine, NOT a shell, and NOT a
programming environment. It is an LLM-based dry-run fallback for tiny pure
programs.

Use trace_program when:
- the user asks for a small deterministic computation or transformation,
- a multi-step procedure/pipeline would help,
- trace-based reasoning would improve reliability,
- no real execution environment is needed.

Do not use trace_program for:
- shell commands
- filesystem operations
- network operations
- system calls
- real code execution
- time, randomness, environment-dependent behavior
- security-critical or correctness-critical computation
- very large data

When using trace_program, construct a tiny Procedure DAG/Pipeline:

1. Define procedures:
   - each procedure is pure
   - each procedure accepts exactly one parameter named input
   - each procedure returns exactly one value
   - procedures may use local variables only
   - use simple arrays, plain objects, strings, numbers, booleans, null
   - use if/else, for/while with bounded loops
   - use simple indexing, length, push, trim, toLowerCase, split, join when obvious
   - avoid JS coercion tricks and edge cases

2. Make every procedure trace-hardened:
   - trace initial state
   - trace loop condition before each iteration
   - trace iteration index
   - trace every variable mutation
   - trace branch decisions
   - trace break/continue/return
   - trace final state

3. Compose procedures via nodes:
   - each node calls one procedure
   - each node input_json is a JSON string
   - use {"$ref":"node_id"} to pass a previous node's return value
   - use nested refs for multi-input nodes, e.g.
     {"names":{"$ref":"normalize"},"limit":10}

4. Keep programs small:
   - prefer 2-5 procedures
   - avoid recursion
   - avoid global state
   - avoid mutual procedure calls
   - avoid deeply nested data
   - avoid huge traces

After trace_program returns:
- present the final result
- mention that it is an LLM-emulated trace, not real execution
- include relevant intermediate values only if useful
- surface uncertainty if any node reports low confidence, unsupported behavior,
  parse failure, or iteration limit.
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

  const res = await fetch(`${OPENAI_BASE_URL}/responses`, {
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

function safeJsonStringify(value, space = 2) {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return String(value);
  }
}

function parseJsonStrict(text, label) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON for ${label}: ${err.message}`,
      raw: text,
    };
  }
}

function clampInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

function truncateString(s, maxChars) {
  if (typeof s !== "string") s = String(s);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n...[truncated ${s.length - maxChars} chars]`;
}

function validateIdentifier(name, kind) {
  if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Invalid ${kind}: ${safeJsonStringify(name)}`);
  }
}

function validateNodeId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`Invalid node id: ${safeJsonStringify(id)}`);
  }
}

/**
 * Resolve refs inside node input JSON.
 *
 * Supported:
 *   {"$ref": "node_id"}
 *   {"$ref": "node_id.return_value"}
 *
 * Refs can appear nested inside arrays/objects.
 */
function resolveRefs(value, nodeResults) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, nodeResults));
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);

    if (keys.length === 1 && keys[0] === "$ref") {
      const ref = value.$ref;

      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`Invalid $ref: ${safeJsonStringify(ref)}`);
      }

      const nodeId = ref.endsWith(".return_value")
        ? ref.slice(0, -".return_value".length)
        : ref;

      if (!Object.prototype.hasOwnProperty.call(nodeResults, nodeId)) {
        throw new Error(
          `Reference to unknown or not-yet-executed node: ${ref}`
        );
      }

      return nodeResults[nodeId].return_value;
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveRefs(v, nodeResults);
    }
    return out;
  }

  return value;
}

/**
 * Stateless LLM-based trace evaluator for a single procedure call.
 *
 * It receives:
 * - one procedure
 * - one concrete input value
 *
 * It returns JSON with:
 * - status
 * - trace
 * - return_value
 * - final_state
 * - confidence
 */
async function traceEvalProcedure({
  globalObjective,
  procedure,
  nodeId,
  inputValue,
}) {
  const maxIterations = clampInteger(
    procedure.max_iterations,
    80,
    1,
    200
  );

  const invocation = `${procedure.name}(${safeJsonStringify(inputValue, 0)})`;

  const traceInstructions = `
You are TRACE_EVAL, a deliberately limited LLM-based trace emulator.

You do NOT execute code.
You do NOT have a JavaScript runtime.
You simulate a tiny pure JS-like procedure step by step.

Return ONLY valid JSON.
Do not wrap the JSON in markdown.
Do not add commentary outside the JSON.

Required JSON shape:

{
  "status": "ok | unsupported | iteration_limit | uncertain",
  "procedure": "string",
  "node_id": "string",
  "assumptions": ["string"],
  "trace": ["string"],
  "return_value": null,
  "final_state": {},
  "emitted_logs": ["string"],
  "confidence": "low | medium | high",
  "notes": ["string"]
}

Semantics:
- Treat trace(...) calls as emitted logs only.
- Do not execute real JavaScript.
- Emulate the code carefully and explicitly.
- If a semantic detail is unclear, choose "uncertain" and explain in notes.
- If unsupported behavior is required, choose "unsupported".
- If a loop would exceed max_iterations, choose "iteration_limit".

Allowed:
- deterministic local computation only
- primitive values, arrays, plain objects
- local variables
- if / else
- bounded for / while loops
- simple arithmetic and comparisons
- simple string/array operations when obvious:
  length, indexing, push, trim, toLowerCase, toUpperCase, split, join, includes

Unsupported:
- filesystem
- network
- shell/system calls
- Date/random
- async/promises
- eval
- hidden global state
- prototype/metaprogramming behavior
- complex exceptions
- complex JS coercion edge cases

Loop trace rules:
For every loop, show:
1. loop id
2. condition before each iteration
3. iteration number
4. state before body
5. every mutation
6. branch decisions
7. break/continue/return if present
8. loop exit reason

Max loop iterations for this procedure: ${maxIterations}

Keep the trace compact but sufficient.
`;

  const traceInput = [
    {
      role: "user",
      content: `
GLOBAL_OBJECTIVE:
${globalObjective}

NODE_ID:
${nodeId}

PROCEDURE_MANIFEST:
${safeJsonStringify(
  {
    name: procedure.name,
    purpose: procedure.purpose,
    input_schema: procedure.input_schema,
    output_schema: procedure.output_schema,
    max_iterations: maxIterations,
  },
  2
)}

CODE:
${procedure.code}

INVOCATION:
${invocation}

CONCRETE_INPUT_JSON:
${safeJsonStringify(inputValue, 2)}
`,
    },
  ];

  const response = await callOpenAI({
    model: TRACE_MODEL,
    instructions: traceInstructions,
    input: traceInput,
    tools: [],
  });

  const text = extractText(response);
  const parsed = parseJsonStrict(text, `trace result for node ${nodeId}`);

  if (!parsed.ok) {
    return {
      ok: false,
      status: "uncertain",
      procedure: procedure.name,
      node_id: nodeId,
      assumptions: [],
      trace: [],
      return_value: null,
      final_state: {},
      emitted_logs: [],
      confidence: "low",
      notes: [parsed.error],
      raw_result: truncateString(parsed.raw, 8_000),
    };
  }

  const value = parsed.value;

  return {
    ok: value.status === "ok",
    status: typeof value.status === "string" ? value.status : "uncertain",
    procedure:
      typeof value.procedure === "string" ? value.procedure : procedure.name,
    node_id: typeof value.node_id === "string" ? value.node_id : nodeId,
    assumptions: Array.isArray(value.assumptions) ? value.assumptions : [],
    trace: Array.isArray(value.trace) ? value.trace : [],
    return_value: Object.prototype.hasOwnProperty.call(value, "return_value")
      ? value.return_value
      : null,
    final_state:
      value.final_state && typeof value.final_state === "object"
        ? value.final_state
        : {},
    emitted_logs: Array.isArray(value.emitted_logs) ? value.emitted_logs : [],
    confidence:
      value.confidence === "high" ||
      value.confidence === "medium" ||
      value.confidence === "low"
        ? value.confidence
        : "low",
    notes: Array.isArray(value.notes) ? value.notes : [],
  };
}

/**
 * The host-side pseudo-tool implementation.
 *
 * It does not execute generated procedure code.
 * It orchestrates stateless LLM trace calls per node.
 */
async function runTraceProgram(args) {
  const objective = String(args.objective || "").trim();
  const program = args.program;

  if (!objective) {
    return JSON.stringify({
      ok: false,
      error: "Missing objective.",
    });
  }

  if (!program || typeof program !== "object") {
    return JSON.stringify({
      ok: false,
      error: "Missing program object.",
    });
  }

  const procedures = Array.isArray(program.procedures)
    ? program.procedures
    : [];
  const nodes = Array.isArray(program.nodes) ? program.nodes : [];

  if (procedures.length === 0) {
    return JSON.stringify({
      ok: false,
      error: "Program has no procedures.",
    });
  }

  if (nodes.length === 0) {
    return JSON.stringify({
      ok: false,
      error: "Program has no nodes.",
    });
  }

  if (procedures.length > MAX_PROCEDURES) {
    return JSON.stringify({
      ok: false,
      error: `Too many procedures. Max: ${MAX_PROCEDURES}.`,
    });
  }

  if (nodes.length > MAX_PROGRAM_NODES) {
    return JSON.stringify({
      ok: false,
      error: `Too many nodes. Max: ${MAX_PROGRAM_NODES}.`,
    });
  }

  const procedureMap = Object.create(null);

  try {
    for (const p of procedures) {
      validateIdentifier(p.name, "procedure name");

      if (procedureMap[p.name]) {
        throw new Error(`Duplicate procedure name: ${p.name}`);
      }

      if (typeof p.code !== "string" || p.code.trim().length === 0) {
        throw new Error(`Procedure ${p.name} has empty code.`);
      }

      if (p.code.length > MAX_CODE_CHARS) {
        throw new Error(
          `Procedure ${p.name} code is too long. Max: ${MAX_CODE_CHARS} chars.`
        );
      }

      procedureMap[p.name] = p;
    }

    const seenNodeIds = new Set();
    for (const n of nodes) {
      validateNodeId(n.id);

      if (seenNodeIds.has(n.id)) {
        throw new Error(`Duplicate node id: ${n.id}`);
      }

      seenNodeIds.add(n.id);

      validateIdentifier(n.procedure, "node procedure reference");

      if (!procedureMap[n.procedure]) {
        throw new Error(
          `Node ${n.id} references unknown procedure: ${n.procedure}`
        );
      }

      if (typeof n.input_json !== "string") {
        throw new Error(`Node ${n.id} input_json must be a string.`);
      }

      if (n.input_json.length > MAX_INPUT_JSON_CHARS) {
        throw new Error(
          `Node ${n.id} input_json is too long. Max: ${MAX_INPUT_JSON_CHARS} chars.`
        );
      }
    }
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err.message,
    });
  }

  const nodeResults = Object.create(null);
  const orderedResults = [];
  let halted = false;
  let haltReason = null;

  for (const node of nodes) {
    if (halted) break;

    const parsedInput = parseJsonStrict(node.input_json, `input_json of node ${node.id}`);

    if (!parsedInput.ok) {
      const result = {
        id: node.id,
        procedure: node.procedure,
        ok: false,
        status: "uncertain",
        error: parsedInput.error,
        return_value: null,
        confidence: "low",
      };

      nodeResults[node.id] = result;
      orderedResults.push(result);
      halted = true;
      haltReason = `Could not parse input_json for node ${node.id}.`;
      break;
    }

    let concreteInput;
    try {
      concreteInput = resolveRefs(parsedInput.value, nodeResults);
    } catch (err) {
      const result = {
        id: node.id,
        procedure: node.procedure,
        ok: false,
        status: "uncertain",
        error: err.message,
        return_value: null,
        confidence: "low",
      };

      nodeResults[node.id] = result;
      orderedResults.push(result);
      halted = true;
      haltReason = `Could not resolve refs for node ${node.id}.`;
      break;
    }

    const procedure = procedureMap[node.procedure];

    console.log(`[trace_program] node=${node.id} procedure=${procedure.name}`);

    const traceResult = await traceEvalProcedure({
      globalObjective: objective,
      procedure,
      nodeId: node.id,
      inputValue: concreteInput,
    });

    const compactResult = {
      id: node.id,
      procedure: procedure.name,
      purpose: procedure.purpose,
      input_schema: procedure.input_schema,
      output_schema: procedure.output_schema,
      input: concreteInput,
      ok: traceResult.ok,
      status: traceResult.status,
      return_value: traceResult.return_value,
      final_state: traceResult.final_state,
      emitted_logs: traceResult.emitted_logs,
      trace: traceResult.trace,
      confidence: traceResult.confidence,
      assumptions: traceResult.assumptions,
      notes: traceResult.notes,
    };

    if (traceResult.raw_result) {
      compactResult.raw_result = traceResult.raw_result;
    }

    nodeResults[node.id] = compactResult;
    orderedResults.push(compactResult);

    if (traceResult.status !== "ok") {
      halted = true;
      haltReason = `Node ${node.id} ended with status: ${traceResult.status}`;
    }
  }

  const lastCompleted = orderedResults[orderedResults.length - 1] || null;

  const output = {
    ok: !halted && !!lastCompleted && lastCompleted.status === "ok",
    kind: "llm_trace_program",
    objective,
    halted,
    halt_reason: haltReason,
    final_node_id: lastCompleted ? lastCompleted.id : null,
    final_return_value: lastCompleted ? lastCompleted.return_value : null,
    nodes: orderedResults,
    warning:
      "This is an LLM-emulated trace program result, not real code execution.",
  };

  return truncateString(JSON.stringify(output, null, 2), MAX_TOOL_OUTPUT_CHARS);
}

async function agentTurn(history) {
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const response = await callOpenAI({
      model: MODEL,
      instructions: outerInstructions,
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
      if (call.name !== "trace_program") {
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
      } catch (err) {
        history.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            ok: false,
            error: `Could not parse tool arguments: ${err.message}`,
          }),
        });
        continue;
      }

      console.log("\n[trace_program]");
      console.log(`objective: ${args.objective || "(missing)"}`);

      const nodeCount =
        args.program && Array.isArray(args.program.nodes)
          ? args.program.nodes.length
          : 0;
      const procedureCount =
        args.program && Array.isArray(args.program.procedures)
          ? args.program.procedures.length
          : 0;

      console.log(`procedures: ${procedureCount}`);
      console.log(`nodes: ${nodeCount}\n`);

      let output;
      try {
        output = await runTraceProgram(args);
      } catch (err) {
        output = JSON.stringify({
          ok: false,
          error: err.message || String(err),
        });
      }

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

  let history = [];

  console.log("Minimal Trace-DAG agent started.");
  console.log("No shell. No real code execution. LLM trace emulation only.");
  console.log(`Outer model: ${MODEL}`);
  console.log(`Trace model: ${TRACE_MODEL}`);
  console.log("Commands: /exit, /reset\n");

  while (true) {
    const userText = await rl.question("you> ");
    const trimmed = userText.trim();

    if (!trimmed) continue;

    if (trimmed === "/exit") {
      break;
    }

    if (trimmed === "/reset") {
      history = [];
      console.log("\n[history reset]\n");
      continue;
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

main().catch((err) => {
  console.error("[fatal]");
  console.error(err.message || err);
  process.exit(1);
});