#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;

const colors = {
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  cyan: `${ESC}36m`,
  blue: `${ESC}34m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  magenta: `${ESC}35m`,
  gray: `${ESC}90m`,
  inverse: `${ESC}7m`,
};

const SOURCE_META = {
  all: { label: "Todos", color: colors.cyan },
  claude: { label: "Claude", color: colors.magenta },
  codex: { label: "Codex", color: colors.green },
  gemini: { label: "Gemini", color: colors.blue },
  antigravity: { label: "Antigravity", color: colors.yellow },
  minimax: { label: "MiniMax", color: colors.cyan },
  opencode: { label: "OpenCode", color: colors.green },
};

const ALL_SOURCES = ["claude", "codex", "opencode"];
const SOURCE_KEYS = ["all", "claude", "codex", "antigravity", "minimax", "opencode"];
const VIEW_KEYS = ["daily", "weekly", "monthly", "session", "blocks"];
const TAB_KEYS = ["cuotas", "consumo"];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_BASE_DIR = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const CONFIG_DIR = path.join(CONFIG_BASE_DIR, "ai-usage-live");
const QUOTA_CONFIG_PATH = path.join(CONFIG_DIR, "quotas.json");
const CLAUDE_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "claude-usage-cache.json");
const GEMINI_QUOTA_CACHE_PATH = path.join(CONFIG_DIR, "gemini-quota-cache.json");
const MINIMAX_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "minimax-usage-cache.json");
const OPENCODE_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "opencode-usage-cache.json");
const OPENCODE_DB_PATH = path.join(homedir(), ".local", "share", "opencode", "opencode.db");
const ANTIGRAVITY_QUOTA_CACHE_PATH = path.join(CONFIG_DIR, "antigravity-quota-cache.json");
const ANTIGRAVITY_TOKEN_PATH = path.join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const ANTIGRAVITY_PROJECTS_PATH = path.join(homedir(), ".gemini", "antigravity-cli", "cache", "projects.json");
const ANTIGRAVITY_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const args = parseArgs(process.argv.slice(2));
const state = {
  tab: args.tab ?? "cuotas",
  view: args.view ?? "daily",
  source: args.source ?? "all",
  since: args.since ?? today(),
  until: args.until ?? "",
  refreshSec: args.refreshSec ?? Number(process.env.REFRESH_SEC || 10),
  lastSnapshot: null,
  loading: false,
  error: "",
  selectedModel: 0,
  once: args.once,
};

let ccusageCommand = null;
let refreshTimer = null;
let pendingRefresh = null;

const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  main().catch((error) => {
    cleanup();
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}

async function main() {
  ccusageCommand = detectCcusage();
  const interactive = !state.once && process.stdin.isTTY && process.stdout.isTTY;
  state.lastSnapshot = interactive
    ? await collectSnapshot({ includeLive: false })
    : await collectSnapshot({ includeLive: true, ignoreMiniMaxCache: true });

  if (!interactive) {
    console.log(renderPlainSummary(state.lastSnapshot));
    return;
  }

  process.stdout.write(ALT_ON + HIDE_CURSOR);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.stdout.on("resize", render);
  process.on("SIGINT", () => exit(0));
  process.on("SIGTERM", () => exit(0));

  render();
  refresh({ forceMiniMax: true });
  scheduleRefresh();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--since") parsed.since = argv[++i];
    else if (arg === "--until") parsed.until = argv[++i];
    else if (arg === "--refresh") parsed.refreshSec = Number(argv[++i]);
    else if (arg === "--view") parsed.view = argv[++i];
    else if (arg === "--source") parsed.source = argv[++i];
    else if (VIEW_KEYS.includes(arg)) parsed.view = arg;
    else if (SOURCE_KEYS.includes(arg)) parsed.source = arg;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  if (!VIEW_KEYS.includes(parsed.view ?? "daily")) parsed.view = "daily";
  if (!SOURCE_KEYS.includes(parsed.source ?? "all")) parsed.source = "all";
  if (!Number.isFinite(parsed.refreshSec) || parsed.refreshSec < 2) parsed.refreshSec = 10;
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  ./ai-usage-live [view] [source] [opciones]
  node ai-usage-tui.mjs daily all

Views:
  daily, weekly, monthly, session, blocks

Sources:
  all, claude, codex, antigravity, minimax, opencode
  (gemini-cli fue removido: Google revocó su OAuth; usa Antigravity para Gemini)

Opciones:
  --since YYYY-MM-DD
  --until YYYY-MM-DD
  --refresh SEGUNDOS
  --once

Teclas:
  q salir, r refrescar, 1 daily, 2 weekly, 3 monthly, 4 session, 5 blocks
  a todos, c Claude, x Codex, v Antigravity, m MiniMax, o OpenCode, flechas mover modelo
`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function detectCcusage() {
  try {
    const found = execFileSync("bash", ["-lc", "command -v ccusage || true"], {
      encoding: "utf8",
    }).trim();
    if (found) return { cmd: found, args: [] };
  } catch {
    // Fall back to npx below.
  }
  return { cmd: "npx", args: ["-y", "ccusage@latest"] };
}

async function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refresh();
    scheduleRefresh();
  }, state.refreshSec * 1000);
}

function mergeRefreshOptions(current, next) {
  return {
    forceProviders: Boolean(current?.forceProviders || next?.forceProviders),
    forceMiniMax: Boolean(current?.forceMiniMax || next?.forceMiniMax),
  };
}

async function refresh(options = {}) {
  if (state.loading) {
    pendingRefresh = mergeRefreshOptions(pendingRefresh, options);
    return;
  }
  state.loading = true;
  render();
  try {
    state.lastSnapshot = await collectSnapshot({
      ignoreLiveCache: Boolean(options.forceProviders),
      ignoreMiniMaxCache: Boolean(options.forceProviders || options.forceMiniMax),
    });
    state.error = "";
  } catch (error) {
    state.error = error?.message || String(error);
  } finally {
    state.loading = false;
    render();
    if (pendingRefresh) {
      const nextRefresh = pendingRefresh;
      pendingRefresh = null;
      await refresh(nextRefresh);
    }
  }
}

async function collectSnapshot({ includeLive = true, ignoreLiveCache = false, ignoreMiniMaxCache = false } = {}) {
  const startedAt = new Date();
  const sources = {};
  const view = state.view;
  const quotaConfig = loadQuotaConfig();
  const liveQuotaPromise = includeLive
    ? Promise.allSettled([
        collectClaudeUsageLive(quotaConfig.claude, { ignoreCache: ignoreLiveCache }),
        collectAntigravityQuotaLive(quotaConfig.antigravity, { ignoreCache: ignoreLiveCache }),
      ])
    : Promise.resolve([
        {
          status: "fulfilled",
          value: staleLiveQuota(
            "claude",
            CLAUDE_USAGE_CACHE_PATH,
            "Claude /usage se esta capturando; mostrando ultimo dato conocido.",
            "Claude /usage se esta capturando en segundo plano.",
          ),
        },
        {
          status: "fulfilled",
          value: staleLiveQuota(
            "antigravity",
            ANTIGRAVITY_QUOTA_CACHE_PATH,
            "Antigravity quota se esta capturando; mostrando ultimo dato conocido.",
            "Antigravity quota se esta capturando en segundo plano.",
          ),
        },
      ]);

  const ccusageJobs = [];
  ccusageJobs.push(["all", ccusageJson([], view)]);
  ccusageJobs.push(["claudeBlocks", ccusageJson(["claude"], "blocks")]);

  for (const source of ALL_SOURCES) {
    if (sourceSupportsView(source, view)) {
      ccusageJobs.push([source, ccusageJson([source], view)]);
    }
  }

  const settled = await Promise.allSettled(ccusageJobs.map(([, promise]) => promise));
  for (let i = 0; i < ccusageJobs.length; i += 1) {
    const [name] = ccusageJobs[i];
    const result = settled[i];
    if (name === "claudeBlocks") {
      sources.claudeBlocks = result.status === "fulfilled" ? result.value : { blocks: [] };
    } else if (result.status === "fulfilled") sources[name] = normalizeUsage(name, result.value, view);
    else sources[name] = emptyUsage(name, result.reason?.message || String(result.reason));
  }

  fillFocusedModelGaps(sources);
  sources.antigravity = collectAntigravity();
  sources.minimax = includeLive
    ? await collectMiniMaxUsage(quotaConfig, { ignoreCache: ignoreMiniMaxCache })
    : staleMiniMaxUsage("MiniMax se esta capturando; mostrando ultimo dato conocido.")
      || { source: "minimax", ok: false, note: "MiniMax se esta capturando en segundo plano." };
  sources.opencodeLive = includeLive
    ? await collectOpenCodeUsage(quotaConfig, { ignoreCache: ignoreLiveCache || ignoreMiniMaxCache })
    : staleOpenCodeUsage("OpenCode Go se esta capturando; mostrando ultimo dato conocido.")
      || { source: "opencode", ok: false, note: "OpenCode Go se esta capturando en segundo plano." };
  const liveQuotaSettled = await liveQuotaPromise;
  sources.claudeLive = liveQuotaSettled[0].status === "fulfilled" ? liveQuotaSettled[0].value : { ok: false };
  sources.antigravityLive = liveQuotaSettled[1].status === "fulfilled" ? liveQuotaSettled[1].value : { ok: false };
  const quotas = buildQuotaState(sources, quotaConfig);

  return {
    view,
    source: state.source,
    since: state.since,
    until: state.until,
    refreshedAt: new Date(),
    elapsedMs: new Date() - startedAt,
    sources,
    quotaConfig,
    quotas,
  };
}

function staleLiveQuota(source, cachePath, cacheNote, emptyNote) {
  const cached = readJsonSafe(cachePath);
  if (cached?.ok) {
    return {
      ...cached,
      source,
      cacheHit: true,
      cacheStale: true,
      note: cacheNote,
    };
  }
  return { source, ok: false, note: emptyNote };
}

function sourceSupportsView(source, view) {
  if (source === "claude") return true;
  if (source === "codex" || source === "gemini") return ["daily", "monthly", "session"].includes(view);
  if (source === "opencode") return ["daily", "weekly", "monthly", "session"].includes(view);
  return true;
}

async function ccusageJson(prefix, view) {
  const args = [...ccusageCommand.args, ...prefix, view, "--json"];
  if (state.since) args.push("--since", state.since);
  if (state.until) args.push("--until", state.until);

  const { stdout } = await execFileAsync(ccusageCommand.cmd, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  });
  return JSON.parse(stdout);
}

function normalizeUsage(source, raw, view) {
  const listKey = view === "session" ? "sessions" : view;
  const rows = Array.isArray(raw[listKey]) ? raw[listKey] : firstArray(raw);
  const totals = raw.totals ?? sumRows(rows);
  const modelBreakdowns = mergeModels(rows.flatMap(extractModels));
  return {
    source,
    ok: true,
    rows,
    totals: normalizeTotals(totals),
    models: modelBreakdowns,
    periods: rows.map((row) => row.period || row.sessionId || row.blockStart || row.date).filter(Boolean),
    note: "",
  };
}

function firstArray(raw) {
  const value = Object.values(raw).find((entry) => Array.isArray(entry));
  return value ?? [];
}

function sumRows(rows) {
  const totals = {};
  for (const row of rows) {
    for (const key of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost"]) {
      totals[key] = (totals[key] || 0) + Number(row[key] || 0);
    }
  }
  return totals;
}

function normalizeTotals(totals) {
  const inputTokens = Number(totals.inputTokens || 0);
  const outputTokens = Number(totals.outputTokens || 0);
  const cacheCreationTokens = Number(totals.cacheCreationTokens || 0);
  const cacheReadTokens = Number(totals.cacheReadTokens || 0);
  const totalTokens = Number(totals.totalTokens || inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens);
  const effectiveTokens = inputTokens + cacheCreationTokens + outputTokens;
  const totalCost = Number(totals.totalCost || totals.cost || totals.costUSD || 0);
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, effectiveTokens, totalCost };
}

function extractModels(row) {
  if (Array.isArray(row.modelBreakdowns)) return row.modelBreakdowns;
  if (row.models && typeof row.models === "object") {
    const rowCost = Number(row.totalCost || row.cost || row.costUSD || 0);
    const rowTokens = Number(row.totalTokens || 0);
    return Object.entries(row.models).map(([modelName, data]) => {
      const totalTokens = Number(data.totalTokens || 0);
      const cost = rowTokens > 0 ? rowCost * (totalTokens / rowTokens) : 0;
      return {
        modelName,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheCreationTokens: data.cacheCreationTokens,
        cacheReadTokens: data.cacheReadTokens,
        totalTokens,
        cost,
      };
    });
  }
  if (Array.isArray(row.modelsUsed) && row.modelsUsed.length === 1) {
    return [
      {
        modelName: row.modelsUsed[0],
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        totalTokens: row.totalTokens,
        cost: row.totalCost || row.cost || row.costUSD || 0,
      },
    ];
  }
  return [];
}

function fillFocusedModelGaps(sources) {
  const allModels = sources.all?.models ?? [];
  if (!allModels.length) return;
  for (const source of ["codex", "gemini"]) {
    const usage = sources[source];
    if (!usage || usage.models.length) continue;
    const models = allModels.filter((model) => modelBelongsToSource(model.modelName, source));
    if (models.length) usage.models = models;
  }
}

function modelBelongsToSource(modelName, source) {
  const name = modelName.toLowerCase();
  if (source === "gemini") return name.includes("gemini");
  if (source === "codex") return name.includes("gpt") || name.includes("codex");
  if (source === "claude") return name.includes("claude");
  return false;
}

function mergeModels(models) {
  const byName = new Map();
  for (const model of models) {
    const name = model.modelName || model.model || "unknown";
    const current = byName.get(name) ?? {
      modelName: name,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      cost: 0,
    };
    current.inputTokens += Number(model.inputTokens || 0);
    current.outputTokens += Number(model.outputTokens || 0);
    current.cacheCreationTokens += Number(model.cacheCreationTokens || 0);
    current.cacheReadTokens += Number(model.cacheReadTokens || 0);
    current.cost += Number(model.cost || model.totalCost || 0);
    current.totalTokens += Number(model.totalTokens || 0);
    byName.set(name, current);
  }
  return [...byName.values()]
    .map((model) => {
      const totalTokens =
        model.totalTokens ||
        model.inputTokens + model.outputTokens + model.cacheCreationTokens + model.cacheReadTokens;
      const effectiveTokens = model.inputTokens + model.cacheCreationTokens + model.outputTokens;
      return { ...model, totalTokens, effectiveTokens };
    })
    .sort((a, b) => b.effectiveTokens - a.effectiveTokens);
}

function emptyUsage(source, note) {
  return {
    source,
    ok: false,
    rows: [],
    totals: normalizeTotals({}),
    models: [],
    periods: [],
    note,
  };
}

function collectAntigravity() {
  const root = path.join(homedir(), ".gemini", "antigravity-cli");
  const installed = commandExists("antigravity") || commandExists("agy");
  const models = listAntigravityModels();
  const settings = readJsonSafe(path.join(root, "settings.json"));
  const conversationsDir = path.join(root, "conversations");
  const brainDir = path.join(root, "brain");
  const transcriptPaths = listTranscriptPaths(brainDir);

  const sessions = existsSync(conversationsDir)
    ? readdirSync(conversationsDir).filter((name) => name.endsWith(".db")).length
    : 0;

  let transcriptLines = 0;
  let modelSteps = 0;
  let lastActivity = 0;
  for (const file of transcriptPaths) {
    const stat = safeStat(file);
    if (stat) lastActivity = Math.max(lastActivity, stat.mtimeMs);
    const text = readFileSafe(file);
    if (!text) continue;
    const lines = text.split("\n").filter(Boolean);
    transcriptLines += lines.length;
    for (const line of lines) {
      if (line.includes('"source":"MODEL"')) modelSteps += 1;
    }
  }

  return {
    source: "antigravity",
    ok: installed,
    installed,
    root,
    models,
    defaultModel: settings?.model || "",
    sessions,
    transcriptLines,
    modelSteps,
    lastActivity: lastActivity ? new Date(lastActivity) : null,
    totals: normalizeTotals({ totalTokens: 0, totalCost: 0 }),
    modelsBreakdown: [],
    rows: [],
    note:
      "Antigravity tiene cuota propia. No hay token_count local estable detectado; mira Settings > quota/credits para limite oficial.",
  };
}

function defaultQuotaConfig() {
  return {
    version: 1,
    notes: [
      "Put your real plan limits here. Leave null when the provider does not expose a stable local limit.",
      "Token limits are local-dashboard limits, not official billing unless you copy them from the provider UI.",
    ],
    claude: {
      liveUsage: true,
      liveUsageCacheSeconds: 300,
      fiveHourTokens: null,
      weeklyTokens: null,
    },
    codex: {
      useDetectedRateLimits: true,
      dailyTokens: null,
    },
    gemini: {
      liveCapture: true,
      liveCaptureCacheMinutes: 15,
      dailyTokens: null,
      dailyRequests: null,
    },
    antigravity: {
      monthlyCredits: null,
      usedCredits: null,
      resetsAt: null,
    },
    minimax: {
      liveCaptureCacheMinutes: 0,
      monthlyCredits: null,
      resetsAt: null,
      apiKey: null,
    },
    opencode: {
      liveCaptureCacheMinutes: 5,
      fiveHourCost: 12,
      weeklyCost: 30,
      monthlyCost: 60,
      apiKey: null,
      serverOverride: {
        enabled: false,
        fiveHourUsed: null,
        weeklyUsed: null,
        monthlyUsed: null,
        reset5h: null,
        resetWeek: null,
        resetMonth: null,
        note: "Pega aqui los valores reales de opencode.ai/auth (cost en USD y resets ISO). Cuando enabled=true, reemplaza el estimado local.",
      },
    },
  };
}

function loadQuotaConfig() {
  const defaults = defaultQuotaConfig();
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    if (!existsSync(QUOTA_CONFIG_PATH)) {
      writeFileSync(QUOTA_CONFIG_PATH, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
      return { ...defaults, configPath: QUOTA_CONFIG_PATH, created: true };
    }
    const parsed = JSON.parse(readFileSync(QUOTA_CONFIG_PATH, "utf8"));
    return deepMerge(defaults, parsed, { configPath: QUOTA_CONFIG_PATH, created: false });
  } catch {
    return { ...defaults, configPath: QUOTA_CONFIG_PATH, created: false, error: "No pude leer quotas.json" };
  }
}

function deepMerge(base, override, extra = {}) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return { ...output, ...extra };
}

function buildQuotaState(sources, config) {
  return {
    configPath: config.configPath,
    codex: buildCodexQuota(sources.codex, config.codex),
    claude: buildClaudeQuota(sources.claude, sources.claudeBlocks, config.claude, sources.claudeLive),
    minimax: buildMiniMaxQuota(sources.minimax, config.minimax),
    opencode: buildOpenCodeQuota(sources.opencodeLive, config.opencode),
    antigravity: buildAntigravityQuota(sources.antigravity, config.antigravity, sources.antigravityLive),
  };
}

function buildCodexQuota(usage, config = {}) {
  const detected = config.useDetectedRateLimits !== false ? collectCodexRateLimits() : null;
  const manual = buildTokenQuota("codex", usage, config.dailyTokens, "dia");
  if (!detected) return manual;

  const entries = Array.isArray(detected) ? detected : [detected];
  const windows = [];
  const creditsList = [];

  for (const entry of entries) {
    const limitId = entry.limit_id || "codex";
    const planType = entry.plan_type || limitId;

    for (const [name, defaultLabel] of [
      ["primary", "5h"],
      ["secondary", "semana"],
    ]) {
      const item = entry[name];
      if (!item || typeof item.used_percent !== "number") continue;
      const label = limitId === "premium" ? `mini-${defaultLabel}` : defaultLabel;
      windows.push({
        label,
        limitId,
        usedPercent: item.used_percent,
        remainingPercent: Math.max(0, 100 - item.used_percent),
        reset: item.resets_at ? new Date(item.resets_at * 1000) : null,
        windowMinutes: item.window_minutes,
      });
    }

    const credits = entry.credits;
    if (credits && typeof credits.has_credits === "boolean") {
      creditsList.push({ limitId, planType, ...credits });
    }
  }

  if (!windows.length && creditsList.length) {
    return {
      source: "codex",
      kind: "detected-credits",
      ok: true,
      plan: entries[0]?.plan_type || entries[0]?.limit_id || "",
      creditsList,
      manual,
      note: creditsList.map((c) => {
        const name = c.limitId === "premium" ? "mini" : c.limitId;
        return c.unlimited ? `${name}: ilimitado` : c.has_credits ? `${name}: balance ${c.balance}` : `${name}: sin creditos`;
      }).join(" | "),
    };
  }

  return {
    source: "codex",
    kind: "detected-percent",
    ok: true,
    plan: entries[0]?.plan_type || "",
    windows,
    creditsList,
    manual,
    note: windows.length ? "Rate limit detectado desde sesiones Codex." : "Codex sin rate_limits recientes.",
  };
}

function buildClaudeQuota(usage, blocksRaw, config = {}, live = null) {
  const blocks = Array.isArray(blocksRaw?.blocks) ? blocksRaw.blocks : [];
  const active = blocks.find((block) => block.isActive) || blocks.at(-1) || null;
  const fiveHour = Number(config.fiveHourTokens || 0);
  const weekly = Number(config.weeklyTokens || 0);
  const used = Number(active?.totalTokens || 0);
  const activeBlock = active
    ? {
        used,
        cost: Number(active.costUSD || active.totalCost || 0),
        start: active.startTime ? new Date(active.startTime) : null,
        end: active.endTime ? new Date(active.endTime) : null,
        remainingMinutes: active.projection?.remainingMinutes,
        projectedTokens: active.projection?.totalTokens,
      }
    : null;

  if (live?.ok && Array.isArray(live.windows) && live.windows.length) {
    return {
      source: "claude",
      kind: "detected-percent",
      ok: true,
      windows: live.windows,
      activeBlock,
      live,
      note: live.cacheHit
        ? live.cacheStale
          ? "Claude /usage (ultimo dato conocido)."
          : "Claude /usage desde cache local."
        : "Claude /usage detectado desde el CLI.",
    };
  }

  return {
    source: "claude",
    kind: fiveHour ? "configured-tokens" : "active-block",
    ok: Boolean(activeBlock),
    activeBlock,
    limit: fiveHour || null,
    used,
    remaining: fiveHour ? Math.max(0, fiveHour - used) : null,
    usedPercent: fiveHour ? Math.min(999, (used / fiveHour) * 100) : null,
    weeklyLimit: weekly || null,
    note: fiveHour
      ? "Limite Claude configurado localmente."
      : live?.note || "No pude leer Claude /usage; configura fiveHourTokens si quieres fallback manual.",
  };
}

function buildGeminiQuota(usage, config = {}, live = null) {
  if (live?.ok && typeof live.usedPercent === "number") {
    const usedPercent = Math.min(999, Number(live.usedPercent || 0));
    const remainingPercent = Math.max(0, Number(live.remainingPercent ?? 100 - usedPercent));
    const limitRequests = Number(live.usageLimit || config.dailyRequests || 0) || null;
    const remainingRequests =
      live.remainingRequests != null
        ? Number(live.remainingRequests)
        : limitRequests
          ? Math.max(0, Math.round((remainingPercent / 100) * limitRequests))
          : null;
    return {
      source: "gemini",
      kind: "detected-requests",
      ok: true,
      usedPercent,
      remainingPercent,
      limitRequests,
      remainingRequests,
      resetText: live.resetText || "",
      resetAt: live.resetAt ? new Date(live.resetAt) : null,
      tier: live.tier || "",
      modelQuotas: Array.isArray(live.modelQuotas) ? live.modelQuotas : [],
      live,
      note: live.cacheHit ? "Gemini /stats model desde cache local." : "Gemini /stats model detectado desde el CLI.",
    };
  }

  const tokenQuota = buildTokenQuota("gemini", usage, config?.dailyTokens, "dia");
  const requestLimit = Number(config?.dailyRequests || 0);
  if (requestLimit && tokenQuota.kind === "unknown") {
    return {
      source: "gemini",
      kind: "configured-requests",
      ok: true,
      limitRequests: requestLimit,
      note: live?.note || "Limite diario de requests configurado; faltan usados desde /stats model.",
    };
  }
  return {
    ...tokenQuota,
    note: live?.note || tokenQuota.note,
  };
}

function buildTokenQuota(source, usage, limit, windowLabel) {
  const numericLimit = Number(limit || 0);
  const used = Number(usage?.totals?.totalTokens || 0);
  return {
    source,
    kind: numericLimit ? "configured-tokens" : "unknown",
    ok: Boolean(numericLimit),
    limit: numericLimit || null,
    used,
    remaining: numericLimit ? Math.max(0, numericLimit - used) : null,
    usedPercent: numericLimit ? Math.min(999, (used / numericLimit) * 100) : null,
    windowLabel,
    note: numericLimit ? "Limite configurado localmente." : "Sin limite local configurado.",
  };
}

function buildMiniMaxQuota(usage, config = {}) {
  if (!usage) {
    return { source: "minimax", kind: "unknown", ok: false, note: "Sin datos." };
  }
  if (usage.ok === false) {
    return { source: "minimax", kind: "unknown", ok: false, note: usage.note || "MiniMax no configurado." };
  }

  const data = usage.data || usage;

  // Format 1: model_remains array (Coding Plan API) — per-model 5h + weekly windows
  if (Array.isArray(data.model_remains) && data.model_remains.length) {
    const windows = [];
    for (const m of data.model_remains) {
      const modelName = m.model_name || "model";
      const intervalPct = Number(m.current_interval_remaining_percent);
      const weeklyPct = Number(m.current_weekly_remaining_percent);
      if (Number.isFinite(intervalPct)) {
        windows.push({
          key: `interval_${modelName}`,
          label: `${modelName} 5h`,
          usedPercent: Math.max(0, Math.min(100, 100 - intervalPct)),
          remainingPercent: Math.max(0, Math.min(100, intervalPct)),
          reset: Number.isFinite(Number(m.end_time)) ? new Date(Number(m.end_time)) : null,
        });
      }
      if (Number.isFinite(weeklyPct)) {
        windows.push({
          key: `weekly_${modelName}`,
          label: `${modelName} sem`,
          usedPercent: Math.max(0, Math.min(100, 100 - weeklyPct)),
          remainingPercent: Math.max(0, Math.min(100, weeklyPct)),
          reset: Number.isFinite(Number(m.weekly_end_time)) ? new Date(Number(m.weekly_end_time)) : null,
        });
      }
    }
    if (windows.length) {
      return {
        source: "minimax",
        kind: "detected-percent",
        ok: true,
        windows,
        raw: usage.raw || null,
        note: usage.note || (usage.cacheHit ? "MiniMax desde cache local." : "MiniMax Coding Plan."),
      };
    }
  }

  // Format 2: flat object (limit + used/remaining)
  const limit = numberFromAny(data, ["limit", "quota", "total", "monthlyCredits", "credit_limit", "creditLimit", "current_package_count", "packageCount", "totalQuota"])
    || (config.monthlyCredits ? Number(config.monthlyCredits) : 0);
  const remaining = numberFromAny(data, ["remaining", "remainingCredits", "remaining_credits", "balance", "credits_left", "remains", "current_balance"]);
  const used = numberFromAny(data, ["used", "usedCredits", "total_usage", "totalUsage", "usage", "consumed", "usedQuota"])
    ?? (limit > 0 && remaining != null ? Math.max(0, limit - remaining) : null);
  const resetAtRaw = data.resetAt || data.reset_at || data.resetsAt || data.resets_at || data.cycle_end_time || data.cycleEndTime || data.next_reset_time || config.resetsAt || null;
  const resetAt = resetAtRaw ? new Date(resetAtRaw) : null;
  const resetText = data.resetText || data.reset_text || data.resetIn || data.reset_in || data.next_reset_text || "";
  const usedPercent = numberFromAny(data, ["usedPercent", "used_percent", "usedRatio", "usagePercent"]);
  const computedPercent = limit > 0 && used != null ? Math.min(999, (used / limit) * 100) : null;
  const finalUsedPercent = usedPercent != null ? usedPercent : computedPercent;
  const remainingPercent = finalUsedPercent != null ? Math.max(0, 100 - finalUsedPercent) : null;
  const computedRemaining = limit > 0 && used != null ? Math.max(0, limit - used) : null;
  const finalRemaining = remaining != null ? remaining : computedRemaining;

  const plan = data.current_package_name || data.planName || data.plan_name || data.packageName || "";

  return {
    source: "minimax",
    kind: limit > 0 ? "configured-credits" : "detected-percent",
    ok: true,
    used,
    limit: limit || null,
    remaining: finalRemaining,
    usedPercent: finalUsedPercent,
    remainingPercent,
    resetAt,
    resetText,
    plan,
    raw: usage.raw || null,
    note: usage.note || (usage.cacheHit ? "MiniMax desde cache local." : "MiniMax API consultada."),
  };
}

function numberFromAny(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickAntigravityProject(projects) {
  // projects.json mapea dir -> uuid de proyecto; la cuota es por cuenta, asi que
  // cualquier proyecto valido sirve. Preferimos el del home.
  if (!projects || typeof projects !== "object") return null;
  const home = homedir();
  if (typeof projects[home] === "string") return projects[home];
  const values = Object.values(projects).filter((value) => typeof value === "string");
  return values[0] || null;
}

function staleAntigravityQuota(note) {
  const stale = readJsonSafe(ANTIGRAVITY_QUOTA_CACHE_PATH);
  if (stale?.ok) {
    return { ...stale, cacheHit: true, cacheStale: true, note: `${note} Usando cache.` };
  }
  return { source: "antigravity", ok: false, note };
}

async function collectAntigravityQuotaLive(config = {}, { ignoreCache = false } = {}) {
  // Cuota REAL del plan consumer de Antigravity (Gemini) via el backend
  // cloudcode-pa.googleapis.com:retrieveUserQuota, usando el oauth-token local.
  if (process.env.AI_USAGE_ANTIGRAVITY_LIVE === "0" || config.liveCapture === false) {
    return { source: "antigravity", ok: false, disabled: true, note: "Antigravity API desactivada." };
  }

  const cacheMinutes = Number(process.env.ANTIGRAVITY_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 15);
  if (!ignoreCache) {
    const cached = readJsonCache(ANTIGRAVITY_QUOTA_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
    if (cached) return { ...cached, cacheHit: true };
  }

  const tokenRaw = readJsonSafe(ANTIGRAVITY_TOKEN_PATH);
  const accessToken = tokenRaw?.token?.access_token || tokenRaw?.access_token;
  if (!accessToken) {
    return staleAntigravityQuota("No encuentro token de Antigravity (~/.gemini/antigravity-cli/antigravity-oauth-token).");
  }

  const project = pickAntigravityProject(readJsonSafe(ANTIGRAVITY_PROJECTS_PATH));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let resp;
    try {
      resp = await fetch(ANTIGRAVITY_QUOTA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(project ? { project } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const detail = resp.status === 403 ? " (sin permiso/suscripcion para este endpoint)" : "";
      return staleAntigravityQuota(`Antigravity API HTTP ${resp.status}${detail}.`);
    }
    const data = await resp.json();
    const buckets = (Array.isArray(data.buckets) ? data.buckets : [])
      .map((b) => ({
        modelId: b.modelId || "",
        remainingFraction: Number(b.remainingFraction),
        resetTime: b.resetTime || null,
        tokenType: b.tokenType || "",
      }))
      .filter((b) => Number.isFinite(b.remainingFraction));
    const output = {
      source: "antigravity",
      ok: true,
      buckets,
      capturedAt: new Date().toISOString(),
      cacheHit: false,
      note: "Antigravity quota (API cloudcode-pa).",
    };
    writeJsonCache(ANTIGRAVITY_QUOTA_CACHE_PATH, output);
    return output;
  } catch (error) {
    return staleAntigravityQuota(`Antigravity API fallo: ${shortError(error)}`);
  }
}

function buildAntigravityQuota(usage, config = {}, live = null) {
  // Antigravity es la ruta viva a modelos Gemini (Google revoco el OAuth del gemini-cli).
  // Cuota REAL desde la API consumer; fallback a limites manuales; consumo (sesiones,
  // pasos de modelo, ultima actividad) derivado de transcripts locales.
  const installed = Boolean(usage?.installed);
  const sessions = usage?.sessions ?? 0;
  const modelSteps = usage?.modelSteps ?? 0;
  const lastActivity = usage?.lastActivity || null;
  const statBits = [`sesiones=${sessions}`, `pasos=${modelSteps}`];
  if (lastActivity) statBits.push(`ult ${timeOnly(lastActivity)}`);
  const statsNote = statBits.join("  ");

  // 1) Cuota REAL desde la API (retrieveUserQuota). Mostramos los buckets Gemini.
  if (live?.ok && Array.isArray(live.buckets) && live.buckets.length) {
    const gemini = live.buckets.filter((b) => /gemini/i.test(b.modelId));
    const pool = gemini.length ? gemini : live.buckets;
    const sorted = [...pool].sort((a, b) => a.remainingFraction - b.remainingFraction);
    const shown = sorted.slice(0, 6);
    const windows = shown.map((b) => {
      const remPct = Math.max(0, Math.min(100, b.remainingFraction * 100));
      return {
        key: b.modelId,
        label: shortText(b.modelId.replace(/-preview$/, ""), 16),
        usedPercent: Math.max(0, Math.min(100, 100 - remPct)),
        remainingPercent: remPct,
        reset: b.resetTime ? new Date(b.resetTime) : null,
      };
    });
    const extra = sorted.length - shown.length;
    const unit = live.buckets[0]?.tokenType || "req";
    return {
      source: "antigravity",
      kind: "detected-percent",
      ok: true,
      windows,
      note: `Gemini via Antigravity (API real, ${unit}${extra > 0 ? `, +${extra} modelos` : ""}).  ${statsNote}${live.cacheStale ? "  [cache]" : ""}`,
    };
  }

  if (!installed && !(live && live.ok === false && live.note)) {
    return { source: "antigravity", kind: "unknown", ok: false, note: "Antigravity no instalado (no encuentro antigravity/agy)." };
  }

  // 2) Fallback: limites manuales en quotas.json.
  const monthlyCredits = config?.monthlyCredits != null ? Number(config.monthlyCredits) : null;
  const usedCredits = config?.usedCredits != null ? Number(config.usedCredits) : null;
  const resetsAt = config?.resetsAt ? new Date(config.resetsAt) : null;
  if (Number.isFinite(monthlyCredits) && monthlyCredits > 0) {
    const used = Number.isFinite(usedCredits) ? Math.max(0, usedCredits) : 0;
    const usedPercent = Math.min(999, (used / monthlyCredits) * 100);
    return {
      source: "antigravity",
      kind: "configured-credits",
      ok: true,
      used,
      limit: monthlyCredits,
      remaining: Math.max(0, monthlyCredits - used),
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt,
      note: `Cuota manual (Gemini via Antigravity).  ${statsNote}`,
    };
  }

  // 3) Sin cuota: surface el motivo de la API si lo hay.
  const apiNote = live?.note ? `${live.note}  ` : "";
  return {
    source: "antigravity",
    kind: "unknown",
    ok: true,
    note: `${apiNote}Gemini via Antigravity.  ${statsNote}`,
  };
}

function buildOpenCodeQuota(usage, config = {}) {
  if (!usage) {
    return { source: "opencode", kind: "unknown", ok: false, note: "Sin datos." };
  }
  if (usage.ok === false) {
    return { source: "opencode", kind: "unknown", ok: false, note: usage.note || "OpenCode Go no configurado." };
  }

  const data = usage.data || usage;
  const fiveHourCost = Number(config.fiveHourCost || 0);
  const weeklyCost = Number(config.weeklyCost || 0);
  const monthlyCost = Number(config.monthlyCost || 0);
  const override = config.serverOverride || {};
  const useOverride = override.enabled === true;

  // Default reset times (calendar week/month, rolling 5h) — used as fallback
  // when the user enables serverOverride without providing explicit reset ISO.
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const HOUR = 3600000;
  const weekOffset = (nowDate.getUTCDay() + 6) % 7;
  const weekStart = new Date(nowDate);
  weekStart.setUTCDate(nowDate.getUTCDate() - weekOffset);
  weekStart.setUTCHours(0, 0, 0, 0);
  const nextWeek = new Date(weekStart.getTime());
  nextWeek.setUTCDate(weekStart.getUTCDate() + 7);
  const nextMonth = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1);
  const defaultReset5h = new Date(nowMs + 5 * HOUR);
  const defaultResetWeek = nextWeek;
  const defaultResetMonth = new Date(nextMonth);

  const windows = [];

  if (useOverride) {
    if (fiveHourCost > 0 && typeof override.fiveHourUsed === "number") {
      const usedPct = Math.min(999, (override.fiveHourUsed / fiveHourCost) * 100);
      windows.push({
        key: "5h",
        label: "5 horas",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: override.reset5h ? new Date(override.reset5h) : defaultReset5h,
        used: override.fiveHourUsed,
        limit: fiveHourCost,
        source: "server",
      });
    }
    if (weeklyCost > 0 && typeof override.weeklyUsed === "number") {
      const usedPct = Math.min(999, (override.weeklyUsed / weeklyCost) * 100);
      windows.push({
        key: "week",
        label: "semanal",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: override.resetWeek ? new Date(override.resetWeek) : defaultResetWeek,
        used: override.weeklyUsed,
        limit: weeklyCost,
        source: "server",
      });
    }
    if (monthlyCost > 0 && typeof override.monthlyUsed === "number") {
      const usedPct = Math.min(999, (override.monthlyUsed / monthlyCost) * 100);
      windows.push({
        key: "month",
        label: "mensual",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: override.resetMonth ? new Date(override.resetMonth) : defaultResetMonth,
        used: override.monthlyUsed,
        limit: monthlyCost,
        source: "server",
      });
    }
  } else {
    if (fiveHourCost > 0 && typeof data.cost5h === "number") {
      const usedPct = Math.min(999, (data.cost5h / fiveHourCost) * 100);
      windows.push({
        key: "5h",
        label: "5 horas",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: data.reset5h ? new Date(data.reset5h) : null,
        used: data.cost5h,
        limit: fiveHourCost,
        source: "local",
      });
    }

    if (weeklyCost > 0 && typeof data.costWeek === "number") {
      const usedPct = Math.min(999, (data.costWeek / weeklyCost) * 100);
      windows.push({
        key: "week",
        label: "semanal",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: data.resetWeek ? new Date(data.resetWeek) : null,
        used: data.costWeek,
        limit: weeklyCost,
        source: "local",
      });
    }

    if (monthlyCost > 0 && typeof data.costMonth === "number") {
      const usedPct = Math.min(999, (data.costMonth / monthlyCost) * 100);
      windows.push({
        key: "month",
        label: "mensual",
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        reset: data.resetMonth ? new Date(data.resetMonth) : null,
        used: data.costMonth,
        limit: monthlyCost,
        source: "local",
      });
    }
  }

  if (windows.length) {
    const allServer = windows.every((w) => w.source === "server");
    let noteText = useOverride
      ? (override.note ? `Override manual: ${override.note}` : "Override manual desde opencode.ai/auth.")
      : (usage.note || (usage.cacheHit ? "OpenCode Go desde cache local." : "OpenCode Go DB local."));
    if (useOverride) {
      const localBits = [];
      if (typeof data.cost5h === "number") localBits.push(`5h ${fmtMoney(data.cost5h)}`);
      if (typeof data.costWeek === "number") localBits.push(`sem ${fmtMoney(data.costWeek)}`);
      if (typeof data.costMonth === "number") localBits.push(`mes ${fmtMoney(data.costMonth)}`);
      if (localBits.length) noteText += `  ·  estimado local (tarifa publica): ${localBits.join("  ")}`;
    }
    return {
      source: "opencode",
      kind: "detected-percent",
      ok: true,
      windows,
      totalCost: data.totalCost || 0,
      totalTokens: data.totalTokens || 0,
      sessionCount: data.sessionCount || 0,
      serverOverride: allServer,
      note: noteText,
    };
  }

  return {
    source: "opencode",
    kind: "unknown",
    ok: true,
    totalCost: data.totalCost || 0,
    totalTokens: data.totalTokens || 0,
    sessionCount: data.sessionCount || 0,
    serverOverride: false,
    note: useOverride
      ? "serverOverride.enabled=true pero falta fiveHourUsed/weeklyUsed/monthlyUsed o los limites fiveHourCost/weeklyCost/monthlyCost."
      : "Configura fiveHourCost, weeklyCost o monthlyCost en quotas.json para ver barras de cuota Go.",
  };
}

function collectCodexRateLimits() {
  const root = path.join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const files = [];
  walkFiles(root, (file) => {
    if (file.endsWith(".jsonl")) files.push(file);
  });
  files.sort((a, b) => (safeStat(b)?.mtimeMs || 0) - (safeStat(a)?.mtimeMs || 0));

  // Collect best entry per limit_id
  const bestByLimitId = new Map();

  for (const file of files.slice(0, 250)) {
    const lines = tailLines(file, 1500);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const item = JSON.parse(lines[i]);
        const rateLimits = item.payload?.rate_limits;
        if (!rateLimits) continue;

        const limitId = rateLimits.limit_id || "codex";
        const entry = { ...rateLimits, detectedAt: item.timestamp, file };
        const hasPrimary = rateLimits.primary && typeof rateLimits.primary.used_percent === "number";

        if (!bestByLimitId.has(limitId)) {
          bestByLimitId.set(limitId, { best: null, any: entry });
        }
        const bucket = bestByLimitId.get(limitId);
        if (hasPrimary && !bucket.best) {
          bucket.best = entry;
        }
      } catch {
        // Ignore non-JSON or partial lines.
      }
    }
    // Stop early if we have good data for all known limit_ids
    if (bestByLimitId.size >= 2) {
      const allHaveBest = [...bestByLimitId.values()].every((b) => b.best);
      if (allHaveBest) break;
    }
  }

  if (!bestByLimitId.size) return null;

  const results = [...bestByLimitId.values()].map((b) => b.best || b.any);
  return results.length === 1 ? results[0] : results;
}

async function collectClaudeUsageLive(config = {}, { ignoreCache = false } = {}) {
  if (process.env.AI_USAGE_CLAUDE_LIVE === "0" || config.liveUsage === false) {
    return { source: "claude", ok: false, disabled: true, note: "Claude /usage desactivado." };
  }

  const cacheSeconds = Number(config.liveUsageCacheSeconds ?? 300);
  if (!ignoreCache) {
    const cached = readJsonCache(CLAUDE_USAGE_CACHE_PATH, Math.max(0, cacheSeconds) * 1000);
    if (cached) return { ...cached, cacheHit: true };
  }

  if (!commandExists("claude")) {
    return { source: "claude", ok: false, note: "No encuentro el comando claude." };
  }

  try {
    const { stdout } = await execFileAsync("claude", ["-p", "/usage", "--output-format", "json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
    });
    let resultText = stdout;
    try {
      const parsedJson = JSON.parse(stdout);
      resultText = parsedJson.result || parsedJson.message || stdout;
    } catch {
      // Some older builds may print plain text.
    }
    const parsed = parseClaudeUsageOutput(resultText);
    const stale = readJsonSafe(CLAUDE_USAGE_CACHE_PATH);

    // Claude /usage frequently omits the per-window bars when it is called too often (it
    // throttles them). Missing bars do NOT mean the plan is unlimited: every response now
    // starts with "using your subscription", so we must never read that as "no limits".
    if (parsed.windows.length === 0) {
      // Prefer the last known windows so a throttled response does not blank the UI, and
      // never overwrite good windows with an empty result.
      if (stale?.windows?.length > 0) {
        const fallback = {
          ...stale,
          plan: parsed.plan || stale.plan || "",
          capturedAt: new Date().toISOString(),
          cacheHit: true,
          cacheStale: true,
          note: "Claude no devolvio barras (limitado); mostrando ultimo dato conocido.",
        };
        writeJsonCache(CLAUDE_USAGE_CACHE_PATH, fallback);
        return fallback;
      }
      // No prior windows to fall back on: report honestly instead of faking "unlimited".
      const output = {
        source: "claude",
        ok: false,
        plan: parsed.plan,
        windows: [],
        capturedAt: new Date().toISOString(),
        cacheHit: false,
        note: "Claude no devolvio el uso por ventana; reintenta en unos minutos.",
      };
      writeJsonCache(CLAUDE_USAGE_CACHE_PATH, output);
      return output;
    }

    const output = {
      source: "claude",
      ok: true,
      ...parsed,
      capturedAt: new Date().toISOString(),
      cacheHit: false,
      note: "Claude /usage detectado.",
    };
    writeJsonCache(CLAUDE_USAGE_CACHE_PATH, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(CLAUDE_USAGE_CACHE_PATH);
    if (stale?.ok) {
      return {
        ...stale,
        cacheHit: true,
        cacheStale: true,
        note: `Claude /usage fallo; usando cache anterior (${shortError(error)}).`,
      };
    }
    return { source: "claude", ok: false, note: `Claude /usage fallo: ${shortError(error)}` };
  }
}

function parseClaudeUsageOutput(text) {
  const clean = stripAnsi(String(text || "")).replace(/\r/g, "\n");
  const windows = [];
  for (const line of clean.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(/^Current\s+(.+?):\s+(\d+(?:\.\d+)?)%\s+used(?:\s*[·•-]\s*resets\s+(.+))?$/i);
    if (!match) continue;
    const rawLabel = match[1].trim();
    const usedPercent = Number(match[2]);
    if (!Number.isFinite(usedPercent)) continue;
    windows.push({
      key: claudeWindowKey(rawLabel),
      label: claudeWindowLabel(rawLabel),
      rawLabel,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetText: normalizeResetText(match[3] || ""),
    });
  }
  return {
    plan: clean.includes("subscription") ? "subscription" : "",
    windows,
  };
}

function claudeWindowKey(label) {
  const lower = label.toLowerCase();
  if (lower.includes("sonnet")) return "week_sonnet";
  if (lower.includes("week")) return "week_all";
  if (lower.includes("session")) return "session";
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function claudeWindowLabel(label) {
  const key = claudeWindowKey(label);
  if (key === "session") return "sesion";
  if (key === "week_all") return "semana";
  if (key === "week_sonnet") return "Sonnet";
  return label;
}

async function collectGeminiQuotaLive(config = {}, { ignoreCache = false } = {}) {
  if (process.env.AI_USAGE_GEMINI_LIVE === "0" || config.liveCapture === false) {
    return { source: "gemini", ok: false, disabled: true, note: "Gemini /stats model desactivado." };
  }

  const cacheMinutes = Number(config.liveCaptureCacheMinutes ?? 15);
  if (!ignoreCache) {
    const cached = readJsonCache(GEMINI_QUOTA_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
    if (cached) return { ...cached, cacheHit: true };
  }

  if (!commandExists("gemini")) {
    return { source: "gemini", ok: false, note: "No encuentro el comando gemini." };
  }

  const helper = path.join(SCRIPT_DIR, "gemini-quota-capture.py");
  if (!existsSync(helper)) {
    return { source: "gemini", ok: false, note: "Falta gemini-quota-capture.py." };
  }

  const timeoutSeconds = Math.max(10, Number(config.liveCaptureTimeoutSeconds || 45));
  try {
    const { stdout } = await execFileAsync("python3", [helper], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: (timeoutSeconds + 5) * 1000,
      env: { ...process.env, AI_USAGE_GEMINI_TIMEOUT: String(timeoutSeconds) },
    });
    const parsed = JSON.parse(stdout);
    const output = {
      source: "gemini",
      ...parsed,
      capturedAt: parsed.capturedAt || new Date().toISOString(),
      cacheHit: false,
    };
    writeJsonCache(GEMINI_QUOTA_CACHE_PATH, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(GEMINI_QUOTA_CACHE_PATH);
    if (stale?.ok) {
      return {
        ...stale,
        cacheHit: true,
        cacheStale: true,
        note: `Gemini /stats model fallo; usando cache anterior (${shortError(error)}).`,
      };
    }
    return { source: "gemini", ok: false, note: `Gemini /stats model fallo: ${shortError(error)}` };
  }
}

async function collectMiniMaxUsage(quotaConfig = null, { ignoreCache = false } = {}) {
  const config = quotaConfig || loadQuotaConfig();
  const configEntry = config?.minimax || {};
  const keyFromEnv = process.env.MINIMAX_API_KEY || "";
  const keyFromFile = configEntry.apiKey || "";
  const apiKey = keyFromEnv || keyFromFile;
  const debug = process.env.AI_USAGE_MINIMAX_DEBUG === "1";
  const liveDisabled = process.env.AI_USAGE_MINIMAX_LIVE === "0" || configEntry.liveCapture === false;
  const cacheMinutes = Number(process.env.MINIMAX_USAGE_CACHE_MINUTES ?? configEntry.liveCaptureCacheMinutes ?? 0);
  const cached = readJsonCache(MINIMAX_USAGE_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
  if (cached && (!ignoreCache || liveDisabled)) {
    if (debug) process.stderr.write(`[minimax] cache hit (age < ${cacheMinutes}m)\n`);
    return { ...cached, cacheHit: true };
  }
  if (liveDisabled) {
    const stale = readJsonSafe(MINIMAX_USAGE_CACHE_PATH);
    if (stale?.ok) {
      return {
        ...stale,
        cacheHit: true,
        cacheStale: true,
        note: "MiniMax API desactivada; usando cache local.",
      };
    }
    return { source: "minimax", ok: false, disabled: true, note: "MiniMax API desactivada." };
  }

  if (debug) {
    process.stderr.write(`[minimax] key source: ${keyFromEnv ? "env" : keyFromFile ? "quotas.json" : "none"} (${apiKey ? apiKey.slice(0, 8) + "…" : "empty"})\n`);
  }
  if (!apiKey) {
    return {
      source: "minimax",
      ok: false,
      note: "MINIMAX_API_KEY no definida. Define la env var o agrega minimax.apiKey en quotas.json (ai-usage-quota edit).",
    };
  }

  const url = process.env.MINIMAX_USAGE_URL || "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
  if (debug) {
    process.stderr.write(`[minimax] GET ${url}\n[minimax] Authorization: Bearer ${apiKey.slice(0, 8)}…\n`);
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (debug) {
      process.stderr.write(`[minimax] HTTP ${response.status}\n[minimax] body: ${text.slice(0, 800)}\n`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return staleMiniMaxUsage(`MiniMax devolvio no-JSON; usando cache anterior (${shortError(text)}).`)
        || { source: "minimax", ok: false, note: `MiniMax devolvio no-JSON: ${shortError(text)}` };
    }

    const baseResp = data?.base_resp || {};
    if (baseResp.status_code && baseResp.status_code !== 0 && baseResp.status_code !== 200) {
      const msg = baseResp.status_msg || `status_code ${baseResp.status_code}`;
      const stale = readJsonSafe(MINIMAX_USAGE_CACHE_PATH);
      if (stale?.ok) {
        return {
          ...stale,
          cacheHit: true,
          cacheStale: true,
          note: `MiniMax: ${msg}; usando cache anterior.`,
        };
      }
      return { source: "minimax", ok: false, note: `MiniMax: ${msg}` };
    }

    if (!response.ok) {
      return staleMiniMaxUsage(`MiniMax API HTTP ${response.status}; usando cache anterior (${shortError(text)}).`)
        || {
          source: "minimax",
          ok: false,
          note: `MiniMax API HTTP ${response.status}: ${shortError(text)}`,
        };
    }

    const output = {
      source: "minimax",
      ok: true,
      ...data,
      raw: data,
      capturedAt: new Date().toISOString(),
      cacheHit: false,
    };
    writeJsonCache(MINIMAX_USAGE_CACHE_PATH, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(MINIMAX_USAGE_CACHE_PATH);
    if (stale?.ok) {
      return {
        ...stale,
        cacheHit: true,
        cacheStale: true,
        note: `MiniMax API fallo; usando cache anterior (${shortError(error)}).`,
      };
    }
    return { source: "minimax", ok: false, note: `MiniMax API fallo: ${shortError(error)}` };
  }
}

function staleMiniMaxUsage(note) {
  const stale = readJsonSafe(MINIMAX_USAGE_CACHE_PATH);
  if (!stale?.ok) return null;
  return {
    ...stale,
    cacheHit: true,
    cacheStale: true,
    note,
  };
}

function staleOpenCodeUsage(note) {
  const stale = readJsonSafe(OPENCODE_USAGE_CACHE_PATH);
  if (!stale?.ok) return null;
  return {
    ...stale,
    cacheHit: true,
    cacheStale: true,
    note,
  };
}

async function collectOpenCodeUsage(quotaConfig = null, { ignoreCache = false } = {}) {
  const config = quotaConfig || loadQuotaConfig();
  const configEntry = config?.opencode || {};
  const liveDisabled = process.env.AI_USAGE_OPENCODE_LIVE === "0" || configEntry.liveCapture === false;
  const cacheMinutes = Number(process.env.OPENCODE_USAGE_CACHE_MINUTES ?? configEntry.liveCaptureCacheMinutes ?? 5);
  const cached = readJsonCache(OPENCODE_USAGE_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
  if (cached && (!ignoreCache || liveDisabled)) {
    return { ...cached, cacheHit: true };
  }
  if (liveDisabled) {
    const stale = readJsonSafe(OPENCODE_USAGE_CACHE_PATH);
    if (stale?.ok) {
      return { ...stale, cacheHit: true, cacheStale: true, note: "OpenCode Go DB desactivado; usando cache local." };
    }
    return { source: "opencode", ok: false, disabled: true, note: "OpenCode Go DB desactivado." };
  }

  if (!existsSync(OPENCODE_DB_PATH)) {
    return { source: "opencode", ok: false, note: "No encuentro opencode.db; corre opencode al menos una vez." };
  }

  try {
    const { stdout } = await execFileAsync("sqlite3", [OPENCODE_DB_PATH, "-json",
      "SELECT s.model, s.cost, s.tokens_input, s.tokens_output, s.tokens_cache_read, s.tokens_cache_write, s.time_created " +
      "FROM session s WHERE json_extract(s.model, '$.providerID') = 'opencode-go' " +
      "OR json_extract(s.model, '$.providerID') LIKE 'opencode-go:%' " +
      "ORDER BY s.time_created DESC"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });

    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    const now = Date.now();
    const nowDate = new Date();
    const HOUR = 3600000;
    const DAY = 86400000;

    // 5h = rolling window (last 5h from now)
    const fiveHoursAgo = now - 5 * HOUR;

    // Week = calendar week (Monday 00:00 UTC → next Monday 00:00 UTC)
    // Matches opencode.ai console's getWeekBounds(): offset = (day + 6) % 7
    const weekStart = new Date(nowDate);
    const weekOffset = (nowDate.getUTCDay() + 6) % 7;
    weekStart.setUTCDate(nowDate.getUTCDate() - weekOffset);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartMs = weekStart.getTime();

    // Month = calendar month (1st 00:00 UTC → next 1st 00:00 UTC)
    // We don't have timeSubscribed locally, so we use the 1st of the month.
    // The server uses subscription date for the monthly window, but locally
    // we approximate to "this calendar month" which is close enough.
    const monthStartMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);

    let cost5h = 0, costWeek = 0, costMonth = 0, totalCost = 0;
    let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let earliestIn5h = null;

    for (const row of rows) {
      const ts = Number(row.time_created);
      const cost = Number(row.cost || 0);
      if (!Number.isFinite(ts)) continue;
      totalCost += cost;
      totalTokens += Number(row.tokens_input || 0) + Number(row.tokens_output || 0);
      totalInput += Number(row.tokens_input || 0);
      totalOutput += Number(row.tokens_output || 0);
      totalCacheRead += Number(row.tokens_cache_read || 0);
      totalCacheWrite += Number(row.tokens_cache_write || 0);

      if (ts >= fiveHoursAgo) {
        cost5h += cost;
        if (earliestIn5h === null || ts < earliestIn5h) earliestIn5h = ts;
      }
      if (ts >= weekStartMs) costWeek += cost;
      if (ts >= monthStartMs) costMonth += cost;
    }

    const fiveHourCost = Number(configEntry.fiveHourCost || 12);
    const weeklyCost = Number(configEntry.weeklyCost || 30);
    const monthlyCost = Number(configEntry.monthlyCost || 60);

    // Reset times match opencode.ai console:
    // - 5h: rolling, no fixed reset (next "rolling end" = now + 5h if no usage, or timeUpdated + 5h)
    // - Week: next Monday 00:00 UTC
    // - Month: 1st of next month 00:00 UTC
    const nextWeek = new Date(weekStartMs);
    nextWeek.setUTCDate(weekStart.getUTCDate() + 7);
    const nextMonth = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1);

    const output = {
      source: "opencode",
      ok: true,
      data: {
        cost5h: cost5h,
        costWeek: costWeek,
        costMonth: costMonth,
        totalCost: totalCost,
        totalTokens: totalTokens,
        totalInput: totalInput,
        totalOutput: totalOutput,
        totalCacheRead: totalCacheRead,
        totalCacheWrite: totalCacheWrite,
        sessionCount: rows.length,
        reset5h: new Date((earliestIn5h !== null ? earliestIn5h : now) + 5 * HOUR).toISOString(),
        resetWeek: nextWeek.toISOString(),
        resetMonth: new Date(nextMonth).toISOString(),
      },
      limits: {
        fiveHourCost: fiveHourCost || null,
        weeklyCost: weeklyCost || null,
        monthlyCost: monthlyCost || null,
        note: "Estimado local (opencode.db). Valores reales del servidor: opencode.ai/auth (pueden diferir).",
      },
      capturedAt: new Date().toISOString(),
      cacheHit: false,
      note: "Estimado local (opencode.db). Para valores exactos ve a opencode.ai/auth.",
    };
    writeJsonCache(OPENCODE_USAGE_CACHE_PATH, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(OPENCODE_USAGE_CACHE_PATH);
    if (stale?.ok) {
      return { ...stale, cacheHit: true, cacheStale: true, note: `OpenCode Go DB fallo; usando cache anterior (${shortError(error)}).` };
    }
    return { source: "opencode", ok: false, note: `OpenCode Go DB fallo: ${shortError(error)}` };
  }
}

function readJsonCache(file, maxAgeMs) {
  if (maxAgeMs <= 0) return null;
  const data = readJsonSafe(file);
  if (!data) return null;
  const timestamp = Date.parse(data.capturedAt || data.cachedAt || "");
  if (!Number.isFinite(timestamp)) return null;
  if (Date.now() - timestamp > maxAgeMs) return null;
  return data;
}

function writeJsonCache(file, data) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...data, cachedAt: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Cache is best effort.
  }
}

function normalizeResetText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function shortError(error) {
  const message = error?.stderr || error?.stdout || error?.message || String(error);
  return normalizeResetText(message).slice(0, 160) || "error desconocido";
}

function walkFiles(dir, visit) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(file, visit);
      else visit(file);
    }
  } catch {
    // Ignore unreadable directories.
  }
}

function tailLines(file, maxLines) {
  try {
    const stat = statSync(file);
    const size = Math.min(stat.size, 1024 * 1024);
    const data = readFileSync(file, "utf8").slice(-size);
    return data.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function listTranscriptPaths(brainDir) {
  if (!existsSync(brainDir)) return [];
  const files = [];
  for (const id of safeReadDir(brainDir)) {
    const file = path.join(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(file)) files.push(file);
  }
  return files;
}

function listAntigravityModels() {
  if (!commandExists("antigravity")) return [];
  try {
    const output = execFileSync("antigravity", ["models"], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function commandExists(command) {
  try {
    execFileSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function onKey(buffer) {
  const input = buffer.toString("utf8");
  for (let i = 0; i < input.length; i += 1) {
    if (input.startsWith("\x1b[A", i)) {
      handleKey("\x1b[A");
      i += 2;
      continue;
    }
    if (input.startsWith("\x1b[B", i)) {
      handleKey("\x1b[B");
      i += 2;
      continue;
    }
    handleKey(input[i]);
  }
}

function handleKey(key) {
  if (key === "\u0003" || key === "q") exit(0);
  else if (key === "r") refresh({ forceProviders: true });
  else if (key === "\t" || key === "t") toggleTab();
  else if (key === "1") setView("daily");
  else if (key === "2") setView("weekly");
  else if (key === "3") setView("monthly");
  else if (key === "4") setView("session");
  else if (key === "5") setView("blocks");
  else if (key === "a") setSource("all");
  else if (key === "c") setSource("claude");
  else if (key === "x") setSource("codex");
  else if (key === "v") setSource("antigravity");
  else if (key === "m") setSource("minimax");
  else if (key === "o") setSource("opencode");
  else if (key === "\x1b[A") moveModel(-1);
  else if (key === "\x1b[B") moveModel(1);
}

function toggleTab() {
  const idx = TAB_KEYS.indexOf(state.tab);
  state.tab = TAB_KEYS[(idx + 1) % TAB_KEYS.length];
  render();
}

function setView(view) {
  state.view = view;
  state.selectedModel = 0;
  refresh();
}

function setSource(source) {
  state.source = source;
  state.selectedModel = 0;
  render();
}

function moveModel(delta) {
  const models = visibleModels();
  if (!models.length) return;
  state.selectedModel = Math.max(0, Math.min(models.length - 1, state.selectedModel + delta));
  render();
}

function render() {
  if (!process.stdout.isTTY) return;
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 40;
  const lines = draw(width, height);
  process.stdout.write(CLEAR + lines.join("\n"));
}

function draw(width, height) {
  const snap = state.lastSnapshot;
  const lines = [];
  const title = `${colors.bold}${colors.cyan}AI Usage TUI${RESET} ${colors.gray}ccusage + Antigravity monitor${RESET}`;
  lines.push(padLine(title, width));
  lines.push(
    padLine(
      `${tabBar(TAB_KEYS, state.tab, true)}   ${state.tab === "consumo" ? `${tabBar(VIEW_KEYS, state.view)} ${tabBar(SOURCE_KEYS, state.source)}   ` : ""}${colors.gray}since ${state.since}${state.until ? ` until ${state.until}` : ""} | refresh ${state.refreshSec}s | ${state.loading ? "loading" : `updated ${timeOnly(snap?.refreshedAt)}`}${RESET}`,
      width,
    ),
  );
  lines.push(hr(width));

  if (!snap) {
    lines.push("Cargando datos...");
    return lines;
  }

  if (state.tab === "cuotas") {
    lines.push(...drawQuotaTab(width, height - lines.length - 3, snap));
  } else {
    lines.push(...drawConsumoTab(width, height - lines.length - 3, snap));
  }

  if (state.error) {
    lines.push(colorText(`Error: ${state.error}`, colors.red));
  }

  while (lines.length < height - 2) lines.push("");
  lines.push(hr(width));
  const helpText = state.tab === "cuotas"
    ? `${colors.gray}q salir | r refrescar | Tab cambiar pestaña${RESET}`
    : `${colors.gray}q salir | r refrescar | Tab pestaña | 1-5 vista | a/c/x/g/v/m fuente | flechas modelos${RESET}`;
  lines.push(fit(helpText, width));
  return lines.slice(0, height);
}

function drawQuotaTab(width, maxHeight, snap) {
  const lines = [];
  const quotas = snap.quotas || {};
  const halfWidth = Math.max(30, Math.floor((width - 4) / 2));

  // Claude quota
  lines.push(...quotaSection("Claude", colors.magenta, quotas.claude, halfWidth, width));
  lines.push("");

  // Codex quota
  lines.push(...quotaSection("Codex", colors.green, quotas.codex, halfWidth, width));
  lines.push("");

  // Antigravity quota (Gemini via API real; reemplaza al gemini-cli que Google deautenticó)
  lines.push(...quotaSection("Antigravity (Gemini)", colors.yellow, quotas.antigravity, halfWidth, width));
  lines.push("");

  // MiniMax quota
  lines.push(...quotaSection("MiniMax", colors.cyan, quotas.minimax, halfWidth, width));
  lines.push("");

  // OpenCode quota
  lines.push(...quotaSection("OpenCode", colors.green, quotas.opencode, halfWidth, width));

  return lines.slice(0, maxHeight);
}

function quotaSection(label, color, quota, barWidth, totalWidth) {
  const lines = [];
  const sectionBar = Math.max(10, barWidth - 2);
  lines.push(`${color}${colors.bold}${label}${RESET}`);

  if (!quota || quota.kind === "unknown") {
    const msg = quota?.note || "sin limite configurado — ejecuta ai-usage-quota edit";
    lines.push(fit(`  ${colors.gray}${msg}${RESET}`, totalWidth));
    return lines;
  }

  if (quota.kind === "subscription") {
    lines.push(fit(`  ${"Suscripcion".padEnd(12)} ${bar(0, 100, sectionBar, colors.green)} Pro / Ilimitado (sin limites activos detectados)`, totalWidth));
    if (quota.activeBlock) {
      lines.push(fit(`  ${'bloque act.'.padEnd(12)} ${fmtInt(quota.activeBlock.used)} usados  reset ${fmtReset(quota.activeBlock.end)}`, totalWidth));
    }
    return lines;
  }

  if (quota.kind === "detected-percent" && quota.windows?.length) {
    if (quota.serverOverride && quota.note) {
      lines.push(fit(`  ${colors.gray}${quota.note}${RESET}`, totalWidth));
    }
    for (const w of quota.windows) {
      const pct = w.remainingPercent;
      const label2 = (w.label || w.key || "").padEnd(12);
      lines.push(fit(`  ${label2} ${bar(w.usedPercent, 100, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda  reset ${fmtReset(w.reset)}${w.resetText ? ` (${shortText(w.resetText, 30)})` : ""}`, totalWidth));
    }
    if (quota.creditsList?.length) {
      for (const c of quota.creditsList) {
        const name = c.limitId === "premium" ? "mini" : c.limitId;
        const status = c.unlimited ? "ilimitado" : c.has_credits ? `balance: ${c.balance}` : "sin creditos";
        lines.push(fit(`  ${name.padEnd(12)} ${colors.gray}${status}${RESET}`, totalWidth));
      }
    }
    return lines;
  }

  if (quota.kind === "detected-credits" && quota.creditsList?.length) {
    for (const c of quota.creditsList) {
      const name = (c.limitId === "premium" ? "mini" : c.limitId).padEnd(12);
      if (c.unlimited) {
        lines.push(fit(`  ${name} ${bar(0, 100, sectionBar, colors.green)} ilimitado`, totalWidth));
      } else if (c.has_credits) {
        lines.push(fit(`  ${name} ${bar(30, 100, sectionBar, colors.green)} balance: ${c.balance}`, totalWidth));
      } else {
        lines.push(fit(`  ${name} ${bar(100, 100, sectionBar, colors.red)} sin creditos`, totalWidth));
      }
    }
    return lines;
  }

  if (quota.kind === "configured-tokens" && quota.limit) {
    const pct = 100 - Number(quota.usedPercent || 0);
    lines.push(fit(`  ${(quota.windowLabel || "periodo").padEnd(12)} ${bar(quota.used, quota.limit, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda (${fmtInt(quota.remaining)}/${fmtInt(quota.limit)})`, totalWidth));
    return lines;
  }

  if (quota.kind === "configured-requests" && quota.limitRequests) {
    lines.push(fit(`  ${'requests'.padEnd(12)} limite: ${fmtInt(quota.limitRequests)} req/dia`, totalWidth));
    return lines;
  }

  if (quota.kind === "configured-credits" && quota.limit) {
    const pct = 100 - Number(quota.usedPercent || 0);
    lines.push(fit(`  ${'creditos'.padEnd(12)} ${bar(quota.used, quota.limit, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda (${fmtNumber(quota.remaining)}/${fmtNumber(quota.limit)})`, totalWidth));
    if (quota.resetsAt) lines.push(fit(`  reset: ${fmtReset(quota.resetsAt)}`, totalWidth));
    return lines;
  }

  // Claude with live windows
  if (quota.windows?.length) {
    for (const w of quota.windows) {
      const pct = w.remainingPercent;
      const label2 = (w.label || w.rawLabel || w.key || "").padEnd(12);
      lines.push(fit(`  ${label2} ${bar(w.usedPercent, 100, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda  ${w.resetText ? shortText(w.resetText, 35) : `reset ${fmtReset(w.reset)}`}`, totalWidth));
    }
    return lines;
  }

  // Gemini detected-requests
  if (quota.kind === "detected-requests") {
    const pct = quota.remainingPercent ?? 0;
    const reqLabel = quota.remainingRequests != null && quota.limitRequests
      ? `${fmtInt(quota.remainingRequests)}/${fmtInt(quota.limitRequests)} req`
      : `${fmtPct(pct)} queda`;
    const globalReset = quota.resetAt
      ? `reset ${fmtReset(quota.resetAt)}`
      : (quota.resetText ? `reset ${shortText(quota.resetText, 20)}` : "");
    lines.push(fit(`  ${'global'.padEnd(12)} ${bar(quota.usedPercent, 100, sectionBar, quotaColor(pct))} ${reqLabel}  ${globalReset}`, totalWidth));
    if (quota.modelQuotas?.length) {
      for (const mq of quota.modelQuotas) {
        const mpct = mq.remainingPercent;
        const mqReset = mq.resetAt
          ? `reset ${fmtReset(mq.resetAt)}`
          : (mq.resetText ? `reset ${shortText(mq.resetText, 20)}` : "");
        lines.push(fit(`  ${shortText(mq.model, 12).padEnd(12)} ${bar(mq.usedPercent, 100, sectionBar, quotaColor(mpct))} ${fmtPct(mpct)} queda  ${mqReset}`, totalWidth));
      }
    }
    return lines;
  }

  // Claude active block fallback
  if (quota.activeBlock) {
    if (quota.limit) {
      const pct = 100 - Number(quota.usedPercent || 0);
      lines.push(fit(`  ${'bloque'.padEnd(12)} ${bar(quota.used, quota.limit, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda  reset ${fmtReset(quota.activeBlock.end)}`, totalWidth));
    } else {
      lines.push(fit(`  ${'bloque'.padEnd(12)} ${fmtInt(quota.activeBlock.used)} usados  reset ${fmtReset(quota.activeBlock.end)}`, totalWidth));
      lines.push(fit(`  ${colors.gray}configura fiveHourTokens en quotas.json para barra${RESET}`, totalWidth));
    }
    return lines;
  }

  // MiniMax (API-based: limit + used, or percent only, or with reset)
  if (quota.source === "minimax" && quota.ok) {
    const pct = quota.usedPercent != null ? Math.max(0, 100 - quota.usedPercent) : (quota.remainingPercent || 0);
    const resetInfo = quota.resetAt
      ? `reset ${fmtReset(quota.resetAt)}`
      : (quota.resetText ? `reset ${shortText(quota.resetText, 20)}` : "");
    const label = "minimax".padEnd(12);
    if (quota.limit) {
      lines.push(fit(`  ${label} ${bar(quota.used, quota.limit, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda (${fmtNumber(quota.remaining)}/${fmtNumber(quota.limit)})${resetInfo ? `  ${resetInfo}` : ""}`, totalWidth));
    } else {
      const usedVal = quota.used || (quota.usedPercent != null ? quota.usedPercent : 0);
      lines.push(fit(`  ${label} ${bar(usedVal, 100, sectionBar, quotaColor(pct))} ${fmtPct(pct)} queda${resetInfo ? `  ${resetInfo}` : ""}`, totalWidth));
    }
    return lines;
  }

  lines.push(fit(`  ${quota.note || "sin datos"}`, totalWidth));
  return lines;
}

function drawConsumoTab(width, maxHeight, snap) {
  const lines = [];
  const visible = visibleSources();
  const total = state.source === "all" ? snap.sources.all?.totals : visible[0]?.totals;
  lines.push(...summaryCards(width, total, snap));
  lines.push(hr(width));
  lines.push(...sourceCards(width, snap));
  lines.push(hr(width));

  if (state.source === "antigravity") {
    lines.push(...antigravityPanel(width, snap.sources.antigravity));
  } else if (state.source === "minimax") {
    lines.push(...minimaxPanel(width, snap.sources.minimax, snap.quotas?.minimax));
  } else if (state.source === "opencode") {
    lines.push(...opencodePanel(width, snap.sources.opencode, snap.quotas?.opencode));
  } else {
    lines.push(...modelPanel(width, maxHeight - lines.length - 2));
  }

  return lines.slice(0, maxHeight);
}

function summaryCards(width, total, snap) {
  const cardWidth = Math.max(18, Math.floor((width - 6) / 5));
  const effectiveTokens = total?.effectiveTokens ?? (total?.totalTokens || 0);
  const cacheReadTokens = total?.cacheReadTokens || 0;
  const cards = [
    card("Netos", fmtInt(effectiveTokens), "in+cacheCreate+out", cardWidth, colors.cyan),
    card("Cache leido", fmtInt(cacheReadTokens), cacheReadTokens ? `${((cacheReadTokens / Math.max(1, total?.totalTokens || 1)) * 100).toFixed(0)}% del total` : "sin cache", cardWidth, colors.gray),
    card("Coste est.", fmtMoney(total?.totalCost || 0), "no es factura oficial", cardWidth, colors.green),
    card("Salida", fmtInt(total?.outputTokens || 0), "tokens output", cardWidth, colors.magenta),
    card("Latencia", `${snap.elapsedMs} ms`, "lectura local", cardWidth, colors.yellow),
  ];
  return zipCards(cards, width);
}

function sourceCards(width, snap) {
  const sources = ["claude", "codex", "gemini", "antigravity", "minimax", "opencode"];
  const max = Math.max(
    1,
    ...sources.map((source) => {
      if (source === "antigravity") return snap.sources.antigravity?.modelSteps || 0;
      if (source === "opencode") return snap.sources.opencode?.data?.totalCost || 0;
      const totals = snap.sources[source]?.totals;
      return totals?.effectiveTokens ?? totals?.totalTokens ?? 0;
    }),
  );
  const gapWidth = (sources.length - 1) * 2;
  const cardWidth = Math.max(18, Math.floor((width - gapWidth) / sources.length));
  const cards = sources.map((source) => {
    const meta = SOURCE_META[source];
    if (source === "antigravity") {
      const ag = snap.sources.antigravity;
      const body = [
        `${ag.installed ? "instalado" : "no instalado"} | ${ag.sessions} sesiones`,
        bar(ag.modelSteps, max, cardWidth - 4, colors.yellow),
        `${fmtInt(ag.modelSteps)} pasos modelo`,
      ];
      return boxed(meta.label, body, cardWidth, meta.color);
    }
    if (source === "minimax") {
      const usage = snap.sources.minimax;
      const quota = snap.quotas?.minimax;
      if (usage?.ok === false) {
        return boxed(meta.label, [colorText(usage.note || "sin MINIMAX_API_KEY", colors.red), "", "configura la key"], cardWidth, meta.color);
      }
      if (Array.isArray(quota?.windows) && quota.windows.length) {
        const intervalW = quota.windows.find((w) => (w.key || "").includes("interval"));
        const weeklyW = quota.windows.find((w) => (w.key || "").includes("weekly"));
        const intervalPct = intervalW?.remainingPercent ?? 0;
        const weeklyPct = weeklyW?.remainingPercent ?? 0;
        const body = [
          `5h: ${fmtPct(intervalPct)} libre`,
          bar(100 - intervalPct, 100, cardWidth - 4, colors.cyan),
          `sem: ${fmtPct(weeklyPct)} libre`,
        ];
        return boxed(meta.label, body, cardWidth, meta.color);
      }
      const used = quota?.used ?? 0;
      const limit = quota?.limit ?? null;
      const remaining = quota?.remaining ?? null;
      const body = [
        limit ? `${fmtNumber(used)}/${fmtNumber(limit)} usado` : `${fmtNumber(used)} usado`,
        bar(used, Math.max(1, limit || used || 1), cardWidth - 4, colors.cyan),
        remaining != null ? `quedan ${fmtNumber(remaining)}` : (quota?.note || ""),
      ];
      return boxed(meta.label, body, cardWidth, meta.color);
    }
    if (source === "opencode") {
      const usage = snap.sources.opencode;
      const quota = snap.quotas?.opencode;
      if (usage?.ok === false) {
        return boxed(meta.label, [colorText(usage.note || "sin ccusage opencode", colors.red), "", "corre opencode primero"], cardWidth, meta.color);
      }
      const effective = usage?.totals?.effectiveTokens ?? usage?.totals?.totalTokens ?? 0;
      const cacheRead = usage?.totals?.cacheReadTokens || 0;
      const cacheNote = cacheRead ? ` +${fmtCompact(cacheRead)} cache` : "";
      const body = [
        `${fmtInt(effective)} netos${cacheNote}`,
        bar(effective, max, cardWidth - 4, colors.green),
        `${fmtMoney(usage?.totals.totalCost || 0)} | ${usage?.models.length || 0} modelos`,
      ];
      return boxed(meta.label, body, cardWidth, meta.color);
    }
    const usage = snap.sources[source];
    const effective = usage?.totals?.effectiveTokens ?? usage?.totals?.totalTokens ?? 0;
    const cacheRead = usage?.totals?.cacheReadTokens || 0;
    const cacheNote = cacheRead ? ` +${fmtCompact(cacheRead)} cache` : "";
    const body = [
      usage?.ok ? `${fmtInt(effective)} netos${cacheNote}` : "sin datos",
      bar(effective, max, cardWidth - 4, meta.color),
      `${fmtMoney(usage?.totals.totalCost || 0)} | ${usage?.models.length || 0} modelos`,
    ];
    return boxed(meta.label, body, cardWidth, meta.color);
  });
  return zipCards(cards, width);
}

function quotaCards(width, snap) {
  // Now handled by drawQuotaTab — kept for plain text compatibility
  return [];
}

function quotaBody(source, quota, width) {
  if (!quota) return ["sin datos", "", ""];
  if (source === "codex" && quota.kind === "detected-percent" && quota.windows?.length) {
    const primary = quota.windows[0];
    const secondary = quota.windows[1];
    return [
      `${fmtPct(primary.remainingPercent)} queda ${primary.label}`,
      bar(100 - primary.remainingPercent, 100, width - 4, quotaColor(primary.remainingPercent)),
      secondary
        ? `${fmtPct(secondary.remainingPercent)} sem | reset ${fmtReset(primary.reset)}`
        : `reset ${fmtReset(primary.reset)}`,
    ];
  }
  if (source === "codex" && quota.kind === "detected-credits") {
    const c = quota.creditsList?.[0] || {};
    if (c.unlimited) return ["ilimitado", bar(0, 100, width - 4, colors.green), `plan: ${quota.plan || "premium"}`];
    if (c.has_credits) return [`balance: ${c.balance}`, bar(30, 100, width - 4, colors.green), `plan: ${quota.plan || "premium"}`];
    return ["sin creditos", bar(100, 100, width - 4, colors.red), `plan: ${quota.plan || "premium"}`];
  }
  if (source === "claude" && quota.kind === "detected-percent" && quota.windows?.length) {
    const session = quota.windows.find((window) => window.key === "session") || quota.windows[0];
    const week = quota.windows.find((window) => window.key === "week_all");
    const sonnet = quota.windows.find((window) => window.key === "week_sonnet");
    return [
      `${fmtPct(session.remainingPercent)} queda ${session.label}`,
      bar(session.usedPercent, 100, width - 4, quotaColor(session.remainingPercent)),
      week
        ? `sem ${fmtPct(week.remainingPercent)}${sonnet ? ` | son ${fmtPct(sonnet.remainingPercent)}` : ""}`
        : `reset ${shortText(session.resetText, Math.max(6, width - 10))}`,
    ];
  }
  if (source === "gemini" && quota.kind === "detected-requests") {
    const quotaLabel =
      quota.limitRequests && quota.remainingRequests != null
        ? `${fmtInt(quota.remainingRequests)}/${fmtInt(quota.limitRequests)} req`
        : `${fmtPct(quota.remainingPercent)} queda`;
    const modelLine = quota.modelQuotas?.length
      ? quota.modelQuotas
          .slice(0, 2)
          .map((item) => `${shortText(item.model, 5)} ${fmtPct(item.remainingPercent)}`)
          .join(" | ")
      : "";
    return [
      quotaLabel,
      bar(quota.usedPercent, 100, width - 4, quotaColor(quota.remainingPercent)),
      modelLine || `${fmtPct(quota.remainingPercent)} libre${quota.resetText ? ` | ${shortText(quota.resetText, 10)}` : ""}`,
    ];
  }
  if (source === "claude" && quota.activeBlock) {
    if (quota.limit) {
      const remainingPercent = 100 - Number(quota.usedPercent || 0);
      return [
        `${fmtInt(quota.remaining)} quedan`,
        bar(quota.used, quota.limit, width - 4, quotaColor(remainingPercent)),
        `reset ${fmtReset(quota.activeBlock.end)}`,
      ];
    }
    return [
      "limite no config",
      `${fmtInt(quota.activeBlock.used)} usados`,
      quota.activeBlock.end ? `reset ${fmtReset(quota.activeBlock.end)}` : "sin bloque activo",
    ];
  }
  if (quota.kind === "configured-tokens") {
    const remainingPercent = 100 - Number(quota.usedPercent || 0);
    return [
      `${fmtInt(quota.remaining)} quedan`,
      bar(quota.used, quota.limit, width - 4, quotaColor(remainingPercent)),
      `${fmtPct(remainingPercent)} libre/${quota.windowLabel}`,
    ];
  }
  if (quota.kind === "configured-requests") {
    return [`limite ${fmtInt(quota.limitRequests)} req`, "sin usados reales", "esperando /stats"];
  }
  if (quota.kind === "configured-credits") {
    const remainingPercent = 100 - Number(quota.usedPercent || 0);
    return [
      `${fmtNumber(quota.remaining)} creditos`,
      bar(quota.used, quota.limit, width - 4, quotaColor(remainingPercent)),
      quota.resetsAt ? `reset ${quota.resetsAt}` : `${fmtPct(remainingPercent)} libre`,
    ];
  }
  return ["sin limite local", "edita quotas.json", quotaConfigHint()];
}

function modelPanel(width, maxRows) {
  const models = visibleModels();
  const rows = [];
  rows.push(`${colors.bold}Modelos${RESET} ${colors.gray}(ordenado por tokens netos — sin cache read)${RESET}`);
  rows.push(fit(`${colors.gray}${"Modelo".padEnd(34)} ${"Netos".padStart(12)} ${"In".padStart(10)} ${"CacheW".padStart(10)} ${"CacheR".padStart(10)} ${"Out".padStart(10)} ${"Coste".padStart(10)}  Uso${RESET}`, width));
  rows.push(hr(width));

  if (!models.length) {
    rows.push("No hay datos para esta vista/fuente.");
    rows.push("Codex y Gemini no exponen weekly/blocks como vista enfocada en ccusage; usa daily, monthly o session.");
    return rows;
  }

  const max = Math.max(1, ...models.map((model) => model.effectiveTokens ?? model.totalTokens));
  const available = Math.max(3, maxRows - 4);
  const start = Math.max(0, Math.min(state.selectedModel - Math.floor(available / 2), Math.max(0, models.length - available)));
  const slice = models.slice(start, start + available);

  for (let i = 0; i < slice.length; i += 1) {
    const model = slice[i];
    const absoluteIndex = start + i;
    const selected = absoluteIndex === state.selectedModel;
    const effective = model.effectiveTokens ?? model.totalTokens;
    const line =
      `${truncate(model.modelName, 34).padEnd(34)} ` +
      `${fmtInt(effective).padStart(12)} ` +
      `${fmtInt(model.inputTokens).padStart(10)} ` +
      `${fmtInt(model.cacheCreationTokens).padStart(10)} ` +
      `${fmtInt(model.cacheReadTokens).padStart(10)} ` +
      `${fmtInt(model.outputTokens).padStart(10)} ` +
      `${fmtMoney(model.cost).padStart(10)}  ` +
      bar(effective, max, Math.max(8, width - 106), selected ? colors.inverse : modelColor(model.modelName));
    rows.push(fit(selected ? `${colors.inverse}${line}${RESET}` : line, width));
  }

  const selected = models[state.selectedModel];
  if (selected) {
    rows.push(hr(width));
    const effective = selected.effectiveTokens ?? selected.totalTokens;
    rows.push(
      fit(
        `${colors.bold}Detalle:${RESET} ${selected.modelName} | netos ${fmtInt(effective)} | input ${fmtInt(selected.inputTokens)} | cache create ${fmtInt(selected.cacheCreationTokens)} | cache read ${fmtInt(selected.cacheReadTokens)} | output ${fmtInt(selected.outputTokens)} | coste ${fmtMoney(selected.cost)}`,
        width,
      ),
    );
  }
  return rows;
}

function antigravityPanel(width, ag) {
  const rows = [];
  rows.push(`${colors.bold}${colors.yellow}Antigravity${RESET} ${colors.gray}(cuota separada de Gemini CLI)${RESET}`);
  rows.push(hr(width));
  rows.push(`Estado CLI: ${ag.installed ? colorText("instalado", colors.green) : colorText("no instalado", colors.red)}`);
  rows.push(`Ruta datos: ${ag.root}`);
  rows.push(`Modelo por defecto: ${ag.defaultModel || "no configurado"}`);
  rows.push(`Sesiones locales: ${fmtInt(ag.sessions)} | lineas transcript: ${fmtInt(ag.transcriptLines)} | pasos modelo: ${fmtInt(ag.modelSteps)}`);
  rows.push(`Ultima actividad: ${ag.lastActivity ? ag.lastActivity.toISOString().replace("T", " ").slice(0, 19) : "sin datos"}`);
  rows.push("");
  rows.push(colorText("Cuota oficial:", colors.yellow));
  rows.push(fit("Antigravity usa su propio sistema de AI Premium credits/quota. En esta maquina no detecte un token_count local estable para sumar consumo real.", width));
  rows.push(fit("La documentacion publica indica revisar la pagina de settings para baseline quota usage; por eso no lo mezclo con Gemini.", width));
  rows.push("");
  rows.push(`${colors.bold}Modelos disponibles${RESET}`);
  for (const model of ag.models.slice(0, Math.max(0, (process.stdout.rows || 40) - rows.length - 4))) {
    rows.push(`  ${model}`);
  }
  if (!ag.models.length) rows.push("  No pude leer `antigravity models`.");
  return rows;
}

function minimaxPanel(width, usage, quota) {
  const rows = [];
  rows.push(`${colors.bold}${colors.cyan}MiniMax${RESET} ${colors.gray}(cuota de Coding Plan via API)${RESET}`);
  rows.push(hr(width));

  if (!usage || usage.ok === false) {
    rows.push(colorText(usage?.note || "MiniMax no configurado", colors.red));
    rows.push("");
    rows.push(colors.gray + "Para activarlo:" + RESET);
    rows.push("  export MINIMAX_API_KEY=sk-cp-...   # o");
    rows.push("  ai-usage-quota edit   # y agregar minimax.apiKey");
    return rows;
  }

  if (quota?.plan) {
    rows.push(`Plan actual: ${colors.bold}${quota.plan}${RESET}`);
  }
  rows.push("");

  if (Array.isArray(quota?.windows) && quota.windows.length) {
    // Resumen rapido arriba: el modelo/window mas urgente
    const urgent = quota.windows.reduce((min, w) => (w.remainingPercent < (min?.remainingPercent ?? 101) ? w : min), null);
    if (urgent) {
      const periodLabel = (urgent.key || "").includes("weekly") ? "esta semana" : "estas 5h";
      rows.push(colorText(`Te queda ${fmtPct(urgent.remainingPercent)} ${periodLabel} en ${urgent.label || "un modelo"}`, quotaColor(urgent.remainingPercent)));
      if (urgent.reset) {
        rows.push(`${colors.gray}Resetea en ${fmtReset(urgent.reset)}${RESET}`);
      }
      rows.push("");
    }

    rows.push(`${colors.bold}Cuota por modelo${RESET}`);
    const grouped = new Map();
    for (const w of quota.windows) {
      const [period, ...rest] = (w.key || "").split("_");
      const modelName = rest.join("_") || w.label || "model";
      if (!grouped.has(modelName)) grouped.set(modelName, {});
      grouped.get(modelName)[period] = w;
    }
    for (const [modelName, periods] of grouped) {
      rows.push(`  ${colors.bold}${modelName}${RESET}`);
      for (const [period, w] of Object.entries(periods)) {
        const label = period === "interval" ? "5 horas" : period === "weekly" ? "semanal" : period;
        const reset = w.reset ? `reset ${fmtReset(w.reset)}` : "";
        rows.push(fit(`    ${label.padEnd(10)} ${bar(w.usedPercent, 100, Math.max(10, width - 36), quotaColor(w.remainingPercent))} ${fmtPct(w.remainingPercent)} queda  ${reset}`, width));
      }
    }
  } else if (quota) {
    const pct = quota.remainingPercent ?? (quota.usedPercent != null ? Math.max(0, 100 - quota.usedPercent) : 0);
    const usedVal = quota.used || (quota.usedPercent != null ? quota.usedPercent : 0);
    const denom = Math.max(1, quota.limit || usedVal || 1);
    const resetInfo = quota.resetAt
      ? `  reset ${fmtReset(quota.resetAt)}`
      : (quota.resetText ? `  reset ${shortText(quota.resetText, 20)}` : "");
    rows.push(fit(`  ${bar(usedVal, denom, Math.max(10, width - 20), quotaColor(pct))} ${fmtPct(pct)} queda (${fmtNumber(quota.remaining)}/${fmtNumber(quota.limit)})${resetInfo}`, width));
  }

  rows.push("");
  rows.push(colors.gray + "Esto NO incluye el uso de modelos via ccusage (eso va en la pestana de consumo, source=Todos)." + RESET);
  return rows;
}

function opencodePanel(width, usage, quota) {
  const rows = [];
  const headerTag = quota?.serverOverride ? "ccusage + serverOverride" : "ccusage + DB local";
  rows.push(`${colors.bold}${colors.green}OpenCode Go${RESET} ${colors.gray}(${headerTag})${RESET}`);
  rows.push(hr(width));

  if (!usage || usage.ok === false) {
    rows.push(colorText(usage?.note || "OpenCode no detectado por ccusage", colors.red));
    rows.push("");
    rows.push(colors.gray + "Requisito:" + RESET);
    rows.push("  Corre opencode al menos una vez y ten ccusage instalado (npx -y ccusage@latest)");
    return rows;
  }

  const effective = usage.totals?.effectiveTokens ?? usage.totals?.totalTokens ?? 0;
  const cacheRead = usage.totals?.cacheReadTokens || 0;
  rows.push(`Coste total: ${colors.bold}${fmtMoney(usage.totals.totalCost || 0)}${RESET}`);
  rows.push(`Tokens netos: ${fmtInt(effective)} (in: ${fmtInt(usage.totals.inputTokens || 0)} out: ${fmtInt(usage.totals.outputTokens || 0)})`);
  rows.push(`Cache read: ${fmtInt(cacheRead)}  cache create: ${fmtInt(usage.totals.cacheCreationTokens || 0)}`);
  rows.push(`${usage.models.length} modelos detectados`);
  rows.push("");

  rows.push(`${colors.bold}Cuota Go (limites en USD)${RESET}`);
  if (quota?.ok && Array.isArray(quota.windows) && quota.windows.length) {
    if (quota.serverOverride && quota.note) {
      rows.push(colors.gray + quota.note + RESET);
    }
    for (const w of quota.windows) {
      const used = fmtMoney(w.used || 0);
      const limit = fmtMoney(w.limit || 0);
      const reset = w.reset ? `reset ${fmtReset(w.reset)}` : "";
      const tag = w.source === "server" ? " (server)" : " (local)";
      rows.push(fit(`  ${w.label.padEnd(10)} ${bar(w.usedPercent, 100, Math.max(10, width - 36), quotaColor(w.remainingPercent))} ${fmtPct(w.remainingPercent)} queda (${used}/${limit})  ${reset}${tag}`, width));
    }
    rows.push("");
    rows.push(colors.gray + "Limites Go: $12/5h, $30/sem, $60/mes." + RESET);
  } else if (quota?.ok) {
    const cost = quota.totalCost || 0;
    const sessions = quota.sessionCount || 0;
    rows.push(fit(`  coste total: ${fmtMoney(cost)}  |  ${sessions} sesiones Go`, width));
    rows.push(colors.gray + "Configura fiveHourCost, weeklyCost, monthlyCost en quotas.json para barras de cuota." + RESET);
  } else {
    rows.push(colorText(quota?.note || "Sin datos de cuota Go.", colors.yellow));
  }

  rows.push("");
  rows.push(colors.gray + (quota?.serverOverride ? "Consumo via ccusage. Cuota via serverOverride (manual)." : "Consumo via ccusage. Cuota via DB local (cache 5 min).") + RESET);
  return rows;
}

function visibleSources() {
  const snap = state.lastSnapshot;
  if (!snap) return [];
  if (state.source === "all") return ALL_SOURCES.map((source) => snap.sources[source]).filter(Boolean);
  return [snap.sources[state.source]].filter(Boolean);
}

function visibleModels() {
  const snap = state.lastSnapshot;
  if (!snap) return [];
  if (state.source === "all") return snap.sources.all?.models ?? [];
  return snap.sources[state.source]?.models ?? [];
}

function renderPlainSummary(snap) {
  const lines = [];
  lines.push(`AI Usage TUI snapshot (${snap.view}) since ${snap.since}`);
  for (const source of ["all", "claude", "codex"]) {
    const usage = snap.sources[source];
    if (!usage) continue;
    const effective = usage.totals.effectiveTokens ?? usage.totals.totalTokens;
    const cacheRead = usage.totals.cacheReadTokens || 0;
    const cacheNote = cacheRead ? ` cache_read=${fmtInt(cacheRead)}` : "";
    lines.push(`${SOURCE_META[source].label.padEnd(8)} effective=${fmtInt(effective)}${cacheNote} total=${fmtInt(usage.totals.totalTokens)} cost=${fmtMoney(usage.totals.totalCost)} models=${usage.models.length}`);
  }
  const ag = snap.sources.antigravity;
  lines.push(`Antigravity installed=${ag.installed} sessions=${ag.sessions} model_steps=${ag.modelSteps} default="${ag.defaultModel || ""}"`);
  if (snap.quotas?.codex?.windows?.length) {
    const primary = snap.quotas.codex.windows[0];
    const secondary = snap.quotas.codex.windows[1];
    lines.push(`Codex quota ${primary.label}: used=${fmtPct(primary.usedPercent)} remaining=${fmtPct(primary.remainingPercent)} reset=${fmtReset(primary.reset)}`);
    if (secondary) lines.push(`Codex quota ${secondary.label}: used=${fmtPct(secondary.usedPercent)} remaining=${fmtPct(secondary.remainingPercent)} reset=${fmtReset(secondary.reset)}`);
  } else if (snap.quotas?.codex?.kind === "detected-credits") {
    for (const c of snap.quotas.codex.creditsList || []) {
      const name = c.limitId === "premium" ? "mini" : c.limitId || "codex";
      const status = c.unlimited ? "unlimited" : c.has_credits ? `balance=${c.balance}` : "no_credits";
      lines.push(`Codex quota credits ${name}: ${status} plan=${snap.quotas.codex.plan || "unknown"}`);
    }
  }
  if (snap.quotas?.claude?.kind === "detected-percent") {
    for (const window of snap.quotas.claude.windows) {
      lines.push(
        `Claude quota ${window.label}: used=${fmtPct(window.usedPercent)} remaining=${fmtPct(window.remainingPercent)}${window.resetText ? ` reset="${window.resetText}"` : ""}`,
      );
    }
  } else if (snap.quotas?.claude?.kind === "subscription") {
    lines.push(`Claude quota: subscription active (no limits detected)`);
  }
  if (snap.quotas?.claude?.activeBlock) {
    const q = snap.quotas.claude;
    if (q.kind !== "detected-percent") {
      lines.push(`Claude active block: used=${fmtInt(q.used)}${q.limit ? ` limit=${fmtInt(q.limit)} remaining=${fmtInt(q.remaining)}` : " limit=not configured"} reset=${fmtReset(q.activeBlock.end)}`);
    } else {
      lines.push(`Claude active block tokens=${fmtInt(q.activeBlock.used)} reset=${fmtReset(q.activeBlock.end)}`);
    }
  }
  if (snap.quotas?.minimax) {
    const mq = snap.quotas.minimax;
    if (mq.ok) {
      if (Array.isArray(mq.windows) && mq.windows.length) {
        for (const w of mq.windows) {
          const reset = w.reset ? ` reset=${fmtReset(w.reset)}` : "";
          lines.push(`MiniMax quota ${w.label}: used=${fmtPct(w.usedPercent)} remaining=${fmtPct(w.remainingPercent)}${reset}`);
        }
      } else {
        const pct = mq.usedPercent != null ? fmtPct(mq.usedPercent) : "--";
        const remain = mq.remaining != null ? fmtNumber(mq.remaining) : "--";
        const limit = mq.limit != null ? fmtNumber(mq.limit) : "--";
        const reset = mq.resetAt ? ` reset=${fmtReset(mq.resetAt)}` : (mq.resetText ? ` reset="${mq.resetText}"` : "");
        lines.push(`MiniMax quota: used=${pct} remaining=${remain}/${limit}${reset}`);
      }
    } else {
      lines.push(`MiniMax: ${mq.note || "sin datos"}`);
    }
  }
  if (snap.quotas?.opencode) {
    const oq = snap.quotas.opencode;
    if (oq.ok) {
      if (oq.serverOverride && oq.note) {
        lines.push(`OpenCode Go [serverOverride]: ${oq.note}`);
      }
      if (Array.isArray(oq.windows) && oq.windows.length) {
        for (const w of oq.windows) {
          const used = fmtMoney(w.used || 0);
          const limit = fmtMoney(w.limit || 0);
          const reset = w.reset ? ` reset=${fmtReset(w.reset)}` : "";
          const tag = w.source === "server" ? " [server]" : " [local]";
          lines.push(`OpenCode Go ${w.label}: used=${used}/${limit} (${fmtPct(w.usedPercent)}) remaining=${fmtPct(w.remainingPercent)}${reset}${tag}`);
        }
      } else {
        lines.push(`OpenCode Go: cost=${fmtMoney(oq.totalCost || 0)} tokens=${fmtInt(oq.totalTokens || 0)} sessions=${oq.sessionCount || 0}`);
      }
    } else {
      lines.push(`OpenCode: ${oq.note || "sin datos"}`);
    }
  }
  if (snap.quotas?.antigravity) {
    const aq = snap.quotas.antigravity;
    if (aq.kind === "detected-percent" && Array.isArray(aq.windows) && aq.windows.length) {
      for (const w of aq.windows) {
        lines.push(`Antigravity quota ${w.label}: used=${fmtPct(w.usedPercent)} remaining=${fmtPct(w.remainingPercent)}${w.reset ? ` reset=${fmtReset(w.reset)}` : ""}`);
      }
      if (aq.note) lines.push(`Antigravity: ${aq.note}`);
    } else if (aq.kind === "configured-credits" && aq.limit) {
      lines.push(`Antigravity quota: used=${fmtNumber(aq.used)}/${fmtNumber(aq.limit)} (${fmtPct(aq.usedPercent)}) remaining=${fmtPct(aq.remainingPercent)}${aq.resetsAt ? ` reset=${fmtReset(aq.resetsAt)}` : ""}`);
    } else if (aq.note) {
      lines.push(`Antigravity quota: ${aq.note}`);
    }
  }
  lines.push(`Quota config: ${snap.quotas?.configPath || QUOTA_CONFIG_PATH}`);
  return lines.join("\n");
}

function tabBar(items, active, isTab = false) {
  return items
    .map((item) => {
      const label = SOURCE_META[item]?.label || item.charAt(0).toUpperCase() + item.slice(1);
      if (item === active) return `${isTab ? colors.bold : ""}${colors.inverse} ${label} ${RESET}`;
      return `${colors.gray}${label}${RESET}`;
    })
    .join(" ");
}

function card(title, value, sub, width, color) {
  return boxed(title, [`${color}${colors.bold}${value}${RESET}`, `${colors.gray}${sub}${RESET}`], width, color);
}

function boxed(title, body, width, color) {
  const inner = Math.max(4, width - 2);
  const top = `${color}+${"-".repeat(inner)}+${RESET}`;
  const titleLine = `|${fitRaw(` ${title}`, inner)}|`;
  const bodyLines = body.map((line) => `|${fitRaw(` ${line}`, inner)}|`);
  const bottom = `${color}+${"-".repeat(inner)}+${RESET}`;
  return [top, `${color}${titleLine}${RESET}`, ...bodyLines, bottom];
}

function zipCards(cards, width) {
  const height = Math.max(...cards.map((cardLines) => cardLines.length));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(fit(cards.map((cardLines) => cardLines[y] || " ".repeat(visibleLength(cardLines[0]))).join("  "), width));
  }
  return rows;
}

function bar(value, max, width, color) {
  const size = Math.max(1, width);
  const v = Number.isFinite(value) ? value : 0;
  const m = Number.isFinite(max) && max > 0 ? max : 1;
  const filled = Math.max(0, Math.min(size, Math.round((v / m) * size)));
  return `${color}${"#".repeat(filled)}${colors.gray}${"-".repeat(size - filled)}${RESET}`;
}

function modelColor(name) {
  const lower = name.toLowerCase();
  if (lower.includes("claude")) return colors.magenta;
  if (lower.includes("gpt")) return colors.green;
  if (lower.includes("gemini")) return colors.blue;
  if (lower.includes("minimax")) return colors.cyan;
  if (lower.includes("deepseek") || lower.includes("qwen") || lower.includes("kimi") || lower.includes("glm")) return colors.green;
  return colors.cyan;
}

function quotaColor(remainingPercent) {
  if (remainingPercent <= 10) return colors.red;
  if (remainingPercent <= 25) return colors.yellow;
  return colors.green;
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function fmtNumber(value) {
  const n = Number(value || 0);
  if (Number.isInteger(n)) return fmtInt(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtReset(date) {
  if (!date) return "--";
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return String(date);
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "ya";

  const minutes = Math.ceil(diffMs / 60000);
  let durationStr;
  if (minutes < 60) durationStr = `${minutes}m`;
  else {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    durationStr = rest ? `${hours}h${rest}m` : `${hours}h`;
  }

  const timeStr = target.toTimeString().slice(0, 5);
  const now = new Date();
  if (target.toDateString() === now.toDateString()) {
    return `${timeStr} (${durationStr})`;
  }
  const dayStr = target.toLocaleDateString("es", { month: "short", day: "numeric" });
  return `${dayStr} ${timeStr} (${durationStr})`;
}

function quotaConfigHint() {
  return "ai-usage-quota";
}

function colorText(value, color) {
  return `${color}${value}${RESET}`;
}

function hr(width) {
  return `${colors.gray}${"-".repeat(Math.max(0, width))}${RESET}`;
}

function fit(value, width) {
  const raw = stripAnsi(value);
  if (raw.length <= width) return value + " ".repeat(width - raw.length);
  return truncateAnsi(value, width);
}

function fitRaw(value, width) {
  const raw = stripAnsi(value);
  if (raw.length <= width) return value + " ".repeat(width - raw.length);
  return truncate(raw, width);
}

function padLine(value, width) {
  return fit(value, width);
}

function truncate(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + ".";
}

function shortText(value, width) {
  return truncate(normalizeResetText(value), width);
}

function truncateAnsi(value, width) {
  const text = String(value);
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const limit = Math.max(0, width - 1); // reserva 1 col para el "."
  let out = "";
  let visible = 0;
  let sawAnsi = false;
  for (let i = 0; i < text.length && visible < limit; ) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (match) {
        out += match[0];
        i += match[0].length;
        sawAnsi = true;
        continue;
      }
    }
    out += text[i];
    visible += 1;
    i += 1;
  }
  return `${out}.${sawAnsi ? RESET : ""}`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function fmtInt(value) {
  return Math.round(Number(value || 0)).toLocaleString("en-US");
}

function fmtCompact(value) {
  const n = Number(value || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function fmtMoney(value) {
  const n = Number(value || 0);
  if (!n) return "$0.00";
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

function timeOnly(date) {
  if (!date) return "--:--:--";
  return new Date(date).toISOString().slice(11, 19);
}

function cleanup() {
  clearTimeout(refreshTimer);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Ignore cleanup errors.
    }
  }
  if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR + ALT_OFF + RESET);
}

function exit(code) {
  cleanup();
  process.exit(code);
}

// Exports para pruebas unitarias (no se ejecuta main() al importar; ver INVOKED_DIRECTLY).
export {
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
  claudeWindowKey,
  claudeWindowLabel,
  numberFromAny,
  bar,
  truncateAnsi,
  stripAnsi,
  visibleLength,
  fit,
  fmtPct,
  fmtMoney,
  fmtInt,
  fmtCompact,
};
