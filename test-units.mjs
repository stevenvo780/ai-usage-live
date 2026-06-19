import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTotals,
  sumRows,
  extractModels,
  mergeModels,
  buildCodexQuota,
  buildClaudeQuota,
  buildGeminiQuota,
  buildMiniMaxQuota,
  buildOpenCodeQuota,
  buildAntigravityQuota,
  buildTokenQuota,
  parseClaudeUsageOutput,
  parseOpenCodeServerUsage,
  parseResetDuration,
  parseClaudeResetText,
  claudeWindowKey,
  claudeWindowLabel,
  numberFromAny,
  bar,
  truncateAnsi,
  stripAnsi,
  visibleLength,
  fit,
  fmtCountdown,
  blockBar,
} from "./ai-usage-tui.mjs";

const HOUR_MS = 3600000;

test("normalizeTotals: basic inputs with cache tokens", () => {
  const result = normalizeTotals({
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 5,
  });

  assert.strictEqual(result.inputTokens, 100);
  assert.strictEqual(result.outputTokens, 50);
  assert.strictEqual(result.cacheCreationTokens, 10);
  assert.strictEqual(result.cacheReadTokens, 5);
  assert.strictEqual(result.totalTokens, 165); // input + output + cache creation + cache read
  assert.strictEqual(result.effectiveTokens, 160); // input + output + cacheCreation
});

test("normalizeTotals: empty object defaults to zero", () => {
  const result = normalizeTotals({});

  assert.strictEqual(result.inputTokens, 0);
  assert.strictEqual(result.outputTokens, 0);
  assert.strictEqual(result.cacheCreationTokens, 0);
  assert.strictEqual(result.cacheReadTokens, 0);
  assert.strictEqual(result.totalTokens, 0);
  assert.strictEqual(result.effectiveTokens, 0);
  assert.strictEqual(result.totalCost, 0);
});

test("normalizeTotals: totalCost with fallback keys", () => {
  const result = normalizeTotals({
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.5,
  });

  assert(result.totalCost >= 0.4); // cost fallback key
});

test("sumRows: aggregates numeric fields across rows", () => {
  const rows = [
    {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      totalCost: 0.01,
    },
    {
      inputTokens: 20,
      outputTokens: 15,
      totalTokens: 35,
      totalCost: 0.02,
    },
  ];
  const result = sumRows(rows);

  assert.strictEqual(result.inputTokens, 30);
  assert.strictEqual(result.outputTokens, 20);
  assert.strictEqual(result.totalTokens, 50);
  assert.strictEqual(result.totalCost, 0.03);
});

test("sumRows: empty array returns empty object", () => {
  const result = sumRows([]);
  assert.deepEqual(result, {});
});

test("extractModels: from row.models object", () => {
  const row = {
    models: {
      "claude-3-5": {
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
      },
      "gpt-4": { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
    },
    totalTokens: 125,
    totalCost: 0.1,
  };
  const result = extractModels(row);

  assert(Array.isArray(result));
  assert.strictEqual(result.length, 2);
  assert(result.some((m) => m.modelName === "claude-3-5"));
  assert(result.some((m) => m.modelName === "gpt-4"));
});

test("extractModels: from row.modelsUsed single entry", () => {
  const row = {
    modelsUsed: ["claude-3-5"],
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    totalCost: 0.15,
  };
  const result = extractModels(row);

  assert(Array.isArray(result));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].modelName, "claude-3-5");
});

test("extractModels: returns empty array when no models", () => {
  const row = { name: "test", totalCost: 0.05 };
  const result = extractModels(row);

  assert(Array.isArray(result));
  assert.strictEqual(result.length, 0);
});

test("mergeModels: aggregates models by name", () => {
  const modelList = [
    {
      modelName: "claude-3-5",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      cost: 0.05,
    },
    {
      modelName: "claude-3-5",
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 50,
      cost: 0.03,
    },
    {
      modelName: "gpt-4",
      inputTokens: 20,
      outputTokens: 15,
      totalTokens: 35,
      cost: 0.04,
    },
  ];
  const result = mergeModels(modelList);

  assert(Array.isArray(result));
  const claude = result.find((m) => m.modelName === "claude-3-5");
  assert(claude);
  assert.strictEqual(claude.inputTokens, 80);
  assert.strictEqual(claude.totalTokens, 125);
});

test("buildTokenQuota: creates quota with configured-tokens kind", () => {
  const result = buildTokenQuota(
    "test-source",
    { totals: { totalTokens: 500 } },
    1000,
    "5h window"
  );

  assert.strictEqual(result.source, "test-source");
  assert.strictEqual(result.kind, "configured-tokens");
  assert.strictEqual(result.used, 500);
  assert.strictEqual(result.limit, 1000);
  assert.strictEqual(result.remaining, 500);
  assert.strictEqual(result.usedPercent, 50);
});

test("buildTokenQuota: returns unknown kind with zero limit", () => {
  const result = buildTokenQuota("test", { totals: { totalTokens: 0 } }, 0, "label");
  assert.strictEqual(result.source, "test");
  assert.strictEqual(result.kind, "unknown");
  assert.strictEqual(result.ok, false);
});

test("parseClaudeUsageOutput: parses percentage from text", () => {
  const text = "Claude usage\nCurrent 5h: 45% used";
  const result = parseClaudeUsageOutput(text);

  assert(result.windows);
  assert(Array.isArray(result.windows));
  assert(result.windows.length > 0);
});

test("parseClaudeUsageOutput: empty text returns no windows", () => {
  const result = parseClaudeUsageOutput("");

  assert(Array.isArray(result.windows));
  assert.strictEqual(result.windows.length, 0);
});

test("claudeWindowKey: returns string key from label", () => {
  const key = claudeWindowKey("5h");
  assert(typeof key === "string");
  assert(key.length > 0);
});

test("claudeWindowLabel: returns human label from key", () => {
  const label = claudeWindowLabel("5h");
  assert(typeof label === "string");
  assert(label.length > 0);
});

test("numberFromAny: returns first finite number from keys", () => {
  const obj = { a: 0, b: 5, c: 10 };
  const result = numberFromAny(obj, ["a", "b", "c"]);

  assert.strictEqual(result, 0); // 0 is finite
});

test("numberFromAny: returns null when no finite number found", () => {
  const obj = { x: "text", y: undefined, z: null };
  const result = numberFromAny(obj, ["x", "y", "z", "missing"]);

  assert.strictEqual(result, null);
});

test("bar: generates bar string without crashing", () => {
  const result = bar(50, 100, 10, "");

  assert(typeof result === "string");
});

test("bar: handles NaN gracefully", () => {
  const result = bar(NaN, 100, 10, "");

  assert(typeof result === "string");
  // Should not throw, result may be empty or placeholder
});

test("stripAnsi: removes ANSI escape codes", () => {
  const text = "\x1b[31mhello\x1b[0m world";
  const result = stripAnsi(text);

  assert.strictEqual(result, "hello world");
});

test("visibleLength: counts characters without ANSI codes", () => {
  const text = "\x1b[31mhello\x1b[0m";
  const result = visibleLength(text);

  assert.strictEqual(result, 5);
});

test("fit: respects width constraint", () => {
  const result = fit("hello world extra text", 5);

  assert(typeof result === "string");
  assert(visibleLength(result) <= 5);
});

test("truncateAnsi: truncates colored text preserving ANSI", () => {
  const text = "\x1b[31mhello world\x1b[0m";
  const result = truncateAnsi(text, 6);

  assert(typeof result === "string");
  assert(visibleLength(result) <= 6);
});

test("buildMiniMaxQuota: creates quota from usage", () => {
  const usage = { cost5h: 100, costWeek: 250, costMonth: 800 };
  const config = { limits: { minimax: 1000 } };
  const result = buildMiniMaxQuota(usage, config);

  assert(result.source);
  assert(result.kind);
  assert.strictEqual(typeof result.ok, "boolean");
});

test("buildOpenCodeQuota: creates quota with windows when override enabled", () => {
  const usage = { cost5h: 50, costWeek: 150, costMonth: 500 };
  const config = {
    fiveHourCost: 1000,
    weeklyCost: 1000,
    monthlyCost: 1000,
    serverOverride: {
      enabled: true,
      fiveHourUsed: 200,
      weeklyUsed: 400,
      monthlyUsed: 600,
    },
  };
  const result = buildOpenCodeQuota(usage, config);

  assert(result.source);
  assert(result.windows);
  assert(Array.isArray(result.windows));
  assert(result.windows.length > 0);
  assert.strictEqual(typeof result.ok, "boolean");
});

// --- Refuerzos Opus: valores concretos, no solo tipos ---

test("buildAntigravityQuota: configured credits -> 25% used, 750 left", () => {
  const q = buildAntigravityQuota(
    { installed: true, sessions: 3, modelSteps: 9 },
    { monthlyCredits: 1000, usedCredits: 250 },
  );
  assert.strictEqual(q.kind, "configured-credits");
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.used, 250);
  assert.strictEqual(q.limit, 1000);
  assert.strictEqual(q.remaining, 750);
  assert.strictEqual(q.usedPercent, 25);
  assert.strictEqual(q.remainingPercent, 75);
});

test("buildAntigravityQuota: installed but unconfigured -> unknown, ok true, points to Gemini", () => {
  const q = buildAntigravityQuota({ installed: true, sessions: 1, modelSteps: 2 }, {});
  assert.strictEqual(q.kind, "unknown");
  assert.strictEqual(q.ok, true);
  assert.match(q.note, /Gemini/);
});

test("buildAntigravityQuota: not installed -> ok false", () => {
  const q = buildAntigravityQuota({ installed: false }, { monthlyCredits: 1000 });
  assert.strictEqual(q.ok, false);
});

test("buildMiniMaxQuota: model_remains -> per-model 5h/sem windows with used = 100 - remaining", () => {
  const now = Date.now();
  const q = buildMiniMaxQuota(
    {
      ok: true,
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 50,
          current_weekly_remaining_percent: 30,
          end_time: now + 4 * HOUR_MS,
          weekly_end_time: now + 5 * 24 * HOUR_MS,
        },
      ],
    },
    {},
  );
  assert.strictEqual(q.kind, "detected-percent");
  const fiveH = q.windows.find((w) => w.label === "general 5h");
  const week = q.windows.find((w) => w.label === "general sem");
  assert(fiveH && week);
  assert.strictEqual(fiveH.usedPercent, 50);
  assert.strictEqual(fiveH.remainingPercent, 50);
  assert.strictEqual(week.usedPercent, 70);
});

test("buildOpenCodeQuota: serverOverride uses override values (source=server), not local data", () => {
  const q = buildOpenCodeQuota(
    { ok: true, data: { cost5h: 99, costWeek: 99, costMonth: 99 } },
    {
      fiveHourCost: 12,
      weeklyCost: 30,
      monthlyCost: 60,
      serverOverride: { enabled: true, fiveHourUsed: 6, weeklyUsed: 3, monthlyUsed: 6 },
    },
  );
  assert.strictEqual(q.kind, "detected-percent");
  const w5 = q.windows.find((w) => w.key === "5h");
  assert(w5);
  assert.strictEqual(w5.source, "server");
  assert.strictEqual(w5.used, 6); // override, not local 99
  assert.strictEqual(w5.usedPercent, 50); // 6/12
});

test("buildOpenCodeQuota: local path computes windows from db costs (source=local)", () => {
  const q = buildOpenCodeQuota(
    { ok: true, data: { cost5h: 6, costWeek: 15, costMonth: 30 } },
    { fiveHourCost: 12, weeklyCost: 30, monthlyCost: 60, serverOverride: { enabled: false } },
  );
  const w5 = q.windows.find((w) => w.key === "5h");
  assert(w5);
  assert.strictEqual(w5.source, "local");
  assert.strictEqual(w5.usedPercent, 50);
});

test("buildCodexQuota: configured-tokens path when rate limits disabled", () => {
  const q = buildCodexQuota(
    { totals: { totalTokens: 250000 } },
    { useDetectedRateLimits: false, dailyTokens: 1000000 },
  );
  assert.strictEqual(q.kind, "configured-tokens");
  assert.strictEqual(q.usedPercent, 25);
});

test("bar: NaN produces no filled cells", () => {
  const out = stripAnsi(bar(NaN, 100, 10, ""));
  assert(!out.includes("#"));
});

test("bar: 50% fills exactly half", () => {
  const out = stripAnsi(bar(50, 100, 10, ""));
  assert.strictEqual((out.match(/#/g) || []).length, 5);
});

test("truncateAnsi: preserves the color code seen before the cut", () => {
  const out = truncateAnsi("\x1b[31mhello world\x1b[0m", 6);
  assert(out.includes("\x1b[31m")); // color preserved
  assert(out.endsWith("\x1b[0m")); // RESET appended
  assert(visibleLength(out) <= 6);
});

test("buildAntigravityQuota: live buckets -> detected-percent with used = (1-remainingFraction)*100", () => {
  const live = {
    ok: true,
    buckets: [
      {
        modelId: "gemini-3-pro-preview",
        remainingFraction: 0.5,
        resetTime: "2026-06-20T16:00:00Z",
        tokenType: "REQUESTS",
      },
      {
        modelId: "gemini-2.5-flash",
        remainingFraction: 1,
        resetTime: "2026-06-20T16:00:00Z",
        tokenType: "REQUESTS",
      },
    ],
  };
  const q = buildAntigravityQuota({ installed: true, sessions: 5, modelSteps: 10 }, {}, live);
  assert.strictEqual(q.kind, "detected-percent");
  assert(Array.isArray(q.windows));
  assert(q.windows.length > 0);
  const w = q.windows.find((x) => x.label.startsWith("gemini-3-pro"));
  assert(w, "should have a gemini-3-pro window");
  assert.strictEqual(w.usedPercent, 50);
  assert.strictEqual(w.remainingPercent, 50);
  assert(!w.label.includes("-preview"), `label should not include "-preview", got: ${w.label}`);
});

test("buildAntigravityQuota: live preferred over config manual", () => {
  const live = {
    ok: true,
    buckets: [
      { modelId: "gemini-3-pro-preview", remainingFraction: 0.5, resetTime: "2026-06-20T16:00:00Z", tokenType: "REQUESTS" },
      { modelId: "gemini-2.5-flash", remainingFraction: 1, resetTime: "2026-06-20T16:00:00Z", tokenType: "REQUESTS" },
    ],
  };
  const q = buildAntigravityQuota({ installed: true }, { monthlyCredits: 1000, usedCredits: 900 }, live);
  assert.strictEqual(q.kind, "detected-percent");
  assert(Array.isArray(q.windows));
});

test("buildAntigravityQuota: sin live, con config manual -> configured-credits", () => {
  const q = buildAntigravityQuota({ installed: true }, { monthlyCredits: 1000, usedCredits: 250 }, null);
  assert.strictEqual(q.kind, "configured-credits");
  assert.strictEqual(q.used, 250);
  assert.strictEqual(q.limit, 1000);
  assert.strictEqual(q.usedPercent, 25);
  assert.strictEqual(q.remainingPercent, 75);
});

test("parseOpenCodeServerUsage: extrae rolling/weekly/monthly", () => {
  const html = '<span data-slot="usage-label">Rolling Usage</span><span data-slot="usage-value"><!--$-->25<!--/-->%</span><div data-slot="progress"><div data-slot="progress-bar" style="width:25%"></div></div><span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->1 hour 11 minutes<!--/--></span><span data-slot="usage-label">Weekly Usage</span><span data-slot="usage-value"><!--$-->52<!--/-->%</span><span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->2 days 6 hours<!--/--></span><span data-slot="usage-label">Monthly Usage</span><span data-slot="usage-value"><!--$-->26<!--/-->%</span><span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->5 days<!--/--></span>';
  const r = parseOpenCodeServerUsage(html);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.windows.length, 3);

  const w5h = r.windows.find((w) => w.key === "5h");
  const wWeek = r.windows.find((w) => w.key === "week");
  const wMonth = r.windows.find((w) => w.key === "month");
  assert.ok(w5h);
  assert.ok(wWeek);
  assert.ok(wMonth);

  assert.strictEqual(w5h.usedPercent, 25);
  assert.strictEqual(w5h.remainingPercent, 75);
  assert.strictEqual(w5h.source, "web");
  assert.strictEqual(wWeek.usedPercent, 52);
  assert.strictEqual(wMonth.usedPercent, 26);

  for (const w of r.windows) {
    assert.ok(w.reset === null || w.reset instanceof Date, `window ${w.key}.reset debe ser Date o null`);
    assert.ok(w.resetText, `window ${w.key}.resetText debe ser truthy`);
  }
});

test("parseOpenCodeServerUsage: HTML vacío -> ok false", () => {
  const result = parseOpenCodeServerUsage("<html></html>");
  assert.strictEqual(result.ok, false);
});

test("parseResetDuration: '2 days 6 hours' -> Date ~ +54h", () => {
  const d = parseResetDuration("2 days 6 hours");
  assert.ok(d instanceof Date);
  const deltaMs = d.getTime() - Date.now();
  assert.ok(deltaMs >= 53.9 * HOUR_MS);
  assert.ok(deltaMs <= 54.1 * HOUR_MS);

  assert.strictEqual(parseResetDuration("texto sin numeros"), null);
});

test("fmtCountdown: null and undefined return --", () => {
  assert.strictEqual(fmtCountdown(null), "--");
  assert.strictEqual(fmtCountdown(undefined), "--");
});

test("fmtCountdown: ~1.5h formats as XhYm", () => {
  const out = fmtCountdown(new Date(Date.now() + 5400000));
  assert.match(out, /^1h\d{1,2}m$/);
});

test("fmtCountdown: ~2 days formats as XdYh", () => {
  const out = fmtCountdown(new Date(Date.now() + (2 * 86400000 + 3600000)));
  assert.match(out, /^2d\s?\d+h$/);
});

test("fmtCountdown: past/now returns string without throwing", () => {
  const out = fmtCountdown(new Date(Date.now() - 1000));
  assert.strictEqual(typeof out, "string");
});

test("blockBar: 50% in width=10 -> 5 filled and 5 empty cells", () => {
  const out = stripAnsi(blockBar(50, 10, ""));
  assert.strictEqual((out.match(/█/g) || []).length, 5);
  assert.strictEqual((out.match(/░/g) || []).length, 5);
});

test("blockBar: NaN produces no filled cells and does not crash", () => {
  const out = stripAnsi(blockBar(NaN, 10, ""));
  assert(!out.includes("█"));
});

test("parseClaudeResetText: 'Jun 22, 10am (UTC)' -> Date at 10:00 UTC, future", () => {
  const d = parseClaudeResetText("Jun 22, 10am (UTC)");
  assert(d instanceof Date);
  assert.strictEqual(d.getUTCHours(), 10);
  assert.strictEqual(d.getUTCMinutes(), 0);
  assert.strictEqual(d.getUTCMonth(), 5); // junio
});

test("parseClaudeResetText: '7:10pm' -> 19:10 UTC", () => {
  const d = parseClaudeResetText("Jun 19, 7:10pm (UTC)");
  assert.strictEqual(d.getUTCHours(), 19);
  assert.strictEqual(d.getUTCMinutes(), 10);
});

test("parseClaudeResetText: garbage/empty -> null", () => {
  assert.strictEqual(parseClaudeResetText("nonsense xyz"), null);
  assert.strictEqual(parseClaudeResetText(""), null);
});
