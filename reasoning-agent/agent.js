#!/usr/bin/env node

/**
 * Minimal "reasoning wrapper" agent: a fixed orchestration scaffold that makes
 * a non-reasoning model behave, from the outside, like a reasoning model.
 *
 * The model itself is unchanged — the scaffold forces it through phases:
 *
 *   PLAN      decompose the task (schema-enforced JSON via Structured Outputs)
 *   EXECUTE   work through the plan step by step (shell only if the plan
 *             requested it — host-side gating)
 *   CRITIQUE  review the draft (schema-enforced accept/revise verdict)
 *   FINALIZE  produce a clean final answer, free of scaffold traces
 *
 * PLAN and CRITIQUE use Structured Outputs (text.format json_schema, strict)
 * so the model cannot drift out of its phase role or produce unparseable
 * verdicts — the scaffold's control flow rests on host-verified JSON, not on
 * regexes over free text.
 *
 * Everything before FINALIZE is printed dimmed as "thinking" and — like
 * reasoning tokens in native reasoning models — is NOT kept in the persistent
 * conversation history. Only the user message and the final answer persist.
 *
 * Requirements:
 *   Node.js 18+ (for global fetch)
 *
 * Run:
 *   OPENAI_API_KEY="sk-..." node agent.js
 *
 * Optional:
 *   OPENAI_MODEL="gpt-4.1"              the (non-reasoning) model to wrap
 *   REASONING_EFFORT="low|medium|high"  critique/revision budget (default medium)
 *
 * WARNING:
 *   The shell tool runs real commands. No sandbox, no confirmation. See the
 *   shell-agent security warning; only use on throwaway machines.
 */

const readline = require("node:readline/promises");
const { stdin: inputStream, stdout: outputStream } = require("node:process");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");

const sh = promisify(exec);

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const EFFORT = (process.env.REASONING_EFFORT || "medium").toLowerCase();

// Critique/revision budget per effort level, mimicking a reasoning-effort knob.
const MAX_REVISIONS = { low: 0, medium: 1, high: 2 }[EFFORT] ?? 1;

const IS_WINDOWS = process.platform === "win32";
const SHELL = IS_WINDOWS ? "powershell.exe" : "/bin/sh";
const SHELL_NAME = IS_WINDOWS ? "PowerShell" : "POSIX sh";

if (!API_KEY) {
  console.error("Missing environment variable: OPENAI_API_KEY");
  process.exit(1);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function thinking(label, text) {
  if (!text) return;
  const indented = text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  console.log(`${DIM}[thinking:${label}]\n${indented}${RESET}\n`);
}

const shellTool = {
  type: "function",
  name: "shell",
  description:
    "Run a shell command on the local system and return stdout, stderr and the exit status. Use it only when the task genuinely needs local system information or verification.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

const BASE_CONTEXT = `
You are the inner model of a reasoning scaffold. The host program forces you
through fixed phases (plan, execute, critique, finalize). Follow the phase
instructions exactly; never mix phases.

Host OS: ${process.platform}. The shell tool (when offered) runs commands in
${SHELL_NAME}, so use ${SHELL_NAME} syntax (${IS_WINDOWS
  ? "e.g. Get-ChildItem, Get-Content, $env:VAR"
  : "e.g. ls, cat, $VAR"}).
`;

const PLAN_INSTRUCTIONS = `${BASE_CONTEXT}
PHASE: PLAN

Do not answer the user's request yet. Fill the required JSON plan object:

- task: restate the task in one sentence.
- expected_answer: the exact form the answer must take. If the input offers
  candidate answers, the answer must be one of them.
- steps: 2-6 small, checkable sub-steps. Classify each step:
  - "mechanical": exact symbol work (counting, arithmetic, transforming,
    enumerating, mapping symbols to values) — one slipped symbol changes
    the result.
  - "conceptual": judgment, explanation, interpretation, recall.
- risks: what is uncertain or easy to get wrong (may be empty).
- needs_system_access: true if the task concerns the local system itself
  (files, processes, installed software, environment).

Be compact. No final answer, no pleasantries, no refusals — planning only.
`;

// Structured Outputs (text.format json_schema, strict): the plan cannot
// drift into answering, refusing, or free-form chatter.
const PLAN_FORMAT = {
  type: "json_schema",
  name: "plan",
  strict: true,
  schema: {
    type: "object",
    properties: {
      task: { type: "string" },
      expected_answer: {
        type: "string",
        description:
          "Exact required answer form. If the input offers candidate answers, the answer must be exactly one of them.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            kind: {
              type: "string",
              enum: ["mechanical", "conceptual"],
              description:
                "mechanical = exact symbol work (counting, arithmetic, transformation, enumeration) where one slipped symbol changes the result; conceptual = judgment, explanation, recall.",
            },
          },
          required: ["description", "kind"],
          additionalProperties: false,
        },
      },
      risks: { type: "array", items: { type: "string" } },
      needs_system_access: {
        type: "boolean",
        description:
          "true only if the task concerns the local system itself (files, processes, installed software, environment).",
      },
    },
    required: [
      "task",
      "expected_answer",
      "steps",
      "risks",
      "needs_system_access",
    ],
    additionalProperties: false,
  },
};

const EXECUTE_INSTRUCTIONS = `${BASE_CONTEXT}
PHASE: EXECUTE

Work through your plan step by step and produce a DRAFT answer.

Rules:
- Follow the plan; reason in small, visible steps with exact intermediate
  values, never by assertion or resemblance.
- A rule inferred from given data may only be used after it reproduces ALL
  the given data exactly; then derive the answer by applying it forward.
- When the shell tool is offered, mechanical steps MUST be done with it,
  not in your head; never invent shell output.
- Mark claims you are unsure about with (unsure).
- End with the draft answer. It may still be rough; a critique phase follows.
`;

const CRITIQUE_INSTRUCTIONS = `${BASE_CONTEXT}
PHASE: CRITIQUE

You are now the critic. Review the draft answer above against the original
user request and the plan.

Check:
- Does it answer what was asked, in the expected answer form from the plan?
  If the input offered candidate answers, the draft must pick exactly one.
- Spot-check at least one intermediate result yourself instead of trusting
  the chain.
- Any inferred rule must reproduce ALL the given data exactly, and the
  result must be derived from it — not picked by resemblance.
- A mechanical result not verified via the shell tool is a defect; demand
  revision with shell verification.

Fill the required JSON verdict object:
- verdict: "accept" or "revise".
- problems: concrete, actionable defects ([] when accepting).

Problems must concern the CONTENT of the draft relative to the user's
request: wrong results, broken reasoning, unmet answer form. Formats,
phases, JSON structures and this scaffold are host concerns — never list
them as problems. Accept unless there is a real defect; do not nitpick
style.
`;

const CRITIQUE_FORMAT = {
  type: "json_schema",
  name: "critique",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["accept", "revise"] },
      problems: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "problems"],
    additionalProperties: false,
  },
};

const REVISE_INSTRUCTIONS = `${BASE_CONTEXT}
PHASE: EXECUTE (revision)

The critic found content defects, listed above. Produce an improved DRAFT
ANSWER to the original user request — normal prose for the user, never JSON
and never a reply to the critic. Re-derive anything the critic flagged
instead of patching the wording; ignore critic points that are not about
the content of the answer. You may use the shell tool if a flagged point
can be verified locally.
`;

const FINALIZE_INSTRUCTIONS = `${BASE_CONTEXT}
PHASE: FINALIZE

Write the final answer for the user, based on the accepted draft.

Rules:
- Clean, self-contained, directly addressing the user's request.
- Preserve the accepted draft's concrete result EXACTLY — values, names,
  chosen options must be copied verbatim. You rewrite the presentation,
  never the content.
- No mention of plans, drafts, critics, phases, or this scaffold.
- Keep genuinely useful caveats; drop resolved (unsure) markers.
- Match the user's language.
`;

async function callOpenAI({ instructions, input, tools, textFormat }) {
  const body = {
    model: MODEL,
    instructions,
    input,
    parallel_tool_calls: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (textFormat) {
    body.text = { format: textFormat };
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
  if (typeof response.output_text === "string" && response.output_text) {
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

async function runShell(command) {
  try {
    const result = await sh(command, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      shell: SHELL,
    });

    return JSON.stringify({
      ok: true,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    return JSON.stringify({
      ok: false,
      command,
      exitCode: err.code ?? null,
      signal: err.signal ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    });
  }
}

/**
 * Tool-using loop for the execute phases: call the model, run shell calls,
 * feed outputs back, until the model answers with plain text (the draft).
 */
async function executeLoop(workingHistory, instructions, allowShell) {
  const maxSteps = 8;
  let usedShell = false;

  for (let step = 0; step < maxSteps; step++) {
    const response = await callOpenAI({
      instructions,
      input: workingHistory,
      tools: allowShell ? [shellTool] : [],
    });

    workingHistory.push(...(response.output || []));

    const toolCalls = (response.output || []).filter(
      (item) => item.type === "function_call"
    );

    if (toolCalls.length === 0) {
      return { text: extractText(response), usedShell };
    }

    for (const call of toolCalls) {
      let output;

      if (call.name !== "shell") {
        output = JSON.stringify({
          ok: false,
          error: `Unknown tool: ${call.name}`,
        });
      } else {
        let args;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }

        const command = typeof args.command === "string" ? args.command : "";

        if (!command) {
          output = JSON.stringify({
            ok: false,
            error: "Missing argument: command",
          });
        } else {
          console.log(`${DIM}[thinking:shell] ${command}${RESET}\n`);
          output = await runShell(command);
          usedShell = true;
        }
      }

      workingHistory.push({
        type: "function_call_output",
        call_id: call.call_id,
        output,
      });
    }
  }

  return {
    text: "Draft aborted: reached the maximum number of tool steps.",
    usedShell,
  };
}

function parseJSON(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function planNeedsShell(plan) {
  return (
    plan.needs_system_access ||
    plan.steps.some((s) => s.kind === "mechanical")
  );
}

function formatPlan(plan) {
  const lines = [
    `task: ${plan.task}`,
    `expected answer: ${plan.expected_answer}`,
    ...plan.steps.map((s, i) => `  ${i + 1}. [${s.kind}] ${s.description}`),
  ];
  if (plan.risks.length > 0) {
    lines.push(`risks: ${plan.risks.join("; ")}`);
  }
  lines.push(
    `shell: ${planNeedsShell(plan) ? "granted" : "not granted"}` +
      (plan.needs_system_access ? " (system access)" : "")
  );
  return lines.join("\n");
}

/**
 * One full "reasoning" turn. Works on a throwaway copy of the conversation:
 * plan, drafts and critiques never enter the persistent history.
 */
async function reasoningTurn(conversation, userText) {
  const workingHistory = [...conversation, { role: "user", content: userText }];

  // PLAN — schema-enforced JSON, cannot drift into answering or refusing.
  // Retry once on a parse failure: a plan-less working history derails
  // every later phase, so silently continuing is worse than a second call.
  let plan = null;
  let planResponse = null;
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    planResponse = await callOpenAI({
      instructions: PLAN_INSTRUCTIONS,
      input: workingHistory,
      textFormat: PLAN_FORMAT,
    });
    plan = parseJSON(extractText(planResponse), null);
  }
  if (!plan) {
    plan = {
      task: "",
      expected_answer: "",
      steps: [],
      risks: [],
      needs_system_access: true, // fail open on a parse failure
    };
  }
  workingHistory.push(...(planResponse.output || []));
  thinking("plan", formatPlan(plan));

  // EXECUTE — the host grants the shell if the task needs system access or
  // any plan step is mechanical (host-side gating, not prompt discipline).
  const shellGranted = planNeedsShell(plan);
  let execution = await executeLoop(
    workingHistory,
    EXECUTE_INSTRUCTIONS,
    shellGranted
  );
  let draft = execution.text;
  thinking("draft", draft);

  // Host-enforced shell use: if the plan had mechanical steps but the draft
  // never touched the shell, force one revision — prompt rules alone are
  // not reliably followed by a non-reasoning model.
  const hasMechanical = plan.steps.some((s) => s.kind === "mechanical");
  if (shellGranted && hasMechanical && !execution.usedShell) {
    thinking("host", "mechanical steps were not shell-verified — forcing revision");
    workingHistory.push({
      role: "user",
      content:
        "CRITIC FINDINGS (host-verified list):\n1. The plan contains " +
        "mechanical steps, but no shell command was run. Redo the " +
        "mechanical steps using the shell tool and base the draft answer " +
        "on the shell output.",
    });
    execution = await executeLoop(workingHistory, REVISE_INSTRUCTIONS, true);
    draft = execution.text;
    thinking("revised draft", draft);
  }

  // CRITIQUE → REVISE loop — verdict is schema-enforced, no text parsing.
  for (let round = 0; round < MAX_REVISIONS; round++) {
    const critiqueResponse = await callOpenAI({
      instructions: CRITIQUE_INSTRUCTIONS,
      input: workingHistory,
      textFormat: CRITIQUE_FORMAT,
    });
    const critique = parseJSON(extractText(critiqueResponse), {
      verdict: "accept",
      problems: [],
    });
    thinking(
      "critique",
      critique.verdict === "accept"
        ? "verdict: accept"
        : `verdict: revise\n${critique.problems
            .map((p, i) => `  ${i + 1}. ${p}`)
            .join("\n")}`
    );

    if (critique.verdict !== "revise" || critique.problems.length === 0) break;

    workingHistory.push({
      role: "user",
      content: `CRITIC FINDINGS (host-verified list):\n${critique.problems
        .map((p, i) => `${i + 1}. ${p}`)
        .join("\n")}`,
    });
    // Revision may always use the shell: the critic might demand verification.
    execution = await executeLoop(workingHistory, REVISE_INSTRUCTIONS, true);
    draft = execution.text;
    thinking("revised draft", draft);
  }

  // FINALIZE
  const finalResponse = await callOpenAI({
    instructions: FINALIZE_INSTRUCTIONS,
    input: workingHistory,
  });
  const finalAnswer = extractText(finalResponse) || draft;

  // Like reasoning tokens: only user message + final answer persist.
  conversation.push({ role: "user", content: userText });
  conversation.push({ role: "assistant", content: finalAnswer });

  return finalAnswer;
}

async function main() {
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const conversation = [];

  console.log("Reasoning-wrapper agent started.");
  console.log(
    `Inner model: ${MODEL} (non-reasoning) · effort: ${EFFORT} · shell: ${SHELL_NAME}`
  );
  console.log("Dimmed output is the scaffold's forced 'thinking'.");
  console.log("Type /exit to quit.\n");

  while (true) {
    let userText;
    try {
      userText = await rl.question("you> ");
    } catch {
      break; // stdin closed (EOF, e.g. piped input)
    }

    if (!userText.trim()) continue;

    if (userText.trim() === "/exit") {
      break;
    }

    try {
      const answer = await reasoningTurn(conversation, userText);
      console.log(`agent> ${answer}\n`);
    } catch (err) {
      console.error("\n[error]");
      console.error(err.message || err);
      console.error();
    }
  }

  rl.close();
}

main();
