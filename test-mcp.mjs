import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

test("MCP exposes versioned structured quota output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-usage-mcp-test-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const ccusage = path.join(binDir, "ccusage");
  writeFileSync(ccusage, `#!/bin/sh
case " $* " in
  *" blocks "*) printf '%s\\n' '{"blocks":[],"totals":{}}' ;;
  *) printf '%s\\n' '{"daily":[],"totals":{}}' ;;
esac
`);
  chmodSync(ccusage, 0o755);

  const child = spawn(process.execPath, [path.resolve("ai-usage-mcp.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      PATH: `${binDir}:${process.env.PATH || ""}`,
      AI_USAGE_CLAUDE_LIVE: "0",
      AI_USAGE_CODEX_LIVE: "0",
      AI_USAGE_GEMINI_LIVE: "0",
      AI_USAGE_ANTIGRAVITY_LIVE: "0",
      AI_USAGE_MINIMAX_LIVE: "0",
      AI_USAGE_OPENCODE_LIVE: "0",
      AI_USAGE_OPENCODE_WEB: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const replies = new Map();
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.write("{not-json}\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ai_quotas", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_ai_quotas", arguments: { extra: true } } });
    send({ jsonrpc: "1.0", id: 5, method: "ping" });

    const deadline = Date.now() + 20000;
    while ((!replies.has(null) || !replies.has(1) || !replies.has(2) || !replies.has(3) || !replies.has(4) || !replies.has(5)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(replies.has(3), `MCP timed out: ${stderr}`);

    assert.strictEqual(replies.get(1).result.protocolVersion, "2025-11-25");
    assert.match(replies.get(1).result.serverInfo.version, /^\d+\.\d+\.\d+/);
    const tool = replies.get(2).result.tools.find((item) => item.name === "get_ai_quotas");
    assert.ok(tool.outputSchema);
    assert.strictEqual(tool.annotations.readOnlyHint, true);
    assert.strictEqual(replies.get(null).error.code, -32700);
    assert.strictEqual(replies.get(4).error.code, -32602);
    assert.strictEqual(replies.get(5).error.code, -32600);

    const call = replies.get(3).result;
    assert.ok(call.structuredContent);
    assert.strictEqual(call.structuredContent.schemaVersion, 2);
    assert.deepEqual(JSON.parse(call.content[0].text), call.structuredContent);
    assert.deepEqual(Object.keys(call.structuredContent.providers), [
      "claude", "codex", "gemini", "antigravity", "minimax", "opencode",
    ]);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

// Fast-path: un ping (o initialize/tools/list) debe responderse de inmediato aunque haya
// un tools/call lento en vuelo (la captura spawnea CLIs y puede tardar). Regresion del bug
// de serializacion global que dejaba pings sin responder -> timeout/desconexion del cliente.
test("MCP answers ping promptly while a slow tools/call is in flight", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-usage-mcp-fastpath-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const ccusage = path.join(binDir, "ccusage");
  // ccusage lento: fuerza que runQuotaSnapshot tarde ~1.2s.
  writeFileSync(ccusage, `#!/bin/sh
sleep 1.2
case " $* " in
  *" blocks "*) printf '%s\\n' '{"blocks":[],"totals":{}}' ;;
  *) printf '%s\\n' '{"daily":[],"totals":{}}' ;;
esac
`);
  chmodSync(ccusage, 0o755);

  const child = spawn(process.execPath, [path.resolve("ai-usage-mcp.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      PATH: `${binDir}:${process.env.PATH || ""}`,
      AI_USAGE_CLAUDE_LIVE: "0",
      AI_USAGE_CODEX_LIVE: "0",
      AI_USAGE_GEMINI_LIVE: "0",
      AI_USAGE_ANTIGRAVITY_LIVE: "0",
      AI_USAGE_MINIMAX_LIVE: "0",
      AI_USAGE_OPENCODE_LIVE: "0",
      AI_USAGE_OPENCODE_WEB: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const replyTimes = new Map();
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && message.id !== null && !replyTimes.has(message.id)) {
          replyTimes.set(message.id, Date.now());
        }
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Dispara la captura lenta y, sin esperar, un ping.
    const callSentAt = Date.now();
    send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_ai_quotas", arguments: {} } });
    send({ jsonrpc: "2.0", id: 11, method: "ping" });

    const deadline = Date.now() + 20000;
    while ((!replyTimes.has(10) || !replyTimes.has(11)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(replyTimes.has(11), `ping never answered: ${stderr}`);
    assert.ok(replyTimes.has(10), `tools/call never answered: ${stderr}`);

    const pingLatency = replyTimes.get(11) - callSentAt;
    const callLatency = replyTimes.get(10) - callSentAt;
    // El ping se responde muy antes que el tools/call lento (no queda encolado detras).
    assert.ok(pingLatency < 500, `ping latency too high (${pingLatency}ms) — quedo encolado detras del tools/call`);
    assert.ok(callLatency > 800, `tools/call sospechosamente rapido (${callLatency}ms); el stub deberia tardar ~1.2s`);
    assert.ok(pingLatency < callLatency, `ping (${pingLatency}ms) deberia responder antes que tools/call (${callLatency}ms)`);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

// Filtrado: un proveedor oculto en quotas.json display NO aparece en el output del MCP,
// salvo con AI_USAGE_SHOW_ALL=1 (mismo comportamiento que la TUI, decision del usuario).
test("MCP respects display visibility filter and AI_USAGE_SHOW_ALL", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-usage-mcp-filter-"));
  const binDir = path.join(root, "bin");
  const cfgDir = path.join(root, "config", "ai-usage-live");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, "quotas.json"), JSON.stringify({
    version: 2,
    display: { hideUnusable: true, hiddenProviders: ["minimax", "opencode"], hiddenModels: [] },
  }));
  const ccusage = path.join(binDir, "ccusage");
  writeFileSync(ccusage, `#!/bin/sh
case " $* " in
  *" blocks "*) printf '%s\\n' '{"blocks":[],"totals":{}}' ;;
  *) printf '%s\\n' '{"daily":[],"totals":{}}' ;;
esac
`);
  chmodSync(ccusage, 0o755);

  const baseEnv = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    PATH: `${binDir}:${process.env.PATH || ""}`,
    AI_USAGE_CLAUDE_LIVE: "0",
    AI_USAGE_CODEX_LIVE: "0",
    AI_USAGE_GEMINI_LIVE: "0",
    AI_USAGE_ANTIGRAVITY_LIVE: "0",
    AI_USAGE_MINIMAX_LIVE: "0",
    AI_USAGE_OPENCODE_LIVE: "0",
    AI_USAGE_OPENCODE_WEB: "0",
  };

  const callProviders = async (extraEnv) => {
    const child = spawn(process.execPath, [path.resolve("ai-usage-mcp.mjs")], {
      cwd: path.resolve("."),
      env: { ...process.env, ...baseEnv, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const replies = new Map();
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (c) => { stderr += c; });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        let nl;
        while ((nl = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.id !== undefined && m.id !== null) replies.set(m.id, m);
        }
      });
      const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_ai_quotas", arguments: null } });
      const deadline = Date.now() + 20000;
      while (!replies.has(2) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(replies.has(2), `MCP timed out: ${stderr}`);
      return Object.keys(replies.get(2).result.structuredContent.providers);
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  };

  try {
    const filtered = await callProviders({});
    assert.ok(!filtered.includes("minimax"), `minimax deberia estar oculto: ${filtered}`);
    assert.ok(!filtered.includes("opencode"), `opencode deberia estar oculto: ${filtered}`);
    assert.ok(filtered.includes("claude"), `claude deberia seguir visible: ${filtered}`);

    const all = await callProviders({ AI_USAGE_SHOW_ALL: "1" });
    assert.ok(all.includes("minimax") && all.includes("opencode"), `SHOW_ALL deberia incluir todos: ${all}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
