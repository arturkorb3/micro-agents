#!/usr/bin/env node

/**
 * Minimal LLM agent with a single shell tool. Cross-platform:
 * runs commands in PowerShell on Windows and POSIX sh on Linux/macOS.
 *
 * Requirements:
 *   Node.js 18+ (for global fetch)
 *
 * Run:
 *   # bash / zsh
 *   OPENAI_API_KEY="sk-..." node agent.js
 *   # PowerShell
 *   $env:OPENAI_API_KEY="sk-..."; node agent.js
 *   # or, with Node 20.6+, load a .env file:
 *   node --env-file=.env agent.js
 *
 * Optional: OPENAI_MODEL="gpt-4o" to override the model.
 *
 * WARNING:
 *   This runs shell commands the model proposes. No sandbox, no isolation,
 *   no hardening. Only use on throwaway VMs / data you do not care about.
 */

const readline = require("node:readline/promises");
const { stdin: inputStream, stdout: outputStream } = require("node:process");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");

const sh = promisify(exec);

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// Cross-platform shell: PowerShell on Windows, POSIX sh elsewhere.
const IS_WINDOWS = process.platform === "win32";
const SHELL = IS_WINDOWS ? "powershell.exe" : "/bin/sh";
const SHELL_NAME = IS_WINDOWS ? "PowerShell" : "POSIX sh";

if (!API_KEY) {
  console.error("Missing environment variable: OPENAI_API_KEY");
  process.exit(1);
}

const tools = [
  {
    type: "function",
    name: "shell",
    description:
      "Run a shell command on the local system and return stdout, stderr and the exit status.",
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
  },
];

const instructions = `
You are a minimal local CLI agent. You talk with the user and have exactly one
tool: shell.

Host OS: ${process.platform}. The shell tool runs commands in ${SHELL_NAME}, so
use ${SHELL_NAME} syntax (${IS_WINDOWS
  ? "e.g. Get-ChildItem, Get-Content, $env:VAR"
  : "e.g. ls, cat, $VAR"}).

Use shell when you need information from the local system or when the user asks
you to run something locally. Briefly explain what you did. Never invent shell
output. If a command fails, explain the error from stderr/stdout.
`;

async function callOpenAI(input) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input,
      tools,
      parallel_tool_calls: false,
    }),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }

  return json;
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

function extractText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
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

async function agentTurn(history) {
  const maxSteps = 10;

  for (let step = 0; step < maxSteps; step++) {
    const response = await callOpenAI(history);

    // Keep the model's full output, including reasoning / function_call items.
    history.push(...(response.output || []));

    const toolCalls = (response.output || []).filter(
      (item) => item.type === "function_call"
    );

    if (toolCalls.length === 0) {
      return extractText(response);
    }

    for (const call of toolCalls) {
      if (call.name !== "shell") {
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

      const command = args.command;

      if (typeof command !== "string" || command.length === 0) {
        history.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            ok: false,
            error: "Missing argument: command",
          }),
        });
        continue;
      }

      console.log(`\n[shell] ${command}\n`);

      const output = await runShell(command);

      history.push({
        type: "function_call_output",
        call_id: call.call_id,
        output,
      });
    }
  }

  return "Agent loop aborted: reached the maximum number of tool steps.";
}

async function main() {
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const history = [];

  console.log(`Minimal shell agent started (${SHELL_NAME}).`);
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
