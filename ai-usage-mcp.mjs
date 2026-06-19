#!/usr/bin/env node
// Servidor MCP (stdio, JSON-RPC 2.0, zero-dep) que expone las cuotas de las
// suscripciones de IA locales para que agentes decidan que proveedor/modelo usar
// segun disponibilidad. Reusa la coleccion del TUI via runQuotaSnapshot().
//
// Uso en un cliente MCP (Claude Code, etc.):
//   { "mcpServers": { "ai-usage": { "command": "ai-usage-mcp" } } }
// o bien: { "command": "node", "args": ["/opt/ai-usage-live/ai-usage-mcp.mjs"] }
import process from "node:process";
import { runQuotaSnapshot } from "./ai-usage-tui.mjs";

const SERVER = { name: "ai-usage-live", version: "0.9.0" };

const TOOLS = [
  {
    name: "get_ai_quotas",
    description:
      "Devuelve el uso/cuota actual de las suscripciones de IA locales (Claude, Codex, " +
      "Antigravity [Gemini + Claude/GPT], MiniMax, OpenCode Go). Por cada proveedor da una " +
      "lista de ventanas con usedPercent, remainingPercent y resetInSeconds, para que un " +
      "agente elija un proveedor/modelo con cuota disponible. No recibe argumentos. La " +
      "primera llamada puede tardar (consulta los CLIs en vivo); luego usa cache.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      if (params?.name !== "get_ai_quotas") {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const data = await runQuotaSnapshot();
        reply(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (error) {
        reply(id, {
          content: [{ type: "text", text: `error: ${error?.message || String(error)}` }],
          isError: true,
        });
      }
      return;
    }
    case "ping":
      reply(id, {});
      return;
    default:
      // Las notificaciones (sin id) se ignoran; metodos desconocidos con id -> error.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
