#!/usr/bin/env node

/**
 * Minimalster LLM-Agent mit Shell-Tool.
 *
 * Voraussetzungen:
 *   Node.js 18+  wegen global fetch
 *
 * Start:
 *   export OPENAI_API_KEY="sk-..."
 *   node agent.js
 *
 * Optional:
 *   OPENAI_MODEL="gpt-5.5" node agent.js
 *
 * WARNUNG:
 *   Dieses Beispiel führt Shell-Kommandos aus, die das Modell vorschlägt.
 *   Keine Sandbox, keine Isolation, keine Härtung.
 */

const readline = require("node:readline/promises");
const { stdin: inputStream, stdout: outputStream } = require("node:process");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");

const sh = promisify(exec);

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

if (!API_KEY) {
  console.error("Fehlt: OPENAI_API_KEY");
  process.exit(1);
}

const tools = [
  {
    type: "function",
    name: "shell",
    description:
      "Führt ein Shell-Kommando auf dem lokalen System aus und gibt stdout, stderr und Exit-Status zurück.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Das auszuführende Shell-Kommando.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const instructions = `
Du bist ein minimaler lokaler CLI-Agent.
Du kannst mit dem Benutzer dialogisch sprechen.
Du hast genau ein Tool: shell.

Nutze shell, wenn du Informationen aus dem lokalen System brauchst
oder wenn der Benutzer dich bittet, etwas lokal auszuführen.

Erkläre kurz, was du getan hast.
Erfinde keine Shell-Ausgaben.
Wenn ein Kommando fehlschlägt, erkläre den Fehler anhand von stderr/stdout.
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
      shell: "/bin/sh",
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

    // Wichtig: komplette Modell-Ausgabe behalten, inklusive reasoning/function_call items.
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
            error: `Unbekanntes Tool: ${call.name}`,
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
            error: "Fehlendes Argument: command",
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

  return "Agent-Loop abgebrochen: maximale Tool-Schritte erreicht.";
}

async function main() {
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const history = [];

  console.log("Minimal Shell-Agent gestartet.");
  console.log("Beenden mit: /exit\n");

  while (true) {
    const userText = await rl.question("du> ");

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
      console.error("\n[Fehler]");
      console.error(err.message || err);
      console.error();
    }
  }

  rl.close();
}

main();
