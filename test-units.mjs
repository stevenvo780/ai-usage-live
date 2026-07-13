import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTotals,
  sumRows,
  extractModels,
  mergeModels,
  buildCodexQuota,
  normalizeCodexRateLimitEntry,
  codexWindowLabel,
  parseCodexRetryTime,
  fmtTimeInTz,
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
  buildAgentQuotaSummary,
  enrichUnifiedReasoning,
  classifyProviderAvailability,
  isProviderVisible,
  windowModelKey,
  isModelVisible,
} from "./ai-usage-tui.mjs";

const HOUR_MS = 3600000;

test("parseCodexRetryTime: parses '5:43 AM' to next occurrence in host TZ", () => {
  const d = parseCodexRetryTime("5:43 AM");
  assert.ok(d instanceof Date);
  assert.equal(d.getHours(), 5);
  assert.equal(d.getMinutes(), 43);
  assert.ok(d.getTime() > Date.now()); // siempre la proxima ocurrencia
});

test("parseCodexRetryTime: handles PM and noon/midnight, rejects junk", () => {
  assert.equal(parseCodexRetryTime("11:30 PM").getHours(), 23);
  assert.equal(parseCodexRetryTime("12:00 AM").getHours(), 0);
  assert.equal(parseCodexRetryTime("12:15 PM").getHours(), 12);
  assert.equal(parseCodexRetryTime("nope"), null);
});

test("fmtTimeInTz: converts a UTC instant to America/Bogota (UTC-5)", () => {
  const utc543 = new Date("2026-06-20T05:43:00Z"); // 5:43 AM UTC
  assert.equal(fmtTimeInTz(utc543, "America/Bogota"), "12:43 AM"); // = medianoche pasada en CO
  assert.equal(fmtTimeInTz(utc543, ""), null); // sin tz -> null
});

test("buildCodexQuota: limited -> local retry time, countdown, no stale bars", () => {
  const q = buildCodexQuota({}, { probe: true, timezone: "America/Bogota" }, { ok: true, limited: true, retryText: "5:43 AM" });
  assert.equal(q.limited, true);
  assert.equal(q.limitedRetry, "12:43 AM"); // convertido a hora local del usuario
  assert.deepEqual(q.windows, []); // no muestra barras viejas de sesiones
  assert.match(q.note, /reintentar 12:43 AM/);
  assert.match(q.note, /en ~/); // incluye countdown
});

test("buildCodexQuota: Codex 0.144 labels a 10080-minute primary window as weekly", () => {
  const q = buildCodexQuota({}, {}, {
    ok: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1784487595 },
      secondary: null,
      planType: "plus",
    },
    rateLimitResetCredits: { availableCount: 3, credits: [] },
  });
  assert.strictEqual(q.windows.length, 1);
  assert.strictEqual(q.windows[0].label, "semana");
  assert.strictEqual(q.windows[0].windowMinutes, 10080);
  assert.strictEqual(q.windows[0].usedPercent, 5);
  assert.strictEqual(q.resetCredits.availableCount, 3);
  assert.match(q.note, /app-server/);
});

test("normalizeCodexRateLimitEntry: accepts camelCase app-server fields", () => {
  const entry = normalizeCodexRateLimitEntry({
    limitId: "codex",
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1780000000 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1780500000 },
    credits: { hasCredits: true, unlimited: false, balance: "10" },
    planType: "plus",
  });
  assert.strictEqual(entry.primary.window_minutes, 300);
  assert.strictEqual(entry.secondary.window_minutes, 10080);
  assert.strictEqual(entry.credits.has_credits, true);
  assert.strictEqual(entry.plan_type, "plus");
  assert.strictEqual(codexWindowLabel(300, "primary"), "5h");
  assert.strictEqual(codexWindowLabel(10080, "secondary"), "semana");
});

test("buildCodexQuota: includes an app-server individual spend limit", () => {
  const q = buildCodexQuota({}, {}, {
    ok: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 300 },
      individualLimit: { limit: "100", used: "25", remainingPercent: 75, resetsAt: 1780500000 },
    },
  });
  const individual = q.windows.find((window) => window.sourceWindow === "individual");
  assert.ok(individual);
  assert.strictEqual(individual.usedPercent, 25);
  assert.strictEqual(individual.remainingPercent, 75);
  assert.strictEqual(individual.limitText, "100");
});

test("buildCodexQuota: authoritative top-level limit overrides optimistic numeric windows", () => {
  const q = buildCodexQuota({}, {}, {
    ok: true,
    limited: true,
    retryText: "in 2 hours",
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 50, windowDurationMins: 300 },
      secondary: { usedPercent: 30, windowDurationMins: 10080 },
    },
  });
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.limited, true);
  assert.strictEqual(q.effectiveRemainingPercent, 0);
  assert.deepEqual(q.limitingGroups, ["codex"]);
  assert(q.windows.every((window) => window.status === "rate-limited"));
});

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

test("normalizeTotals: ccusage v20 reasoning is metadata already included in output", () => {
  const result = normalizeTotals({
    inputTokens: 100,
    outputTokens: 50,
    reasoningOutputTokens: 20,
    cacheCreationTokens: 10,
    cacheReadTokens: 5,
    totalTokens: 165,
    costUSD: 0.25,
  });
  assert.strictEqual(result.reasoningOutputTokens, 20);
  assert.strictEqual(result.totalTokens, 165);
  assert.strictEqual(result.effectiveTokens, 160);
  assert.strictEqual(result.totalCost, 0.25);
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
      reasoningOutputTokens: 3,
      totalTokens: 15,
      totalCost: 0.01,
    },
    {
      inputTokens: 20,
      outputTokens: 15,
      reasoningOutputTokens: 7,
      totalTokens: 35,
      totalCost: 0.02,
    },
  ];
  const result = sumRows(rows);

  assert.strictEqual(result.inputTokens, 30);
  assert.strictEqual(result.outputTokens, 20);
  assert.strictEqual(result.reasoningOutputTokens, 10);
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
        reasoningOutputTokens: 12,
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
  assert.strictEqual(result.find((m) => m.modelName === "claude-3-5").reasoningOutputTokens, 12);
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

test("enrichUnifiedReasoning: fills ccusage all totals and matching Codex models", () => {
  const sources = {
    all: {
      totals: { effectiveTokens: 100, reasoningOutputTokens: 0 },
      models: [
        { modelName: "gpt-5", effectiveTokens: 60, reasoningOutputTokens: 0 },
        { modelName: "MiniMax-M3", effectiveTokens: 40, reasoningOutputTokens: 0 },
      ],
    },
    codex: {
      totals: { reasoningOutputTokens: 25 },
      models: [{ modelName: "gpt-5", reasoningOutputTokens: 25 }],
    },
    opencode: {
      totals: { effectiveTokens: 40, reasoningOutputTokens: 0 },
      models: [{ modelName: "MiniMax-M3", effectiveTokens: 40, reasoningOutputTokens: 0 }],
    },
    opencodeLive: {
      data: { totalReasoning: 10, reasoningByModel: { "minimax-m3": 10 } },
    },
  };
  enrichUnifiedReasoning(sources);
  assert.strictEqual(sources.all.totals.reasoningOutputTokens, 35);
  assert.strictEqual(sources.all.totals.effectiveTokens, 110);
  assert.strictEqual(sources.all.models[0].reasoningOutputTokens, 25);
  assert.strictEqual(sources.all.models[0].effectiveTokens, 60);
  assert.strictEqual(sources.all.models[1].reasoningOutputTokens, 10);
  assert.strictEqual(sources.all.models[1].effectiveTokens, 50);
  assert.strictEqual(sources.opencode.totals.reasoningOutputTokens, 10);
  assert.strictEqual(sources.opencode.totals.effectiveTokens, 50);
  assert.strictEqual(sources.opencode.models[0].reasoningOutputTokens, 10);
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

test("parseClaudeUsageOutput: preserves a model-specific Fable weekly quota", () => {
  const result = parseClaudeUsageOutput([
    "Current session: 10% used · resets Jul 12, 8:49pm (UTC)",
    "Current week (all models): 94% used · resets Jul 13, 9:59am (UTC)",
    "Current week (Fable): 15% used · resets Jul 13, 9:59am (UTC)",
  ].join("\n"));
  assert.deepEqual(result.windows.map((window) => window.key), ["session", "week_all", "week_fable"]);
  assert.deepEqual(result.windows.map((window) => window.label), ["sesion", "semana", "Fable"]);
});

test("buildClaudeQuota: migrates cached Fable entries that were mislabeled as global", () => {
  const q = buildClaudeQuota({}, {}, {}, {
    ok: true,
    windows: [
      { key: "week_all", label: "semana", rawLabel: "week (all models)", usedPercent: 10, remainingPercent: 90 },
      { key: "week_all", label: "semana", rawLabel: "week (Fable)", usedPercent: 100, remainingPercent: 0 },
    ],
  });
  assert.deepEqual(q.windows.map((window) => window.key), ["week_all", "week_fable"]);
  assert.deepEqual(q.windows.map((window) => window.label), ["semana", "Fable"]);
  assert.strictEqual(q.available, true);
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

test("buildMiniMaxQuota: status 3 models are unavailable, not 100% free", () => {
  const q = buildMiniMaxQuota({
    ok: true,
    model_remains: [
      {
        model_name: "general",
        current_interval_status: 1,
        current_interval_remaining_percent: 74,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 38,
      },
      {
        model_name: "video",
        current_interval_status: 3,
        current_interval_remaining_percent: 100,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
      },
    ],
  });
  assert.deepEqual(q.windows.map((window) => window.model), ["general", "general"]);
  assert.deepEqual(q.unavailableModels, ["video"]);
});

test("buildMiniMaxQuota: active non-text interval is labeled daily", () => {
  const q = buildMiniMaxQuota({
    ok: true,
    model_remains: [{
      model_name: "video",
      current_interval_status: 1,
      current_interval_remaining_percent: 75,
      current_weekly_status: 3,
    }],
  });
  assert.strictEqual(q.windows[0].label, "video dia");
  assert.strictEqual(q.windows[0].windowType, "daily");
  assert.strictEqual(q.windows[0].windowMinutes, 1440);
});

test("buildMiniMaxQuota: null status and remaining fields stay unknown", () => {
  const q = buildMiniMaxQuota({
    ok: true,
    model_remains: [{
      model_name: "general",
      current_interval_status: null,
      current_interval_remaining_percent: null,
      current_weekly_status: null,
      current_weekly_remaining_percent: null,
    }],
  });
  assert.deepEqual(q.windows, []);
  assert(!Array.isArray(q.unavailableModels) || !q.unavailableModels.includes("general"));
  assert.strictEqual(q.available, false);
});

test("buildGeminiQuota: provider stays available when one model bucket has quota", () => {
  const q = buildGeminiQuota({}, {}, {
    ok: true,
    usedPercent: 40,
    remainingPercent: 60,
    modelQuotas: [
      { model: "Pro", usedPercent: 100, remainingPercent: 0 },
      { model: "Flash", usedPercent: 20, remainingPercent: 80 },
    ],
  });
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.limited, false);
  assert.deepEqual(q.unavailableModels, ["Pro"]);
  assert.deepEqual(q.availableGroups, ["Flash"]);
});

test("buildGeminiQuota: all model buckets exhausted blocks the provider", () => {
  const q = buildGeminiQuota({}, {}, {
    ok: true,
    usedPercent: 40,
    remainingPercent: 60,
    modelQuotas: [
      { model: "Pro", usedPercent: 100, remainingPercent: 0 },
      { model: "Flash", usedPercent: 100, remainingPercent: 0 },
    ],
  });
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.limited, true);
  assert.strictEqual(q.effectiveRemainingPercent, 0);
});

test("buildGeminiQuota: model-only captures remain usable without a fake global window", () => {
  const q = buildGeminiQuota({}, {}, {
    ok: true,
    usedPercent: null,
    remainingPercent: null,
    modelQuotas: [
      { model: "Pro", usedPercent: 100, remainingPercent: 0 },
      { model: "Flash", usedPercent: null, remainingPercent: 75 },
    ],
  });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.usedPercent, null);
  assert.strictEqual(q.remainingPercent, null);
  assert.deepEqual(q.windows.map((window) => window.model), ["Pro", "Flash"]);
  assert.deepEqual(q.windows.map((window) => window.usedPercent), [100, 25]);
  assert.deepEqual(q.availableGroups, ["Flash"]);
  assert.deepEqual(q.unavailableModels, ["Pro"]);
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

test("buildOpenCodeQuota: an exhausted monthly window blocks the provider", () => {
  const q = buildOpenCodeQuota(
    { ok: true, data: { cost5h: 0, costWeek: 1, costMonth: 60 } },
    {},
    {
      ok: true,
      windows: [
        { key: "5h", label: "5 horas", usedPercent: 0, remainingPercent: 100 },
        { key: "week", label: "semanal", usedPercent: 15, remainingPercent: 85 },
        { key: "month", label: "mensual", usedPercent: 100, remainingPercent: 0 },
      ],
    },
  );
  assert.strictEqual(q.limited, true);
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.effectiveRemainingPercent, 0);
  assert.deepEqual(q.limitingWindows, ["mensual"]);
  assert.match(q.note, /LIMITE ALCANZADO \(mensual\)/);
});

test("buildOpenCodeQuota: an incomplete server capture never claims availability", () => {
  const q = buildOpenCodeQuota({ ok: true, data: {} }, {}, {
    ok: true,
    windows: [{ key: "5h", label: "5 horas", usedPercent: 10, remainingPercent: 90 }],
  });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.incomplete, true);
  assert.deepEqual(q.missingWindows, ["semanal", "mensual"]);
  assert.match(q.note, /Cuota incompleta/);
});

test("buildOpenCodeQuota: old manual override is marked stale", () => {
  const q = buildOpenCodeQuota(
    { ok: true, data: {} },
    {
      fiveHourCost: 12,
      weeklyCost: 30,
      monthlyCost: 60,
      serverOverride: {
        enabled: true,
        fiveHourUsed: 1,
        weeklyUsed: 2,
        monthlyUsed: 3,
        capturedAt: new Date(Date.now() - 13 * HOUR_MS).toISOString(),
      },
    },
  );
  assert.strictEqual(q.stale, true);
});

test("buildOpenCodeQuota: manual override without capturedAt has unknown freshness", () => {
  const q = buildOpenCodeQuota(
    { ok: true, data: {} },
    {
      fiveHourCost: 12,
      serverOverride: { enabled: true, fiveHourUsed: 1, capturedAt: null },
    },
  );
  assert.strictEqual(q.stale, true);
  assert.strictEqual(q.observedAt, null);
  assert.match(q.note, /capturedAt desconocido/);
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

test("buildAntigravityQuota: API buckets are alternative models and offered models do not imply quota", () => {
  const q = buildAntigravityQuota(
    { installed: true, models: ["gemini-3-pro-preview", "claude-sonnet-4-5"] },
    {},
    {
      ok: true,
      buckets: [
        { modelId: "gemini-3-pro-preview", remainingFraction: 0, tokenType: "REQUESTS" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.7, tokenType: "REQUESTS" },
      ],
    },
  );
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.limited, false);
  assert.strictEqual(q.windows.length, 2);
  assert.deepEqual(q.availableGroups, ["gemini-2.5-flash"]);
  assert.deepEqual(q.unavailableModels, ["gemini-3-pro-preview"]);
  assert.deepEqual(q.offeredModels, ["claude-sonnet-4-5"]);
  assert(!q.windows.some((window) => window.model === "claude-sonnet-4-5"));
});

test("buildAntigravityQuota: null API fractions stay unknown instead of exhausted", () => {
  const q = buildAntigravityQuota({ installed: true }, {}, {
    ok: true,
    buckets: [{ modelId: "gemini-unknown", remainingFraction: null, tokenType: "REQUESTS" }],
  });
  assert.deepEqual(q.windows, []);
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.limited, false);
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

test("parseOpenCodeServerUsage: reset stays paired when Rolling is absent", () => {
  const html = '<span data-slot="usage-label">Weekly Usage</span><span data-slot="usage-value">52%</span><span data-slot="reset-time">Resets in 2 days 6 hours</span><span data-slot="usage-label">Monthly Usage</span><span data-slot="usage-value">26%</span><span data-slot="reset-time">Resets in 5 days</span>';
  const result = parseOpenCodeServerUsage(html);
  assert.deepEqual(result.windows.map((window) => window.key), ["week", "month"]);
  assert.strictEqual(result.windows[0].resetText, "2 days 6 hours");
  assert.strictEqual(result.windows[1].resetText, "5 days");
});

test("parseOpenCodeServerUsage: prefers SolidStart rate-limited state", () => {
  const html = 'rollingUsage:$R[1]={status:"ok",resetInSec:18000,usagePercent:0},weeklyUsage:$R[2]={status:"ok",resetInSec:10720,usagePercent:15},monthlyUsage:$R[3]={status:"rate-limited",resetInSec:429857,usagePercent:100}';
  const result = parseOpenCodeServerUsage(html);
  assert.strictEqual(result.format, "solid-state");
  assert.strictEqual(result.windows.length, 3);
  const monthly = result.windows.find((window) => window.key === "month");
  assert.strictEqual(monthly.status, "rate-limited");
  assert.strictEqual(monthly.remainingPercent, 0);
});

test("parseOpenCodeServerUsage: merges partial SolidStart data with HTML windows", () => {
  const html = [
    'rollingUsage:$R[1]={status:"ok",resetInSec:18000,usagePercent:0}',
    '<span data-slot="usage-label">Weekly Usage</span><span data-slot="usage-value">15%</span>',
    '<span data-slot="usage-label">Monthly Usage</span><span data-slot="usage-value">100%</span>',
  ].join("");
  const result = parseOpenCodeServerUsage(html);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.format, "solid-state+html");
  assert.deepEqual(result.windows.map((window) => window.key), ["5h", "week", "month"]);
  assert.strictEqual(result.windows.find((window) => window.key === "month").remainingPercent, 0);
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

test("parseClaudeResetText: respeta zona no-UTC (America/Bogota = UTC-5)", () => {
  // Claude a veces anota la hora en una zona nombrada; "10am (America/Bogota)" es las
  // 15:00 UTC, NO las 10:00 UTC. Asumir UTC dejaba el reset corrido +5h (sesion "vencida").
  const d = parseClaudeResetText("Jun 29, 10am (America/Bogota)");
  assert(d instanceof Date);
  assert.strictEqual(d.getUTCHours(), 15);
  assert.strictEqual(d.getUTCMinutes(), 0);
});

test("parseClaudeResetText: el MISMO instante en dos zonas da el mismo Date", () => {
  // "10am (America/Bogota)" === "3pm (UTC)" (Claude varia la etiqueta segun el TZ del entorno).
  const bogota = parseClaudeResetText("Jun 29, 10am (America/Bogota)");
  const utc = parseClaudeResetText("Jun 29, 3pm (UTC)");
  assert.strictEqual(bogota.getTime(), utc.getTime());
});

test("parseClaudeResetText: zona invalida cae a UTC (sin romper)", () => {
  // Una zona que Intl no reconoce -> se interpreta como UTC (no peor que antes; no lanza).
  const d = parseClaudeResetText("Jun 22, 10am (Narnia/Cair_Paravel)");
  assert(d instanceof Date);
  assert.strictEqual(d.getUTCHours(), 10);
});

test("parseClaudeResetText: garbage/empty -> null", () => {
  assert.strictEqual(parseClaudeResetText("nonsense xyz"), null);
  assert.strictEqual(parseClaudeResetText(""), null);
});

test("buildAgentQuotaSummary: aplana windows con resetInSeconds", () => {
  const future = new Date(Date.now() + 3600*1000);
  const snap = { since:"2026-06-19", quotas: { codex: { ok:true, kind:"detected-percent", windows:[{ label:"5h", usedPercent:80, remainingPercent:20, reset: future }], note:"n" } } };
  const out = buildAgentQuotaSummary(snap);
  assert.strictEqual(out.schemaVersion, 2);
  assert.match(out.appVersion, /^\d+\.\d+\.\d+/);
  assert(typeof out.capturedAt === "string");
  assert.strictEqual(out.providers.codex.ok, true);
  assert.strictEqual(out.providers.codex.windows[0].usedPercent, 80);
  assert.strictEqual(out.providers.codex.windows[0].remainingPercent, 20);
  const ri = out.providers.codex.windows[0].resetInSeconds;
  assert(ri >= 3500 && ri <= 3600);
  assert(typeof out.providers.codex.windows[0].resetAt === "string");
});

test("buildAgentQuotaSummary: window sin reset -> resetInSeconds null", () => {
  const snap = { quotas: { minimax: { ok:true, kind:"detected-percent", windows:[{ label:"5h", usedPercent:0, remainingPercent:100, windowMinutes:null, status:null, used:null, remaining:null, limit:null }], note:"" } } };
  const out = buildAgentQuotaSummary(snap);
  assert.strictEqual(out.providers.minimax.windows[0].resetInSeconds, null);
  assert.strictEqual(out.providers.minimax.windows[0].resetAt, null);
  for (const key of ["windowMinutes", "status", "used", "remaining", "limit"]) {
    assert(!(key in out.providers.minimax.windows[0]), `${key} should stay absent when unknown`);
  }
});

test("buildAgentQuotaSummary: unknown percentages stay null and configured counts do not imply availability", () => {
  const out = buildAgentQuotaSummary({ quotas: {
    gemini: {
      ok: true,
      kind: "configured-requests",
      windows: [{ label: "modelo", usedPercent: null, remainingPercent: null }],
      effectiveRemainingPercent: null,
      note: "",
    },
  } });
  assert.strictEqual(out.providers.gemini.windows[0].usedPercent, null);
  assert.strictEqual(out.providers.gemini.windows[0].remainingPercent, null);
  assert.strictEqual(out.providers.gemini.available, false);
  assert(!("effectiveRemainingPercent" in out.providers.gemini));
});

test("buildAgentQuotaSummary: preserves Codex credit balances", () => {
  const out = buildAgentQuotaSummary({ quotas: { codex: {
    ok: true,
    kind: "detected-credits",
    windows: [],
    creditsList: [{ limitId: "codex", planType: "plus", has_credits: true, unlimited: false, balance: "12.5" }],
    note: "",
  } } });
  assert.deepEqual(out.providers.codex.creditBalances, [{
    limitId: "codex", planType: "plus", hasCredits: true, unlimited: false, balance: "12.5",
  }]);
});

test("buildAgentQuotaSummary: snapshot vacío -> providers {}", () => {
  const out = buildAgentQuotaSummary({});
  assert.deepEqual(out.providers, {});
});

// ---------------------------------------------------------------------------
// Visibilidad de proveedores/modelos (v0.12.0)
// ---------------------------------------------------------------------------

test("classifyProviderAvailability: needsAuth -> unauthenticated", () => {
  assert.equal(classifyProviderAvailability({ needsAuth: true, ok: false, windows: [] }), "unauthenticated");
});

test("classifyProviderAvailability: limited (autenticado) -> exhausted aunque no haya ventanas", () => {
  assert.equal(classifyProviderAvailability({ ok: true, limited: true, windows: [] }), "exhausted");
});

test("classifyProviderAvailability: ventanas todas al 0% -> exhausted (visible)", () => {
  assert.equal(classifyProviderAvailability({ ok: true, windows: [
    { label: "mensual", remainingPercent: 0 },
    { label: "semana", remainingPercent: 0 },
  ] }), "exhausted");
});

test("classifyProviderAvailability: ventana con capacidad -> available", () => {
  assert.equal(classifyProviderAvailability({ ok: true, windows: [
    { label: "5h", remainingPercent: 46 },
  ] }), "available");
});

test("classifyProviderAvailability: unusable+reason (sin datos) devuelve la razón", () => {
  assert.equal(classifyProviderAvailability({ ok: false, unusable: true, reason: "not-installed", windows: [] }), "not-installed");
  assert.equal(classifyProviderAvailability({ ok: false, unusable: true, reason: "not-configured", windows: [] }), "not-configured");
});

test("classifyProviderAvailability: disabled sin datos -> disabled", () => {
  assert.equal(classifyProviderAvailability({ ok: false, disabled: true, windows: [] }), "disabled");
});

test("classifyProviderAvailability: ok:false sin razón (error transitorio) -> no-data (se mantiene visible)", () => {
  assert.equal(classifyProviderAvailability({ ok: false, windows: [], note: "MiniMax API fallo: timeout" }), "no-data");
  assert.equal(classifyProviderAvailability(null), "no-data");
});

test("isProviderVisible: auto-oculta no-usables pero mantiene agotados", () => {
  const display = { hideUnusable: true, hiddenProviders: [], hiddenModels: [] };
  assert.equal(isProviderVisible("gemini", { needsAuth: true, windows: [] }, display), false);
  assert.equal(isProviderVisible("minimax", { unusable: true, reason: "not-configured", windows: [] }, display), false);
  assert.equal(isProviderVisible("antigravity", { unusable: true, reason: "not-installed", windows: [] }, display), false);
  // Agotado (autenticado, al límite) SIGUE visible:
  assert.equal(isProviderVisible("codex", { ok: true, limited: true, windows: [] }, display), true);
  assert.equal(isProviderVisible("opencode", { ok: true, windows: [{ label: "mes", remainingPercent: 0 }] }, display), true);
  // Con capacidad, visible:
  assert.equal(isProviderVisible("claude", { ok: true, windows: [{ label: "5h", remainingPercent: 54 }] }, display), true);
});

test("isProviderVisible: hideUnusable=false no oculta nada por disponibilidad", () => {
  const display = { hideUnusable: false, hiddenProviders: [], hiddenModels: [] };
  assert.equal(isProviderVisible("gemini", { needsAuth: true, windows: [] }, display), true);
});

test("isProviderVisible: hiddenProviders oculta aunque tenga cuota; revealHidden lo fuerza visible", () => {
  const display = { hideUnusable: true, hiddenProviders: ["minimax"], hiddenModels: [] };
  const withData = { ok: true, windows: [{ label: "5h", remainingPercent: 80 }] };
  assert.equal(isProviderVisible("minimax", withData, display), false);
  assert.equal(isProviderVisible("minimax", withData, display, true), true); // modo "ver ocultos"
  assert.equal(isProviderVisible("claude", withData, display), true);
});

test("windowModelKey: normaliza a 'provider:modelkey' desde model/family/key/label", () => {
  assert.equal(windowModelKey("claude", { model: "Claude Sonnet" }), "claude:claude-sonnet");
  assert.equal(windowModelKey("antigravity", { family: "gpt" }), "antigravity:gpt");
  assert.equal(windowModelKey("minimax", { key: "weekly_MiniMax-M3" }), "minimax:weekly_minimax-m3");
  assert.equal(windowModelKey("codex", { label: "5h" }), "codex:5h");
  assert.equal(windowModelKey("x", {}), null);
  assert.equal(windowModelKey("x", null), null);
});

test("isModelVisible: oculta la ventana cuyo token está en hiddenModels", () => {
  const display = { hiddenModels: ["claude:claude-sonnet"] };
  assert.equal(isModelVisible("claude", { model: "Claude Sonnet" }, display), false);
  assert.equal(isModelVisible("claude", { model: "Claude Opus" }, display), true);
  assert.equal(isModelVisible("claude", { model: "Claude Sonnet" }, display, true), true); // revealHidden
});

test("buildAgentQuotaSummary: filtra proveedores no-usables y ocultos según display", () => {
  const snap = {
    quotaConfig: { display: { hideUnusable: true, hiddenProviders: ["minimax"], hiddenModels: [] } },
    quotas: {
      claude: { ok: true, windows: [{ label: "5h", remainingPercent: 54 }] },
      gemini: { ok: false, needsAuth: true, windows: [] },
      minimax: { ok: true, windows: [{ label: "5h", remainingPercent: 80 }] },
      codex: { ok: true, limited: true, windows: [] },
    },
  };
  const out = buildAgentQuotaSummary(snap);
  assert.ok(out.providers.claude, "claude visible");
  assert.ok(out.providers.codex, "codex agotado sigue visible");
  assert.ok(!out.providers.gemini, "gemini needsAuth oculto");
  assert.ok(!out.providers.minimax, "minimax oculto por hiddenProviders");
});

test("buildAgentQuotaSummary: AI_USAGE_SHOW_ALL=1 desactiva el filtro", () => {
  const prev = process.env.AI_USAGE_SHOW_ALL;
  process.env.AI_USAGE_SHOW_ALL = "1";
  try {
    const snap = {
      quotaConfig: { display: { hideUnusable: true, hiddenProviders: ["minimax"], hiddenModels: [] } },
      quotas: {
        gemini: { ok: false, needsAuth: true, windows: [] },
        minimax: { ok: true, windows: [{ label: "5h", remainingPercent: 80 }] },
      },
    };
    const out = buildAgentQuotaSummary(snap);
    assert.ok(out.providers.gemini, "con SHOW_ALL, gemini aparece");
    assert.ok(out.providers.minimax, "con SHOW_ALL, minimax aparece");
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_SHOW_ALL;
    else process.env.AI_USAGE_SHOW_ALL = prev;
  }
});

test("buildAgentQuotaSummary: hiddenModels quita esa ventana del proveedor visible", () => {
  const snap = {
    quotaConfig: { display: { hideUnusable: true, hiddenProviders: [], hiddenModels: ["claude:sonnet"] } },
    quotas: {
      claude: { ok: true, windows: [
        { label: "5h", key: "session", remainingPercent: 54 },
        { label: "Sonnet", model: "sonnet", remainingPercent: 30 },
      ] },
    },
  };
  const out = buildAgentQuotaSummary(snap);
  assert.ok(out.providers.claude, "claude visible");
  const labels = out.providers.claude.windows.map((w) => w.label);
  assert.ok(labels.includes("5h"), "ventana global permanece");
  assert.ok(!labels.some((l) => /sonnet/i.test(l)), "ventana Sonnet oculta");
});
