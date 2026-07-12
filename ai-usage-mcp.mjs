#!/usr/bin/env node
// Servidor MCP (stdio, JSON-RPC 2.0, zero-dep) que expone las cuotas de las
// suscripciones de IA locales para que agentes decidan que proveedor/modelo usar
// segun disponibilidad. Reusa la coleccion del TUI via runQuotaSnapshot().
//
// Uso en un cliente MCP (Claude Code, etc.):
//   { "mcpServers": { "ai-usage": { "command": "ai-usage-mcp" } } }
// o bien: { "command": "node", "args": ["/opt/ai-usage-live/ai-usage-mcp.mjs"] }
import process from "node:process";
import { APP_VERSION, runQuotaSnapshot } from "./ai-usage-tui.mjs";

const SERVER = { name: "ai-usage-live", version: APP_VERSION };
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const QUOTA_OUTPUT_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "appVersion", "capturedAt", "providers"],
  properties: {
    schemaVersion: { type: "number" },
    appVersion: { type: "string" },
    capturedAt: { type: "string" },
    since: { type: ["string", "null"] },
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["ok", "available", "kind", "windows", "note"],
        properties: {
          ok: { type: "boolean" },
          available: { type: "boolean" },
          kind: { type: "string" },
          stale: { type: "boolean" },
          needsAuth: { type: "boolean" },
          limited: { type: "boolean" },
          limitedRetry: { type: "string" },
          plan: { type: "string" },
          source: { type: "string" },
          detectedAt: { type: ["string", "null"] },
          observedAt: { type: "string" },
          ageSeconds: { type: "number" },
          effectiveRemainingPercent: { type: "number" },
          limitingWindows: { type: "array", items: { type: "string" } },
          incomplete: { type: "boolean" },
          missingWindows: { type: "array", items: { type: "string" } },
          availableGroups: { type: "array", items: { type: "string" } },
          limitingGroups: { type: "array", items: { type: "string" } },
          unavailableModels: { type: "array", items: { type: "string" } },
          offeredModels: { type: "array", items: { type: "string" } },
          resetCredits: { type: "object" },
          creditBalances: {
            type: "array",
            items: {
              type: "object",
              required: ["limitId", "planType", "hasCredits", "unlimited", "balance"],
              properties: {
                limitId: { type: "string" },
                planType: { type: "string" },
                hasCredits: { type: "boolean" },
                unlimited: { type: "boolean" },
                balance: { type: ["string", "null"] },
              },
              additionalProperties: false,
            },
          },
          windows: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "usedPercent", "remainingPercent", "resetInSeconds", "resetAt"],
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                usedPercent: { type: ["number", "null"] },
                remainingPercent: { type: ["number", "null"] },
                resetInSeconds: { type: ["number", "null"] },
                resetAt: { type: ["string", "null"] },
                windowMinutes: { type: "number" },
                windowType: { type: "string" },
                model: { type: "string" },
                limitText: { type: "string" },
                usedText: { type: "string" },
                family: { type: "string" },
                source: { type: "string" },
                status: { type: ["string", "number"] },
              },
              additionalProperties: true,
            },
          },
          note: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "get_ai_quotas",
    title: "Read AI quotas",
    description:
      "Devuelve el uso/cuota actual de las suscripciones de IA locales (Claude, Codex, Gemini, " +
      "Antigravity [Gemini + Claude/GPT], MiniMax, OpenCode Go). Por cada proveedor da una " +
      "lista de ventanas con usedPercent, remainingPercent y resetInSeconds, para que un " +
      "agente elija un proveedor/modelo con cuota disponible. No recibe argumentos. La " +
      "primera llamada puede tardar (consulta los CLIs en vivo); luego usa cache.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: QUOTA_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params?.protocolVersion)
          ? params.protocolVersion
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: "Usa get_ai_quotas para leer ventanas de cuota actuales. remainingPercent es capacidad disponible.",
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
      const callArguments = params?.arguments;
      if (callArguments !== undefined && (
        !callArguments
        || typeof callArguments !== "object"
        || Array.isArray(callArguments)
        || Object.keys(callArguments).length > 0
      )) {
        replyError(id, -32602, "get_ai_quotas does not accept arguments");
        return;
      }
      try {
        const data = await runQuotaSnapshot();
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        });
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
let pending = Promise.resolve();

function enqueue(message) {
  pending = pending.then(() => handle(message)).catch((error) => {
    process.stderr.write(`ai-usage-mcp: ${error?.message || String(error)}\n`);
  });
}

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
      replyError(null, -32700, "Parse error");
      continue;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      replyError(msg && typeof msg === "object" ? (msg.id ?? null) : null, -32600, "Invalid Request");
      continue;
    }
    enqueue(msg);
  }
});
process.stdin.on("end", () => {
  pending.finally(() => process.exit(0));
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
