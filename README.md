# micro-agent

> **Minimalster LLM-Agent für die lokale CLI** — ein einziges Tool: `shell`.

Ein vollständiger Agentenloop in einer einzigen Datei (`agent.js`, ~200 Zeilen).  
Kein Framework, keine Dependencies, nur Node.js 18+.

---

## ⚠️ Sicherheitshinweis

**Dieses Projekt ist ein Lern- und Demonstrations-Snippet. Es ist ausdrücklich NICHT für den produktiven Einsatz geeignet.**

- Das Modell kann **beliebige Shell-Kommandos** auf deinem System ausführen lassen — ohne Bestätigung, ohne Einschränkung.
- Es gibt **keine Sandbox, keine Isolation, keine Zugriffskontrolle**.
- Ein kompromittiertes oder manipuliertes Modell (Prompt Injection) könnte destruktive Kommandos ausführen.
- Führe das Script **niemals** als root/Administrator aus.
- Nutze es **niemals** in Netzwerken oder auf Systemen mit sensiblen Daten.

**Nur auf dedizierten Wegwerf-VMs oder in Containern mit Netzwerkisolation betreiben, wenn überhaupt.**

---

## Funktionsweise

```
Nutzer → [history] → OpenAI Responses API
                          ↓
                    function_call: shell
                          ↓
                    exec(command)
                          ↓
                    function_call_output → [history] → nächster Turn
```

Der Loop läuft bis zu 10 Schritte pro Nutzer-Nachricht. Dann wird abgebrochen.

---

## Voraussetzungen

- Node.js 18+ (wegen globalem `fetch`)
- Ein OpenAI API Key mit Zugriff auf `gpt-4.1` (oder ein anderes Modell deiner Wahl)

---

## Schnellstart

```bash
export OPENAI_API_KEY="sk-..."
node agent.js
```

Optionales Modell überschreiben:

```bash
OPENAI_MODEL="gpt-4o" node agent.js
```

---

## Beispiel-Session

```
Minimal Shell-Agent gestartet.
Beenden mit: /exit

du> welche Node-Version läuft hier?

[shell] node --version

agent> Du verwendest Node.js v22.3.0.

du> /exit
```

---

## Architektur in Kürze

| Teil | Beschreibung |
|---|---|
| `callOpenAI(input)` | Schickt den kompletten History-Array an die Responses API |
| `runShell(command)` | Führt ein Shell-Kommando aus, gibt JSON mit stdout/stderr zurück |
| `agentTurn(history)` | Loop: API aufrufen → Tool-Calls ausführen → wiederholen bis Text-Antwort |
| `main()` | REPL: Nutzereingabe lesen → `agentTurn` → Antwort ausgeben |

---

## Warum die Responses API?

Die OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses) vereinfacht den Agentenloop: Die History ist stateful serverseitig verwaltbar, und `output_text` liefert den finalen Text direkt — kein manuelles `choices[0].message.content` parsen.

---

## Lizenz

MIT
