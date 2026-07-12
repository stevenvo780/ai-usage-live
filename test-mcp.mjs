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
    assert.match(replies.get(1).result.serverInfo.version, /^0\.11\./);
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
