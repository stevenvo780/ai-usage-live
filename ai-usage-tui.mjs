#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  gemini: { label: "Gemini · Agy", color: colors.blue },
  antigravity: { label: "Antigravity", color: colors.yellow },
  minimax: { label: "MiniMax", color: colors.cyan },
  opencode: { label: "OpenCode", color: colors.green },
};

const ALL_SOURCES = ["claude", "codex", "gemini", "opencode"];
const SOURCE_KEYS = ["all", "claude", "codex", "gemini", "minimax", "opencode"];
// El grid muestra licencias ejecutables, no fuentes tecnicas. OpenCode sigue disponible en
// consumo, pero no ocupa una tarjeta de licencia. Claude/Gemini se expanden mas abajo a una
// tarjeta por cuenta.
const PROVIDER_ORDER = ["claude", "codex", "gemini", "minimax"];
// Inventario de colectores, independiente de lo que el TUI decide mostrar. Agy/Antigravity
// sigue alimentando Gemini aunque no tenga una tarjeta duplicada en PROVIDER_ORDER.
const ACCOUNT_PROVIDER_ORDER = ["claude", "codex", "gemini", "antigravity", "minimax", "opencode"];
// Metadata visual de cada proveedor para el grid/detalle de cuotas.
// Iconos single-width (NO emojis doble-ancho) para que no descuadren el TUI.
const PROVIDER_META = {
  claude: { label: "Claude", color: colors.magenta, icon: "\u2726" },
  codex: { label: "GPT · Codex", color: colors.green, icon: "\u2B21" },
  gemini: { label: "Gemini · Agy", color: colors.blue, icon: "\u25C8" },
  antigravity: { label: "Antigravity", color: colors.yellow, icon: "\u25C6" },
  minimax: { label: "MiniMax", color: colors.cyan, icon: "\u25B0" },
  opencode: { label: "OpenCode", color: colors.blue, icon: "\u26C1" },
};
const VIEW_KEYS = ["daily", "weekly", "monthly", "session", "blocks"];
const TAB_KEYS = ["cuotas", "consumo"];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(SCRIPT_DIR, "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
})();
const CONFIG_BASE_DIR = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const CONFIG_DIR = path.join(CONFIG_BASE_DIR, "ai-usage-live");
const QUOTA_CONFIG_PATH = path.join(CONFIG_DIR, "quotas.json");
const CLAUDE_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "claude-usage-cache.json");
const GEMINI_QUOTA_CACHE_PATH = path.join(CONFIG_DIR, "gemini-quota-cache.json");
const MINIMAX_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "minimax-usage-cache.json");
const OPENCODE_USAGE_CACHE_PATH = path.join(CONFIG_DIR, "opencode-usage-cache.json");
const OPENCODE_DB_FALLBACK_PATH = path.join(
  process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
  "opencode",
  "opencode.db",
);
const ANTIGRAVITY_QUOTA_CACHE_PATH = path.join(CONFIG_DIR, "antigravity-quota-cache.json");
const ANTIGRAVITY_TOKEN_PATH = path.join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const ANTIGRAVITY_PROJECTS_PATH = path.join(homedir(), ".gemini", "antigravity-cli", "cache", "projects.json");
const ANTIGRAVITY_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const OPENCODE_SERVER_CACHE_PATH = path.join(CONFIG_DIR, "opencode-server-cache.json");
const OPENCODE_WEB_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CODEX_PROBE_CACHE_PATH = path.join(CONFIG_DIR, "codex-probe-cache.json");

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
  cardIndex: 0,
  detailModelIndex: 0, // cursor de modelo dentro del detalle (indexa la lista aplanada de ventanas)
  revealHidden: false, // modo "ver ocultos" (H): muestra tarjetas/modelos ocultos sin desocultarlos
  detail: false,
  once: args.once,
  json: args.json,
};

let ccusageCommand = null;
let refreshTimer = null;
let pendingRefresh = null;
// Copia en memoria del bloque `display` de quotas.json; las teclas h/H la mutan y
// saveDisplayConfig() la vuelca a disco. hiddenModels usa el token "provider:modelKey".
let displayConfig = { hideUnusable: true, hiddenProviders: [], hiddenModels: [] };

const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// El arranque (llamar a main()) se dispara al FINAL del archivo, no aca: aca solo se
// calcula el flag. main() llega sincronicamente (antes de su primer await) hasta
// resolveAllAccounts()/inspectAccountCredential(), que leen consts de modulo declaradas
// mas abajo (DEFAULT_ACCOUNT_ID, PLACEHOLDER_TOKEN_RE, ACCOUNT_BLOCKING_STATUSES, etc. —
// la infraestructura de cuentas). Si el arranque quedara aca, esas consts seguirian en su
// TDZ (la evaluacion del modulo todavia no llego a esas lineas) y CUALQUIER ejecucion
// directa (`node ai-usage-tui.mjs`, `--once`, `--json`, la TUI interactiva) reventaria con
// "ReferenceError: Cannot access '<CONST>' before initialization" antes de imprimir nada
// (verificado: se reproduce siempre, de forma determinista, no es intermitente).

async function main() {
  ccusageCommand = detectCcusage();
  const interactive = !state.once && !state.json && process.stdin.isTTY && process.stdout.isTTY;
  state.lastSnapshot = interactive
    ? await collectSnapshot({ includeLive: false })
    : await collectSnapshot({ includeLive: true, ignoreMiniMaxCache: true });

  if (!interactive) {
    if (state.json) console.log(JSON.stringify(buildAgentQuotaSummary(state.lastSnapshot), null, 2));
    else console.log(renderPlainSummary(state.lastSnapshot));
    return;
  }

  loadDisplayConfig(state.lastSnapshot?.quotaConfig?.display);

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
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--since") parsed.since = argv[++i];
    else if (arg === "--until") parsed.until = argv[++i];
    else if (arg === "--refresh") parsed.refreshSec = Number(argv[++i]);
    else if (arg === "--view") parsed.view = argv[++i];
    else if (arg === "--source") parsed.source = argv[++i];
    else if (VIEW_KEYS.includes(arg)) parsed.view = arg;
    else if (SOURCE_KEYS.includes(arg)) parsed.source = arg;
    else if (arg === "antigravity") parsed.source = "gemini";
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  // Compatibilidad: scripts viejos pueden seguir pasando --source antigravity, pero la
  // interfaz lo concilia bajo el unico nombre que usa el operador: Gemini · Agy.
  if (parsed.source === "antigravity") parsed.source = "gemini";
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
  all, claude, codex, gemini (via Agy), minimax, opencode

Opciones:
  --since YYYY-MM-DD
  --until YYYY-MM-DD
  --refresh SEGUNDOS
  --once
  --json

Teclas:
  q salir, r refrescar, 1 daily, 2 weekly, 3 monthly, 4 session, 5 blocks
  a todos, c Claude, x Codex, g/v Gemini · Agy, m MiniMax, o OpenCode, flechas mover modelo
  h ocultar proveedor/modelo seleccionado, H ver/gestionar ocultos (cuotas)
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
    // El set visible pudo encogerse (un proveedor paso a needsAuth/not-installed) o el
    // proveedor en detalle pudo perder ventanas: re-alinea los indices para que h/flechas
    // no queden apuntando fuera de rango tras la captura.
    reconcileCardIndex();
    const selected = visibleQuotaCards()[state.cardIndex];
    const listLen = selected ? detailWindowList(selected.quota, selected.provider).length : 0;
    if (state.detailModelIndex > listLen - 1) state.detailModelIndex = Math.max(0, listLen - 1);
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
  // Cuentas resueltas UNA vez por snapshot: la validacion, el preflight de credenciales
  // y la herencia de defaults se hacen aqui, no dentro de cada colector.
  const accounts = resolveAllAccounts(quotaConfig);
  const staleNote = (base) => (reason) => (reason ? `${base} (${reason})` : base);
  // El paralelismo ENTRE proveedores no cambia; lo que cambia es que dentro de cada
  // rama las cuentas se recorren en serie con presupuesto.
  const liveQuotaPromise = Promise.allSettled([
    collectProviderAccountsLive("claude", accounts.claude, {
      includeLive,
      ignoreCache: ignoreLiveCache,
      cacheSuffix: "usage-cache",
      run: (account, opts) => collectClaudeUsageLive(account.config, { ...opts, account }),
      stale: (account, reason) => staleLiveQuota(
        "claude",
        accountCachePath(account, "usage-cache"),
        staleNote("Claude /usage se esta capturando; mostrando ultimo dato conocido.")(reason),
        staleNote("Claude /usage se esta capturando en segundo plano.")(reason),
      ),
    }),
    collectProviderAccountsLive("antigravity", accounts.antigravity, {
      includeLive,
      ignoreCache: ignoreLiveCache,
      cacheSuffix: "quota-cache",
      run: (account, opts) => collectAntigravityQuotaLive(account.config, { ...opts, account }),
      stale: (account, reason) => staleLiveQuota(
        "antigravity",
        accountCachePath(account, "quota-cache"),
        staleNote("Antigravity quota se esta capturando; mostrando ultimo dato conocido.")(reason),
        staleNote("Antigravity quota se esta capturando en segundo plano.")(reason),
      ),
    }),
    collectProviderAccountsLive("gemini", accounts.gemini, {
      includeLive,
      ignoreCache: ignoreLiveCache,
      cacheSuffix: "quota-cache",
      run: (account, opts) => collectGeminiQuotaLive(account.config, { ...opts, account }),
      stale: (account, reason) => staleLiveQuota(
        "gemini",
        accountCachePath(account, "quota-cache"),
        staleNote("Gemini /stats model se esta capturando; mostrando ultimo dato conocido.")(reason),
        staleNote("Gemini /stats model se esta capturando en segundo plano.")(reason),
      ),
    }),
  ]);

  const ccusageJobs = [];
  const ccOpts = { ignoreCache: ignoreLiveCache };
  ccusageJobs.push(["all", ccusageJson([], view, ccOpts)]);
  ccusageJobs.push(["claudeBlocks", ccusageJson(["claude"], "blocks", ccOpts)]);

  for (const source of ALL_SOURCES) {
    if (sourceSupportsView(source, view)) {
      ccusageJobs.push([source, ccusageJson([source], view, ccOpts)]);
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
  sources.minimaxAccounts = await collectProviderAccountsLive("minimax", accounts.minimax, {
    includeLive,
    ignoreCache: ignoreMiniMaxCache,
    cacheSuffix: "usage-cache",
    run: (account, opts) => collectMiniMaxUsage(quotaConfig, { ...opts, account }),
    stale: (account) => staleCachedUsage(
      "minimax",
      accountCachePath(account, "usage-cache"),
      "MiniMax se esta capturando; mostrando ultimo dato conocido.",
      "MiniMax se esta capturando en segundo plano.",
    ),
  });
  sources.minimax = primaryAccountLive(sources.minimaxAccounts, { source: "minimax", ok: false });
  sources.opencodeAccounts = await collectProviderAccountsLive("opencode", accounts.opencode, {
    includeLive,
    ignoreCache: ignoreLiveCache || ignoreMiniMaxCache,
    cacheSuffix: "usage-cache",
    run: (account, opts) => collectOpenCodeUsage(quotaConfig, { ...opts, account }),
    stale: (account) => staleCachedUsage(
      "opencode",
      accountCachePath(account, "usage-cache"),
      "OpenCode Go se esta capturando; mostrando ultimo dato conocido.",
      "OpenCode Go se esta capturando en segundo plano.",
    ),
  });
  sources.opencodeLive = primaryAccountLive(sources.opencodeAccounts, { source: "opencode", ok: false });
  enrichUnifiedReasoning(sources);
  sources.opencodeServer = includeLive
    ? await collectOpenCodeServerUsage(quotaConfig.opencode, { ignoreCache: ignoreLiveCache || ignoreMiniMaxCache })
    : (readJsonSafe(OPENCODE_SERVER_CACHE_PATH) ? { ...readJsonSafe(OPENCODE_SERVER_CACHE_PATH), cacheHit: true, cacheStale: true } : { ok: false });
  const liveQuotaSettled = await liveQuotaPromise;
  sources.claudeLiveAccounts = liveQuotaSettled[0].status === "fulfilled" ? liveQuotaSettled[0].value : [];
  sources.antigravityLiveAccounts = liveQuotaSettled[1].status === "fulfilled" ? liveQuotaSettled[1].value : [];
  sources.geminiLiveAccounts = liveQuotaSettled[2].status === "fulfilled" ? liveQuotaSettled[2].value : [];
  sources.claudeLive = primaryAccountLive(sources.claudeLiveAccounts, { ok: false });
  sources.antigravityLive = primaryAccountLive(sources.antigravityLiveAccounts, { ok: false });
  sources.geminiLive = primaryAccountLive(sources.geminiLiveAccounts, { ok: false });
  sources.codexLiveAccounts = await collectProviderAccountsLive("codex", accounts.codex, {
    includeLive,
    ignoreCache: ignoreLiveCache,
    cacheSuffix: "probe-cache",
    run: (account, opts) => collectCodexLive(account.config, { ...opts, account }),
    stale: (account) => readJsonSafe(accountCachePath(account, "probe-cache")) || { ok: false },
  });
  sources.codexLive = primaryAccountLive(sources.codexLiveAccounts, { ok: false });
  const quotas = buildQuotaState(sources, quotaConfig, accounts);

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

// Usada por los `stale:` callback de MiniMax/OpenCode (proveedores de "usage" cacheado, no
// de "quota en vivo"): mismo shape/comportamiento que staleLiveQuota (cache-hit -> datos
// viejos marcados stale; sin cache -> {ok:false, note}). Nombre propio solo para que cada
// call-site sea autoexplicativo sobre que tipo de dato esta sirviendo.
function staleCachedUsage(source, cachePath, cacheNote, emptyNote) {
  return staleLiveQuota(source, cachePath, cacheNote, emptyNote);
}

// ---------------------------------------------------------------------------
// Planificador de capturas vivas por cuenta.
//
// COSTO: claude /usage, agy /usage y gemini /stats abren un CLI COMPLETO (30-45 s) y el
// tools/call del MCP BLOQUEA sobre el snapshot. Con N cuentas en paralelo se dispararia
// la latencia del hook y el auto-throttle de /usage. Reglas:
//   (a) las cuentas del MISMO proveedor se capturan EN SERIE (el paralelismo ENTRE
//       proveedores no cambia);
//   (b) presupuesto de 1 captura viva por refresh para proveedores pesados, eligiendo la
//       cuenta menos reciente (LRU); las demas se sirven de SU cache marcadas stale.
// Con UNA cuenta el presupuesto es infinito -> comportamiento identico al de siempre.
// ---------------------------------------------------------------------------

function providerLiveTtlMs(provider, config = {}) {
  switch (provider) {
    case "claude":
      return Math.max(0, Number(config.liveUsageCacheSeconds ?? 300)) * 1000;
    case "codex": {
      const legacyMinutes = Number(process.env.CODEX_PROBE_CACHE_MINUTES ?? config.probeCacheMinutes ?? 1);
      return Math.max(0, Number(process.env.CODEX_USAGE_CACHE_SECONDS ?? config.liveUsageCacheSeconds ?? legacyMinutes * 60)) * 1000;
    }
    case "gemini":
      return Math.max(0, Number(config.liveCaptureCacheMinutes ?? 15)) * 60000;
    case "antigravity":
      return Math.max(0, Number(process.env.ANTIGRAVITY_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 3)) * 60000;
    case "minimax":
      return Math.max(0, Number(process.env.MINIMAX_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 0)) * 60000;
    case "opencode":
      return Math.max(0, Number(process.env.OPENCODE_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 5)) * 60000;
    default:
      return 0;
  }
}

function liveAccountBudget(provider, resolved, { ignoreCache = false } = {}) {
  if (!resolved?.multi) return Infinity;
  if (ignoreCache) return Infinity; // refresh manual explicito: el humano pidio todo
  const fromEnv = Number(process.env.AI_USAGE_PROBE_BUDGET);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const configured = Number(resolved.accounts[0]?.config?.maxLiveAccountsPerRefresh);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return HEAVY_PROBE_PROVIDERS.has(provider) ? 1 : Infinity;
}

function readAccountSched(account) {
  return readJsonSafe(accountCachePath(account, "sched")) || {};
}

function writeAccountSched(account, patch) {
  const current = readAccountSched(account);
  writeJsonCache(accountCachePath(account, "sched"), { ...current, ...patch });
}

// Backoff exponencial acotado: tras fallos consecutivos la cuenta deja de consumir
// presupuesto (y de colgarse 30 s por refresh) hasta que toque su turno o el humano
// pida un refresh manual con ignoreCache.
function accountBackoffMs(failureCount) {
  const n = Math.max(0, Number(failureCount) || 0);
  if (!n) return 0;
  return Math.min(5 * 60000 * 2 ** (n - 1), 6 * 3600000);
}

function blockedAccountLive(provider, account) {
  const status = account.duplicateOf
    ? "duplicate"
    : account.enabled === false
      ? "disabled"
      : account.health?.status || "unknown";
  const notes = {
    duplicate: `Cuenta ignorada: apunta a la misma suscripcion que "${account.duplicateOf}".`,
    disabled: "Cuenta deshabilitada en quotas.json (enabled:false).",
    unauthenticated: `Cuenta sin credencial usable: ${account.health?.detail || "sin credenciales"}.`,
    "credential-broken": `Credencial rota: ${account.health?.detail || "token invalido"}.`,
    "credential-expired": `Credencial vencida: ${account.health?.detail || "token vencido"}.`,
  };
  return {
    source: provider,
    ok: false,
    unusable: true,
    reason: status === "unauthenticated" ? "unauthenticated" : "not-configured",
    needsAuth: status === "unauthenticated" || status === "credential-broken" || status === "credential-expired",
    accountBlocked: true,
    accountStatus: status,
    note: notes[status] || `Cuenta no utilizable (${status}).`,
  };
}

async function collectProviderAccountsLive(provider, resolved, {
  includeLive = true,
  ignoreCache = false,
  run,
  stale,
  cacheSuffix,
} = {}) {
  const accounts = resolved?.accounts || [];
  const results = new Map();
  const wrap = (account, live) => ({
    accountId: account.id,
    account,
    provider,
    label: account.label,
    priority: account.priority,
    enabled: account.enabled,
    blocked: Boolean(account.blocked),
    health: account.health,
    live,
  });

  if (!includeLive) {
    // Rama del TUI interactivo: SOLO lecturas de disco, jamas un proceso pesado.
    return accounts.map((account) => wrap(account, stale(account)));
  }

  const budget = liveAccountBudget(provider, resolved, { ignoreCache });
  const now = Date.now();
  const pending = [];
  for (const account of accounts) {
    if (account.blocked) {
      // Preflight gratis: nunca gastamos un CLI de 30-45 s en una credencial rota.
      results.set(account.id, wrap(account, blockedAccountLive(provider, account)));
      continue;
    }
    const cachePath = accountCachePath(account, cacheSuffix);
    const ttlMs = providerLiveTtlMs(provider, account.config);
    const fresh = !ignoreCache && ttlMs > 0 && Boolean(readJsonCache(cachePath, ttlMs));
    if (fresh) {
      // El cache esta vigente: el colector lo devuelve sin lanzar nada, no gasta presupuesto.
      results.set(account.id, wrap(account, await run(account, { ignoreCache: false })));
      continue;
    }
    const sched = resolved.multi ? readAccountSched(account) : {};
    const nextEligibleAt = Date.parse(sched.nextEligibleAt || "");
    const throttled = !ignoreCache && Number.isFinite(nextEligibleAt) && nextEligibleAt > now;
    const cached = readJsonSafe(cachePath);
    const lastSeen = Math.max(
      Date.parse(cached?.capturedAt || "") || 0,
      Date.parse(sched.lastAttemptAt || "") || 0,
    );
    pending.push({ account, cachePath, lastSeen, throttled });
  }

  // LRU: la cuenta con la observacion mas vieja primero. Se autocorrige si un refresh
  // muere a mitad del probe y una cuenta nueva (lastSeen 0) gana turno automaticamente.
  pending.sort((a, b) => a.lastSeen - b.lastSeen);
  let spent = 0;
  for (const item of pending) {
    const { account, cachePath, throttled } = item;
    if (throttled || spent >= budget) {
      results.set(account.id, wrap(account, stale(account, throttled ? "backoff" : "presupuesto")));
      continue;
    }
    spent += 1;
    // lastAttemptAt ANTES del probe: si el proceso muere o hay timeout, el proximo
    // refresh no reintenta la misma cuenta en bucle cerrado.
    if (resolved.multi) writeAccountSched(account, { lastAttemptAt: new Date().toISOString() });
    let live;
    try {
      live = await run(account, { ignoreCache });
    } catch (error) {
      live = { source: provider, ok: false, note: `captura fallo: ${shortError(error)}` };
    }
    if (resolved.multi) {
      const sched = readAccountSched(account);
      const failureCount = live?.ok ? 0 : Math.max(0, Number(sched.failureCount) || 0) + 1;
      writeAccountSched(account, {
        failureCount,
        lastSuccessAt: live?.ok ? new Date().toISOString() : sched.lastSuccessAt || null,
        nextEligibleAt: failureCount
          ? new Date(Date.now() + accountBackoffMs(failureCount)).toISOString()
          : null,
      });
    }
    void cachePath;
    results.set(account.id, wrap(account, live));
  }
  return accounts.map((account) => results.get(account.id)).filter(Boolean);
}

// El primer elemento es la cuenta declarada primero: mantiene `sources.<p>Live` con
// exactamente la misma forma que antes para todos los consumidores existentes.
function primaryAccountLive(entries, fallback) {
  const first = Array.isArray(entries) ? entries[0] : null;
  return first?.live ?? fallback;
}

function sourceSupportsView(source, view) {
  if (source === "claude") return true;
  if (source === "codex" || source === "gemini") return ["daily", "monthly", "session"].includes(view);
  if (source === "opencode") return ["daily", "weekly", "monthly", "session"].includes(view);
  return true;
}

async function ccusageJson(prefix, view, { ignoreCache = false } = {}) {
  // ccusage (npx) tarda ~10s; lo cacheamos CCUSAGE_CACHE_SECONDS (default 60s) por-query para
  // que los refreshes y el MCP/hook (cada prompt) no re-corran npx cada vez. `r` lo ignora.
  const key = `${prefix.join("-") || "all"}-${view}-${state.since || "x"}-${state.until || "x"}`.replace(/[^a-z0-9-]/gi, "");
  const cacheFile = path.join(CONFIG_DIR, `ccusage-cache-${key}.json`);
  const cacheSeconds = Number(process.env.CCUSAGE_CACHE_SECONDS ?? 60);
  if (!ignoreCache && cacheSeconds > 0) {
    const cached = readJsonCache(cacheFile, cacheSeconds * 1000);
    if (cached && "data" in cached) return cached.data;
  }
  const args = [...ccusageCommand.args, ...prefix, view, "--json"];
  if (state.since) args.push("--since", state.since);
  if (state.until) args.push("--until", state.until);

  const { stdout } = await execFileAsync(ccusageCommand.cmd, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  });
  const data = JSON.parse(stdout);
  if (cacheSeconds > 0) writeJsonCache(cacheFile, { data });
  return data;
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
    for (const key of ["inputTokens", "outputTokens", "reasoningOutputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost", "costUSD"]) {
      totals[key] = (totals[key] || 0) + Number(row[key] || 0);
    }
  }
  return totals;
}

function normalizeTotals(totals) {
  const inputTokens = Number(totals.inputTokens || 0);
  const outputTokens = Number(totals.outputTokens || 0);
  const reasoningOutputTokens = Number(totals.reasoningOutputTokens || 0);
  const cacheCreationTokens = Number(totals.cacheCreationTokens || 0);
  const cacheReadTokens = Number(totals.cacheReadTokens || 0);
  // ccusage/Codex reports reasoning as a subset of outputTokens, not an extra token bucket.
  const totalTokens = Number(totals.totalTokens || inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens);
  const effectiveTokens = inputTokens + cacheCreationTokens + outputTokens;
  const totalCost = Number(totals.totalCost || totals.cost || totals.costUSD || 0);
  return { inputTokens, outputTokens, reasoningOutputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, effectiveTokens, totalCost };
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
        reasoningOutputTokens: data.reasoningOutputTokens,
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
        reasoningOutputTokens: row.reasoningOutputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        totalTokens: row.totalTokens,
        cost: row.totalCost || row.cost || row.costUSD || 0,
      },
    ];
  }
  return [];
}

function enrichUnifiedReasoning(sources) {
  const unified = sources?.all;
  const codex = sources?.codex;
  if (!unified?.totals) return;

  const opencode = sources?.opencode;
  const opencodeData = sources?.opencodeLive?.data || {};
  const opencodeReasoning = Number(opencodeData.totalReasoning || 0);
  const opencodeReasoningByModel = opencodeData.reasoningByModel && typeof opencodeData.reasoningByModel === "object"
    ? opencodeData.reasoningByModel
    : {};
  let opencodeEffectiveDelta = 0;
  if (opencode?.totals && opencodeReasoning > 0) {
    const current = Number(opencode.totals.reasoningOutputTokens || 0);
    const missing = Math.max(0, opencodeReasoning - current);
    opencode.totals.reasoningOutputTokens = current + missing;
    opencode.totals.effectiveTokens = Number(opencode.totals.effectiveTokens || 0) + missing;
    opencodeEffectiveDelta = missing;
    for (const model of opencode.models || []) {
      const target = Number(opencodeReasoningByModel[String(model.modelName || "").toLowerCase()] || 0);
      const modelCurrent = Number(model.reasoningOutputTokens || 0);
      const modelMissing = Math.max(0, target - modelCurrent);
      if (modelMissing <= 0) continue;
      model.reasoningOutputTokens = modelCurrent + modelMissing;
      model.effectiveTokens = Number(model.effectiveTokens || 0) + modelMissing;
    }
  }

  const focusedReasoning = Number(codex?.totals?.reasoningOutputTokens || 0)
    + Number(opencode?.totals?.reasoningOutputTokens || 0);
  const unifiedReasoning = Number(unified.totals.reasoningOutputTokens || 0);
  const missingReasoning = Math.max(0, focusedReasoning - unifiedReasoning);
  if (missingReasoning > 0) {
    unified.totals.reasoningOutputTokens = unifiedReasoning + missingReasoning;
  }
  // Solo OpenCode mantiene reasoning fuera de output; Codex ya lo incluye en outputTokens.
  unified.totals.effectiveTokens = Number(unified.totals.effectiveTokens || 0) + opencodeEffectiveDelta;

  const focusedByName = new Map();
  for (const model of [...(codex?.models || []), ...(opencode?.models || [])]) {
    const key = String(model.modelName || "").toLowerCase();
    const current = focusedByName.get(key) || 0;
    focusedByName.set(key, current + Number(model.reasoningOutputTokens || 0));
  }
  for (const model of unified.models || []) {
    const focusedModelReasoning = Number(focusedByName.get(String(model.modelName || "").toLowerCase()) || 0);
    if (focusedModelReasoning <= 0) continue;
    const unifiedModelReasoning = Number(model.reasoningOutputTokens || 0);
    const missingModelReasoning = Math.max(0, focusedModelReasoning - unifiedModelReasoning);
    if (missingModelReasoning <= 0) continue;
    model.reasoningOutputTokens = unifiedModelReasoning + missingModelReasoning;
    const opencodeModelReasoning = Number(opencodeReasoningByModel[String(model.modelName || "").toLowerCase()] || 0);
    model.effectiveTokens = Number(model.effectiveTokens || 0) + opencodeModelReasoning;
  }
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
      reasoningOutputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      cost: 0,
    };
    current.inputTokens += Number(model.inputTokens || 0);
    current.outputTokens += Number(model.outputTokens || 0);
    current.reasoningOutputTokens += Number(model.reasoningOutputTokens || 0);
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
    version: 2,
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
      liveUsage: true,
      liveUsageCacheSeconds: 60,
      useDetectedRateLimits: true,
      dailyTokens: null,
      probe: false,
      probeCacheMinutes: 15,
    },
    gemini: {
      liveCapture: true,
      liveCaptureCacheMinutes: 15,
      dailyTokens: null,
      dailyRequests: null,
    },
    antigravity: {
      liveCapture: true,
      liveCaptureCacheMinutes: 3,
      usageTimeoutSeconds: 40,
      monthlyCredits: null,
      usedCredits: null,
      resetsAt: null,
    },
    minimax: {
      liveCapture: true,
      liveCaptureCacheMinutes: 0,
      monthlyCredits: null,
      resetsAt: null,
      apiKey: null,
    },
    opencode: {
      liveCapture: true,
      liveCaptureCacheMinutes: 5,
      fiveHourCost: 12,
      weeklyCost: 30,
      monthlyCost: 60,
      apiKey: null,
      cookie: null,
      workspaceId: null,
      serverOverride: {
        enabled: false,
        fiveHourUsed: null,
        weeklyUsed: null,
        monthlyUsed: null,
        reset5h: null,
        resetWeek: null,
        resetMonth: null,
        capturedAt: null,
        note: "Pega aqui los valores reales de opencode.ai/auth (cost en USD y resets ISO). Pon capturedAt (ISO) al pegar para ver la frescura. Cuando enabled=true, reemplaza el estimado local.",
      },
    },
    display: {
      // Visibilidad de la TUI/--json/MCP. hideUnusable auto-oculta proveedores sin cuenta
      // usable (no-auth/no-instalado/no-configurado). hiddenProviders/hiddenModels son la
      // seleccion manual (tecla h en la TUI). Los modelos usan el token "provider:modelKey".
      hideUnusable: true,
      hiddenProviders: [],
      hiddenModels: [],
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
    const merged = deepMerge(defaults, parsed, { configPath: QUOTA_CONFIG_PATH, created: false });
    merged.version = defaults.version;
    return merged;
  } catch {
    return { ...defaults, configPath: QUOTA_CONFIG_PATH, created: false, error: "No pude leer quotas.json" };
  }
}

// Semilla el `displayConfig` global desde el bloque `display` ya fusionado de quotas.json.
function loadDisplayConfig(display) {
  const defaults = { hideUnusable: true, hiddenProviders: [], hiddenModels: [] };
  if (!display || typeof display !== "object") { displayConfig = defaults; return; }
  displayConfig = {
    hideUnusable: display.hideUnusable !== false,
    hiddenProviders: Array.isArray(display.hiddenProviders) ? [...display.hiddenProviders] : [],
    hiddenModels: Array.isArray(display.hiddenModels) ? [...display.hiddenModels] : [],
  };
}

// Persiste SOLO el bloque `display` en quotas.json. Re-lee el archivo crudo para nunca
// pisar credenciales ni otros bloques (ni los campos runtime configPath/created/error).
function saveDisplayConfig() {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    let parsed = {};
    if (existsSync(QUOTA_CONFIG_PATH)) {
      // Si el archivo existe pero no parsea, ABORTAR: reescribir solo `display` borraria
      // credenciales y el resto de la config del usuario. Mejor no guardar la preferencia.
      try { parsed = JSON.parse(readFileSync(QUOTA_CONFIG_PATH, "utf8")) || {}; } catch { return false; }
    }
    parsed.display = {
      hideUnusable: displayConfig.hideUnusable !== false,
      hiddenProviders: [...displayConfig.hiddenProviders],
      hiddenModels: [...displayConfig.hiddenModels],
    };
    writeFileSync(QUOTA_CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
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

// ===========================================================================
// Multi-cuenta por proveedor (v0.13.0)
//
// MODELO: el proveedor sigue siendo la clave primaria de `providers`; las cuentas
// son un nivel ANIDADO (providers[p].accounts[]). `accounts` es OPT-IN: si un
// bloque de quotas.json no lo declara, resolveAccounts() materializa EN MEMORIA
// una unica cuenta implicita "default" que no inyecta ninguna env var y usa las
// rutas de cache historicas -> la salida es identica a la de antes del cambio.
//
// CREDENCIALES: quotas.json guarda REFERENCIAS, nunca valores.
//   {kind:"configDir", path}  -> se inyecta como env var de aislamiento al CLI hijo
//   {kind:"env",       var}   -> se lee process.env[var] solo al construir el header
//   {kind:"legacy"}           -> apunta al campo inline preexistente del bloque
// Nada de esto se serializa al output salvo {kind} y (para configDir) el path.
// ===========================================================================

const DEFAULT_ACCOUNT_ID = "default";
// El id es componente de nombre de archivo de cache: sin sanear seria path traversal.
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ACCOUNT_CREDENTIAL_KINDS = new Set(["legacy", "configDir", "env"]);

// Env var que aisla la raiz de credenciales del CLI hijo de cada proveedor.
// null = el proveedor no lanza un CLI aislable por env (credencial en proceso).
const PROVIDER_ISOLATION_ENV = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CLI_HOME",
  antigravity: null,
  minimax: null,
  opencode: null,
};

// Antigravity NO es aislable: su CLI fija la raiz en ~/.gemini/antigravity-cli y la
// captura es scraping por PTY. Aceptar 2 cuentas leeria la MISMA credencial dos veces
// y reportaria el mismo saldo con etiquetas distintas: datos falsos que parecen buenos.
const PROVIDER_SUPPORTS_MULTI_ACCOUNT = {
  claude: true,
  codex: true,
  gemini: true,
  antigravity: false,
  minimax: true,
  opencode: true,
};

// Proveedores cuya captura viva abre un CLI/PTY completo (30-45 s). Se raciona con
// presupuesto por refresh para que N cuentas no multipliquen la latencia del hook.
const HEAVY_PROBE_PROVIDERS = new Set(["claude", "gemini", "antigravity"]);

// Sufijo historico del archivo de cache de cada proveedor. providerCachePath() los
// reproduce EXACTAMENTE para la cuenta "default", asi que actualizar no invalida
// ningun cache existente ni obliga a migrar archivos.
const PROVIDER_CACHE_SUFFIX = {
  claude: "usage-cache",
  gemini: "quota-cache",
  minimax: "usage-cache",
  opencode: "usage-cache",
  antigravity: "quota-cache",
  codex: "probe-cache",
};

function accountSlug(id) {
  const raw = String(id ?? "");
  if (ACCOUNT_ID_RE.test(raw)) return raw;
  // Defensa en profundidad: la validacion de config ya rechaza ids invalidos, pero un
  // id que llegue por otra via nunca debe convertirse en un componente de ruta.
  return `x${sha256Hex(raw).slice(0, 12)}`;
}

function providerCachePath(provider, accountId, suffix) {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const slug = id === DEFAULT_ACCOUNT_ID ? "" : `-${accountSlug(id)}`;
  return path.join(CONFIG_DIR, `${provider}${slug}-${suffix}.json`);
}

function accountCachePath(account, suffix) {
  const provider = account?.provider || "provider";
  return providerCachePath(provider, account?.id, suffix || PROVIDER_CACHE_SUFFIX[provider] || "cache");
}

// Entorno del proceso hijo para una cuenta. Para la cuenta implicita "default" (o
// cualquier credencial legacy) devuelve `undefined`: execFile recibe exactamente las
// mismas opciones que antes del cambio, sin tocar el entorno.
function accountEnv(account, extra = null) {
  const envVar = PROVIDER_ISOLATION_ENV[account?.provider];
  const isolate = envVar && account?.credential?.kind === "configDir" && account.credential.path;
  if (!isolate && !extra) return undefined;
  const env = { ...process.env, ...(extra || {}) };
  if (isolate) env[envVar] = account.credential.path;
  return env;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function credentialFingerprint(value) {
  if (!value) return null;
  return sha256Hex(value).slice(0, 12);
}

function normalizeAccountCredential(provider, raw) {
  if (!raw || typeof raw !== "object") return { kind: "legacy" };
  const kind = String(raw.kind || "legacy");
  if (!ACCOUNT_CREDENTIAL_KINDS.has(kind)) return null;
  if (kind === "configDir") {
    const dir = typeof raw.path === "string" ? raw.path.trim() : "";
    if (!dir) return null;
    return { kind, path: dir };
  }
  if (kind === "env") {
    const name = typeof raw.var === "string" ? raw.var.trim() : "";
    if (!name) return null;
    return { kind, var: name };
  }
  return { kind: "legacy" };
}

// --- Preflight de credencial: clasifica la salud de una cuenta SIN lanzar un CLI. ---
// Es el mayor ahorro disponible: descarta raices rotas (accessToken vacio o el literal
// "[REDACTED-...]") antes de gastar un proceso de 30-45 s, y se re-evalua gratis.
// "credential-expired" (access+refresh ambos vencidos, ver inspectClaudeAccountRoot) tambien
// bloquea: sin esto, una cuenta con ambos tokens muertos igual gastaba un CLI de 30-45s por
// refresh (y encima fallaba) en vez de fallar gratis via preflight, como las otras 2 causas.
const ACCOUNT_BLOCKING_STATUSES = new Set(["unauthenticated", "credential-broken", "credential-expired"]);
const PLACEHOLDER_TOKEN_RE = /^\s*(\[[^\]]*\]|<[^>]*>|redacted|changeme|todo|null|none)\s*$/i;

function inspectClaudeAccountRoot(dir, { ambient = false } = {}) {
  const credPath = path.join(dir, ".credentials.json");
  if (!existsSync(credPath)) {
    return { status: "unauthenticated", detail: "sin .credentials.json en la raiz declarada" };
  }
  const data = readJsonSafe(credPath);
  const oauth = data?.claudeAiOauth && typeof data.claudeAiOauth === "object" ? data.claudeAiOauth : null;
  if (!oauth) return { status: "credential-broken", detail: ".credentials.json sin bloque claudeAiOauth" };
  const token = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!token) return { status: "credential-broken", detail: "accessToken vacio" };
  if (PLACEHOLDER_TOKEN_RE.test(token)) {
    return { status: "credential-broken", detail: "accessToken es un marcador, no un token real" };
  }
  const identity = readJsonSafe(path.join(dir, ".claude.json"))
    || (ambient ? readJsonSafe(path.join(homedir(), ".claude.json")) : null);
  const oauthAccount = identity?.oauthAccount || {};
  const expiresAt = Number(oauth.expiresAt);
  const refreshExpiresAt = Number(oauth.refreshTokenExpiresAt);
  const hasRefresh = Boolean(oauth.refreshToken);
  let status = "ok";
  let detail = "";
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    const refreshDead = !hasRefresh
      || (Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0 && refreshExpiresAt <= Date.now());
    // Con refreshToken vivo el CLI renueva solo: no es un fallo, no bloquea el probe.
    status = refreshDead ? "credential-expired" : "ok";
    detail = refreshDead ? "accessToken y refreshToken vencidos" : "accessToken vencido; el CLI lo renovara";
  }
  return {
    status,
    detail,
    plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    // Fingerprint irreversible del accountUuid: sirve para detectar dos raices que
    // apuntan a la MISMA suscripcion (dedupe) sin exponer el uuid ni el email.
    identityFingerprint: oauthAccount.accountUuid ? credentialFingerprint(oauthAccount.accountUuid) : null,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
  };
}

function inspectCodexAccountRoot(dir) {
  const authPath = path.join(dir, "auth.json");
  if (!existsSync(authPath)) return { status: "unauthenticated", detail: "sin auth.json en la raiz declarada" };
  const data = readJsonSafe(authPath);
  if (!data) return { status: "credential-broken", detail: "auth.json no parsea" };
  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
  const apiKey = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY.trim() : "";
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!apiKey && !accessToken && !refreshToken) {
    return { status: "credential-broken", detail: "auth.json sin tokens ni OPENAI_API_KEY" };
  }
  if (accessToken && PLACEHOLDER_TOKEN_RE.test(accessToken)) {
    return { status: "credential-broken", detail: "access_token es un marcador, no un token real" };
  }
  const accountId = tokens.account_id || tokens.accountId || null;
  return {
    status: "ok",
    detail: "",
    authMode: data.auth_mode || (apiKey && !accessToken ? "apikey" : "oauth"),
    identityFingerprint: accountId ? credentialFingerprint(accountId) : null,
  };
}

function inspectGeminiAccountRoot(dir) {
  const candidates = ["oauth_creds.json", "google_accounts.json", "settings.json"];
  const found = candidates.find((name) => existsSync(path.join(dir, name)));
  if (!found) return { status: "unauthenticated", detail: "sin credenciales de gemini-cli en la raiz declarada" };
  return { status: "ok", detail: "" };
}

function inspectAccountCredential(provider, credential, { implicit = false } = {}) {
  const kind = credential?.kind || "legacy";
  if (kind === "env") {
    const name = credential.var;
    const value = process.env[name];
    if (value === undefined || String(value).trim() === "") {
      return { status: "unauthenticated", detail: `${name} sin valor en el entorno`, credentialRef: name };
    }
    return {
      status: "ok",
      detail: `${name} presente`,
      credentialRef: name,
      identityFingerprint: credentialFingerprint(value),
    };
  }
  if (kind === "configDir") {
    const dir = credential.path;
    if (!existsSync(dir)) {
      return { status: "unauthenticated", detail: "el directorio de credenciales no existe", credentialRef: dir };
    }
    let inspected;
    if (provider === "claude") inspected = inspectClaudeAccountRoot(dir, { ambient: implicit });
    else if (provider === "codex") inspected = inspectCodexAccountRoot(dir);
    else if (provider === "gemini") inspected = inspectGeminiAccountRoot(dir);
    else inspected = { status: "unknown", detail: "" };
    return { ...inspected, credentialRef: dir };
  }
  // legacy: comportamiento historico. Nunca bloquea el probe (status "unknown"), pero
  // reporta identidad best-effort para que el TUI/agente vea de que cuenta se trata.
  if (provider === "claude") {
    const ambientDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    const probe = existsSync(ambientDir)
      ? inspectClaudeAccountRoot(ambientDir, { ambient: true })
      : { status: "unknown", detail: "" };
    return { ...probe, status: "unknown", observedStatus: probe.status, credentialRef: "ambiente" };
  }
  if (provider === "codex") {
    const ambientDir = process.env.CODEX_HOME || path.join(homedir(), ".codex");
    const probe = existsSync(ambientDir) ? inspectCodexAccountRoot(ambientDir) : { status: "unknown", detail: "" };
    return { ...probe, status: "unknown", observedStatus: probe.status, credentialRef: "ambiente" };
  }
  return { status: "unknown", detail: "", credentialRef: "ambiente" };
}

// Umbrales de alerta con herencia cuenta > proveedor > raiz. Por defecto TODOS son
// null (alertas apagadas) para que la salida en modo legacy siga siendo identica.
function resolveAlertThresholds(...layers) {
  const out = {
    warnBelowPercent: null,
    criticalBelowPercent: null,
    notifyOnLimited: false,
    notifyOnBrokenCredential: true,
  };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const key of Object.keys(out)) {
      if (layer[key] === undefined || layer[key] === null) continue;
      out[key] = typeof out[key] === "boolean" ? Boolean(layer[key]) : Number(layer[key]);
    }
  }
  return out;
}

function implicitAccount(provider, providerConfig, rootConfig) {
  const credential = { kind: "legacy" };
  const health = inspectAccountCredential(provider, credential, { implicit: true });
  return {
    provider,
    id: DEFAULT_ACCOUNT_ID,
    label: PROVIDER_META[provider]?.label || provider,
    enabled: true,
    priority: 0,
    implicit: true,
    credential,
    config: { ...(providerConfig || {}) },
    alerts: resolveAlertThresholds(rootConfig?.alerts, providerConfig?.alerts),
    health,
  };
}

/**
 * Resuelve la lista de cuentas de un proveedor.
 * Fail-safe: cualquier error de configuracion cae a MODO LEGACY (una cuenta implicita)
 * y se reporta en configErrors[]; nunca se adivina ni se falla en silencio.
 */
function resolveAccounts(provider, providerConfig = {}, rootConfig = {}) {
  const configErrors = [];
  const raw = Array.isArray(providerConfig?.accounts) ? providerConfig.accounts : [];
  const legacyMode = (error) => {
    if (error) configErrors.push(error);
    return { accounts: [implicitAccount(provider, providerConfig, rootConfig)], multi: false, configErrors };
  };
  if (!raw.length) return legacyMode(null);
  if (PROVIDER_SUPPORTS_MULTI_ACCOUNT[provider] === false && raw.length > 1) {
    return legacyMode(
      `${provider} no soporta multiples cuentas: su CLI fija la raiz de credenciales en el HOME. Usando modo legacy.`,
    );
  }

  // `accounts` no hereda por deepMerge (los arrays se sobrescriben enteros): la herencia
  // de los defaults del bloque del proveedor se hace explicitamente aqui.
  const inherited = { ...(providerConfig || {}) };
  delete inherited.accounts;
  delete inherited.alerts;

  const accounts = [];
  const seenIds = new Set();
  let legacyClaims = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object") {
      return legacyMode(`${provider}.accounts[${index}] no es un objeto.`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!ACCOUNT_ID_RE.test(id) || id === "." || id === "..") {
      return legacyMode(
        `${provider}.accounts[${index}].id invalido (se exige ^[a-z0-9][a-z0-9._-]{0,31}$, sin separadores de ruta).`,
      );
    }
    if (seenIds.has(id)) return legacyMode(`${provider}.accounts: el id "${id}" esta duplicado.`);
    seenIds.add(id);
    const credential = normalizeAccountCredential(provider, entry.credential);
    if (!credential) return legacyMode(`${provider}.accounts[${index}].credential invalida o incompleta.`);
    if (credential.kind === "configDir" && !PROVIDER_ISOLATION_ENV[provider]) {
      return legacyMode(
        `${provider} no admite credential.kind="configDir": no expone una env var que aisle su raiz.`,
      );
    }
    if (credential.kind === "legacy") legacyClaims += 1;
    const overrides = { ...entry };
    for (const key of ["id", "label", "enabled", "priority", "credential", "alerts"]) delete overrides[key];
    const config = { ...inherited, ...overrides };
    const health = inspectAccountCredential(provider, credential, { implicit: false });
    accounts.push({
      provider,
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      enabled: entry.enabled !== false,
      priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 0,
      implicit: false,
      credential,
      config,
      alerts: resolveAlertThresholds(rootConfig?.alerts, providerConfig?.alerts, entry.alerts),
      health,
    });
  }
  if (legacyClaims > 1) {
    return legacyMode(
      `${provider}.accounts: dos cuentas reclaman credential.kind="legacy" y no se puede adivinar cual usa el campo inline.`,
    );
  }

  // DEDUPE: dos raices que resuelven a la MISMA suscripcion son UNA cuenta. Agregarlas
  // como rutas alternativas duplicaria la capacidad aparente (el fallo mas caro posible
  // porque es silencioso y en la direccion peligrosa).
  const byFingerprint = new Map();
  for (const account of accounts) {
    const fingerprint = account.health?.identityFingerprint;
    if (!fingerprint) continue;
    if (byFingerprint.has(fingerprint)) {
      account.duplicateOf = byFingerprint.get(fingerprint);
      configErrors.push(
        `${provider}.accounts: "${account.id}" apunta a la misma suscripcion que "${account.duplicateOf}"; se ignora para el agregado.`,
      );
    } else {
      byFingerprint.set(fingerprint, account.id);
    }
  }

  for (const account of accounts) {
    const status = account.health?.status;
    account.blocked = Boolean(account.duplicateOf)
      || account.enabled === false
      || ACCOUNT_BLOCKING_STATUSES.has(status);
  }
  return { accounts, multi: accounts.length > 1, configErrors };
}

function resolveAllAccounts(config) {
  const out = {};
  for (const provider of ACCOUNT_PROVIDER_ORDER) {
    out[provider] = resolveAccounts(provider, config?.[provider] || {}, config || {});
  }
  return out;
}

// --- Agregacion entre cuentas -------------------------------------------------
// Generaliza groupedQuotaAvailability() un nivel arriba: ventana -> grupo (MIN, AND)
// -> cuenta (MAX entre grupos, ya existia) -> proveedor (MAX entre cuentas, nuevo).
// Reutiliza availableGroups/limitingGroups porque es el MISMO concepto (rutas
// alternativas abiertas/cerradas) y esos campos ya existen en el schema de salida.
function aggregateAccountQuotas(entries) {
  const availableGroups = [];
  const limitingGroups = [];
  const remains = [];
  let considered = 0;
  for (const entry of entries || []) {
    const quota = entry?.quota;
    // Una cuenta ROTA no es una cuenta AGOTADA: no debe arrastrar al proveedor a
    // `limited`, o el hook publicaria "Claude AGOTADO" con las buenas intactas.
    if (!quota || quota.ok === false || entry.blocked) continue;
    considered += 1;
    const remaining = finiteNumberOrNull(quota.effectiveRemainingPercent);
    const isAvailable = quota.available === true
      || (quota.limited !== true && remaining !== null && remaining > 0);
    if (isAvailable) availableGroups.push(entry.accountId);
    else if (quota.limited === true || (remaining !== null && remaining <= 0)) limitingGroups.push(entry.accountId);
    if (remaining !== null) remains.push(remaining);
  }
  return {
    available: availableGroups.length > 0,
    limited: considered > 0 && availableGroups.length === 0 && limitingGroups.length > 0,
    availableGroups,
    limitingGroups,
    // MAX y no suma: remainingPercent es un porcentaje POR CUENTA y sumar porcentajes
    // entre cuentas es dimensionalmente invalido. MAX = "la mejor ruta unica abierta",
    // que es justo la decision que toma el consumidor (un agente despacha a UNA cuenta).
    effectiveRemainingPercent: remains.length ? Math.max(...remains) : null,
  };
}

// Determinista para que el output sea estable entre refrescos:
// 1o mayor effectiveRemainingPercent, 2o menor priority, 3o orden de declaracion.
function selectAccountEntry(entries) {
  const list = (entries || []).filter((entry) => entry && entry.quota);
  if (!list.length) return null;
  const usable = list.filter((entry) => !entry.blocked && entry.quota.ok !== false);
  const pool = usable.length ? usable : list;
  let best = pool[0];
  for (const entry of pool.slice(1)) {
    const candidate = finiteNumberOrNull(entry.quota.effectiveRemainingPercent);
    const incumbent = finiteNumberOrNull(best.quota.effectiveRemainingPercent);
    const candidateValue = candidate === null ? -1 : candidate;
    const incumbentValue = incumbent === null ? -1 : incumbent;
    if (candidateValue > incumbentValue) { best = entry; continue; }
    if (candidateValue < incumbentValue) continue;
    if (Number(entry.priority ?? 0) < Number(best.priority ?? 0)) best = entry;
  }
  return best;
}

/**
 * Pliega N quotas por cuenta en el quota del proveedor.
 * Con UNA sola cuenta devuelve el quota tal cual (identidad): ese es el mecanismo que
 * garantiza que el modo legacy no cambie ni un byte.
 */
function foldProviderAccounts(entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0].quota;

  const selected = selectAccountEntry(list) || list[0];
  const base = selected.quota || {};
  const aggregate = aggregateAccountQuotas(list);
  // CRITICO: `windows` es la proyeccion de la cuenta SELECCIONADA, jamas la union.
  // ai-usage-context.py hace min(remainingPercent) sobre providers[p].windows; con la
  // union, una cuenta agotada publicaria "Claude 0%libre" teniendo otra al 80% libre.
  const windows = (Array.isArray(base.windows) ? base.windows : [])
    .map((window) => ({ ...window, accountId: selected.accountId }));
  const folded = {
    ...base,
    windows,
    available: aggregate.available,
    limited: aggregate.limited,
    availableGroups: aggregate.availableGroups,
    limitingGroups: aggregate.limitingGroups,
    effectiveRemainingPercent: aggregate.effectiveRemainingPercent,
    selectedAccountId: selected.accountId,
    accountCount: list.length,
    accounts: list,
  };
  folded.ok = list.some((entry) => entry.quota?.ok !== false);
  if (!aggregate.limited) delete folded.limitedRetry;
  if (list.every((entry) => entry.quota?.needsAuth === true || entry.blocked)) folded.needsAuth = true;
  else delete folded.needsAuth;
  if (!aggregate.limited && Array.isArray(folded.limitingWindows) && !folded.limitingWindows.length) {
    delete folded.limitingWindows;
  }
  return folded;
}

function conjunctiveQuotaAvailability(windows) {
  const numeric = (windows || []).filter((window) => finiteNumberOrNull(window.remainingPercent) !== null);
  const limitingWindows = numeric
    .filter((window) => Number(window.remainingPercent) <= 0)
    .map((window) => String(window.label || window.key || "limite"));
  return {
    available: numeric.length > 0 && limitingWindows.length === 0,
    limited: limitingWindows.length > 0,
    limitingWindows,
    effectiveRemainingPercent: numeric.length
      ? Math.min(...numeric.map((window) => Number(window.remainingPercent)))
      : null,
  };
}

function groupedQuotaAvailability(windows, groupField) {
  const groups = new Map();
  for (const window of windows || []) {
    const group = String(window[groupField] || window.model || window.family || "default");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(window);
  }
  const availableGroups = [];
  const limitingGroups = [];
  const groupRemaining = [];
  for (const [group, entries] of groups) {
    const numeric = entries.filter((entry) => finiteNumberOrNull(entry.remainingPercent) !== null);
    const explicitAvailable = entries.some((entry) => entry.available === true);
    const minimum = numeric.length
      ? Math.min(...numeric.map((entry) => Number(entry.remainingPercent)))
      : null;
    if (explicitAvailable || (minimum !== null && minimum > 0)) availableGroups.push(group);
    else if (minimum !== null && minimum <= 0) limitingGroups.push(group);
    if (minimum !== null) groupRemaining.push(minimum);
  }
  return {
    available: availableGroups.length > 0,
    limited: groups.size > 0 && availableGroups.length === 0 && limitingGroups.length > 0,
    availableGroups,
    limitingGroups,
    effectiveRemainingPercent: groupRemaining.length ? Math.max(...groupRemaining) : null,
  };
}

// ---------------------------------------------------------------------------
// Visibilidad de proveedores/modelos (v0.12.0)
//
// Regla: un proveedor se auto-oculta SOLO si no tiene datos usables (ni ventanas,
// ni escalares, ni bloque activo) Y su razon es "sin cuenta" (no autenticado / no
// instalado / no configurado). Un proveedor AGOTADO (autenticado, al limite) o con
// un error transitorio permanece visible. `disabled` (live-probe apagado) tampoco
// se auto-oculta: no es "sin cuenta" y ocultarlo seria un footgun (p.ej. Claude).
// El filtro se aplica de forma uniforme a la TUI, --json y el MCP; `AI_USAGE_SHOW_ALL=1`
// lo desactiva para agentes que quieran el set completo.
// ---------------------------------------------------------------------------

const AUTO_HIDE_REASONS = new Set(["unauthenticated", "not-installed", "not-configured"]);

function quotaHasData(quota) {
  if (!quota) return false;
  const windows = Array.isArray(quota.windows) ? quota.windows : [];
  if (windows.length > 0) return true;
  if (finiteNumberOrNull(quota.remainingPercent) !== null) return true;
  if (finiteNumberOrNull(quota.usedPercent) !== null) return true;
  if (Array.isArray(quota.creditsList) && quota.creditsList.length > 0) return true;
  if (quota.activeBlock) return true;
  return false;
}

function classifyProviderAvailability(quota) {
  if (!quota) return "no-data";
  if (quota.needsAuth) return "unauthenticated";
  if (quota.limited) return "exhausted"; // autenticado pero al limite -> visible
  if (quotaHasData(quota)) {
    const windows = Array.isArray(quota.windows) ? quota.windows : [];
    const numeric = windows
      .map((w) => finiteNumberOrNull(w.remainingPercent))
      .filter((v) => v !== null);
    const scalar = finiteNumberOrNull(quota.remainingPercent);
    const allWindowsExhausted = numeric.length > 0 && numeric.every((v) => v <= 0);
    if (quota.available === false || allWindowsExhausted || (numeric.length === 0 && scalar !== null && scalar <= 0)) {
      return "exhausted";
    }
    return "available";
  }
  if (quota.unusable && typeof quota.reason === "string" && quota.reason) return quota.reason;
  if (quota.disabled) return "disabled";
  return "no-data";
}

function isProviderVisible(provider, quota, display = {}, revealHidden = false) {
  if (revealHidden) return true;
  const hiddenProviders = Array.isArray(display.hiddenProviders) ? display.hiddenProviders : [];
  if (hiddenProviders.includes(provider)) return false;
  if (display.hideUnusable !== false && AUTO_HIDE_REASONS.has(classifyProviderAvailability(quota))) return false;
  return true;
}

function windowModelKey(provider, window) {
  if (!window) return null;
  // `key` es el identificador UNICO por ventana (MiniMax "weekly_general", Antigravity
  // "Gemini-sem", Claude "week_opus"): usarlo primero evita que ocultar una fila arrastre a
  // su hermana (misma familia/modelo, distinta ventana) y que se le quite al agente la
  // ventana semanal por ocultar la diaria. Fallback: modelo/familia (+ tipo de ventana).
  let raw = window.key;
  if (!raw) {
    const base = window.model || window.family || window.label;
    if (!base) return null;
    const disc = window.windowType || (window.windowMinutes != null ? `${window.windowMinutes}m` : "");
    raw = disc ? `${base}-${disc}` : base;
  }
  const norm = String(raw).toLowerCase().trim().replace(/\s+/g, "-");
  return norm ? `${provider}:${norm}` : null;
}

function isModelVisible(provider, window, display = {}, revealHidden = false) {
  if (revealHidden) return true;
  const hiddenModels = Array.isArray(display.hiddenModels) ? display.hiddenModels : [];
  if (!hiddenModels.length) return true;
  const key = windowModelKey(provider, window);
  return !(key && hiddenModels.includes(key));
}

// Propaga la razon de "cuenta no usable" desde el resultado de captura (collect) al
// quota final, SOLO cuando el quota no tiene datos utiles. Asi un agotado (con barras)
// o un error transitorio nunca se marca no-usable por accidente.
function annotateUnusable(quota, source) {
  if (!quota || quotaHasData(quota)) return quota;
  // Un limite configurado a mano por el usuario (kind "configured-*") es intencionalmente
  // usable aunque el CLI en vivo falte: no lo marques no-usable ni lo auto-ocultes.
  if (typeof quota.kind === "string" && quota.kind.startsWith("configured-")) return quota;
  if (source?.needsAuth && !quota.needsAuth) quota.needsAuth = true;
  if (source?.unusable && typeof source.reason === "string" && !quota.unusable) {
    quota.unusable = true;
    quota.reason = source.reason;
  }
  return quota;
}

/**
 * Construye el quota final de UN proveedor plegando todas sus cuentas resueltas.
 * `liveAccounts` es la lista que produce collectProviderAccountsLive() (forma
 * {accountId, account, label, priority, blocked, health, live}); `fallbackLive` es
 * el `sources.<p>Live`/`sources.<p>` historico, usado SOLO si la lista viene vacia
 * (defensivo: un allSettled rechazado hoy deja `sources.<p>LiveAccounts = []`).
 * `buildOne(entry)` arma el quota normalizado de esa cuenta con la MISMA firma que
 * cada build<X>Quota ya usaba; con una sola cuenta (modo legacy, el 100% del parque
 * hoy) foldProviderAccounts devuelve ese objeto SIN copiarlo, asi que el resto del
 * pipeline (annotateUnusable, etc.) actua identico byte a byte al comportamiento previo.
 */
function foldedProviderQuota(liveAccounts, fallbackLive, buildOne) {
  const source = Array.isArray(liveAccounts) && liveAccounts.length
    ? liveAccounts
    : [{ accountId: DEFAULT_ACCOUNT_ID, priority: 0, blocked: false, account: null, live: fallbackLive }];
  const entries = source.map((entry) => ({
    accountId: entry.accountId,
    label: entry.label || entry.account?.label || entry.accountId,
    priority: entry.priority,
    blocked: Boolean(entry.blocked),
    healthStatus: entry.health?.status || entry.account?.health?.status || null,
    quota: buildOne(entry),
  }));
  return foldProviderAccounts(entries);
}

function buildQuotaState(sources, config, accounts = {}) {
  // Cada builder recibe el config MERGEADO de SU cuenta (entry.account.config, que
  // resolveAccounts ya arma como {...configDelProveedor, ...overridesDeLaCuenta}) en vez
  // del config global del proveedor; para la cuenta implicita/legacy ambos son el MISMO
  // contenido, asi que esto no cambia nada hoy y respeta overrides por cuenta el dia que
  // alguien declare accounts[] con, p.ej., fiveHourTokens distintos por cuenta.
  const quotas = {
    configPath: config.configPath,
    codex: foldedProviderQuota(sources.codexLiveAccounts, sources.codexLive, (entry) =>
      buildCodexQuota(sources.codex, entry.account?.config || config.codex, entry.live)),
    claude: foldedProviderQuota(sources.claudeLiveAccounts, sources.claudeLive, (entry) =>
      buildClaudeQuota(sources.claude, sources.claudeBlocks, entry.account?.config || config.claude, entry.live)),
    gemini: foldedProviderQuota(sources.geminiLiveAccounts, sources.geminiLive, (entry) =>
      buildGeminiQuota(sources.gemini, entry.account?.config || config.gemini, entry.live)),
    // MiniMax no tiene un `usage` separado de la captura en vivo: `entry.live` ES el
    // argumento `usage` que buildMiniMaxQuota siempre tomo (ver sources.minimax de antes).
    minimax: foldedProviderQuota(sources.minimaxAccounts, sources.minimax, (entry) =>
      buildMiniMaxQuota(entry.live, entry.account?.config || config.minimax)),
    // opencodeServer (el override manual pegado por el usuario) sigue GLOBAL, no por
    // cuenta: es una decision explicita, ver docs/multi-account (no hay señal de que
    // deba variar por cuenta y opencodeServer no se captura por cuenta hoy).
    opencode: foldedProviderQuota(sources.opencodeAccounts, sources.opencodeLive, (entry) =>
      buildOpenCodeQuota(entry.live, entry.account?.config || config.opencode, sources.opencodeServer)),
    antigravity: foldedProviderQuota(sources.antigravityLiveAccounts, sources.antigravityLive, (entry) =>
      buildAntigravityQuota(sources.antigravity, entry.account?.config || config.antigravity, entry.live)),
  };
  // Propaga la razon de no-usable desde cada captura en vivo al quota final.
  annotateUnusable(quotas.claude, sources.claudeLive);
  annotateUnusable(quotas.codex, sources.codexLive);
  annotateUnusable(quotas.gemini, sources.geminiLive);
  annotateUnusable(quotas.antigravity, sources.antigravityLive);
  annotateUnusable(quotas.minimax, sources.minimax);
  annotateUnusable(quotas.opencode, sources.opencodeLive);
  // Errores de configuracion (id duplicado, credential invalida, proveedor sin soporte
  // multi-cuenta, etc.) ya se calculan en resolveAccounts() pero hasta ahora se tiraban:
  // se adjuntan al quota SOLO si hay alguno, para no tocar el output en el caso comun.
  for (const provider of ["codex", "claude", "gemini", "minimax", "opencode", "antigravity"]) {
    const errors = accounts?.[provider]?.configErrors;
    if (Array.isArray(errors) && errors.length && quotas[provider]) {
      quotas[provider].configErrors = errors;
    }
  }
  return quotas;
}

function fmtTimeInTz(date, tz) {
  if (!date || !tz) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(date);
  } catch {
    return null;
  }
}

function parseCodexRetryTime(text) {
  // Codex dice "try again at 5:43 AM" SIN zona ni fecha desde el contenedor, cuya referencia es
  // UTC. Construimos el instante explicitamente en UTC: usar setHours() lo reinterpretaba en la
  // TZ de quien lanzara el test/TUI y desplazaba el retry al ejecutarlo desde la torre Bogota.
  const m = String(text || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && hour < 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  const now = new Date();
  const d = new Date(now);
  d.setUTCHours(hour, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function valueFromAny(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) return obj[key];
  }
  return null;
}

function normalizeCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedRaw = valueFromAny(window, ["used_percent", "usedPercent"]);
  if (usedRaw === null) return null;
  const usedPercent = Number(usedRaw);
  const windowMinutes = Number(valueFromAny(window, ["window_minutes", "windowDurationMins"]));
  const resetsAt = Number(valueFromAny(window, ["resets_at", "resetsAt"]));
  if (!Number.isFinite(usedPercent)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, usedPercent)),
    window_minutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : null,
    resets_at: Number.isFinite(resetsAt) && resetsAt > 0
      ? (resetsAt > 1e12 ? Math.round(resetsAt / 1000) : resetsAt)
      : null,
  };
}

function normalizeCodexIndividualLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  const remainingRaw = valueFromAny(limit, ["remaining_percent", "remainingPercent"]);
  const remainingPercent = Number(remainingRaw);
  if (remainingRaw === null || !Number.isFinite(remainingPercent)) return null;
  const resetsAt = Number(valueFromAny(limit, ["resets_at", "resetsAt"]));
  return {
    remaining_percent: Math.max(0, Math.min(100, remainingPercent)),
    resets_at: Number.isFinite(resetsAt) && resetsAt > 0
      ? (resetsAt > 1e12 ? Math.round(resetsAt / 1000) : resetsAt)
      : null,
    limit: limit.limit ?? null,
    used: limit.used ?? null,
  };
}

function normalizeCodexRateLimitEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const creditsRaw = entry.credits;
  const credits = creditsRaw && typeof creditsRaw === "object"
    ? {
        has_credits: Boolean(valueFromAny(creditsRaw, ["has_credits", "hasCredits"])),
        unlimited: Boolean(creditsRaw.unlimited),
        balance: creditsRaw.balance ?? null,
      }
    : null;
  return {
    limit_id: String(valueFromAny(entry, ["limit_id", "limitId"]) || "codex"),
    limit_name: valueFromAny(entry, ["limit_name", "limitName"]),
    primary: normalizeCodexWindow(entry.primary),
    secondary: normalizeCodexWindow(entry.secondary),
    credits,
    individual_limit: normalizeCodexIndividualLimit(valueFromAny(entry, ["individual_limit", "individualLimit"])),
    plan_type: valueFromAny(entry, ["plan_type", "planType"]),
    rate_limit_reached_type: valueFromAny(entry, ["rate_limit_reached_type", "rateLimitReachedType"]),
    detectedAt: entry.detectedAt || entry.detected_at || null,
    file: entry.file || null,
  };
}

function codexWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "semana";
  if (minutes % 10080 === 0) return `${minutes / 10080} sem`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function normalizeResetCredits(value) {
  if (!value || typeof value !== "object") return null;
  const availableCount = Number(valueFromAny(value, ["available_count", "availableCount"]));
  const credits = Array.isArray(value.credits) ? value.credits.map((credit) => ({
    status: credit.status || "",
    resetType: valueFromAny(credit, ["reset_type", "resetType"]) || "",
    expiresAt: valueFromAny(credit, ["expires_at", "expiresAt"]) || null,
  })) : [];
  if (!Number.isFinite(availableCount) && !credits.length) return null;
  return { availableCount: Number.isFinite(availableCount) ? availableCount : credits.length, credits };
}

function buildCodexQuota(usage, config = {}, live = null) {
  const manual = buildTokenQuota("codex", usage, config.dailyTokens, "dia");
  // Codex >=0.144 expone una lectura gratuita por app-server. El helper la normaliza al formato
  // historico snake_case; las sesiones locales quedan como fallback para versiones anteriores.
  const liveRateLimits = live?.rate_limits || live?.rateLimits || null;
  const fromLive = Boolean(live?.ok && liveRateLimits);
  const explicitlyLimited = Boolean(live?.ok && live.limited);
  const detected = fromLive
    ? liveRateLimits
    : explicitlyLimited
      ? null
      : (config.useDetectedRateLimits !== false ? collectCodexRateLimits() : null);
  if (!detected) {
    if (explicitlyLimited) {
      // Codex da la hora de reintento como texto en la TZ del host (UTC). La convertimos a un
      // instante absoluto para countdown (a prueba de zona) y, si hay tz configurada, a tu hora.
      const retryDate = parseCodexRetryTime(live.retryText);
      const tz = config.timezone || process.env.AI_USAGE_TZ || "";
      const retryLocal = fmtTimeInTz(retryDate, tz);
      const cd = retryDate ? fmtCountdown(retryDate) : "";
      const retryShown = retryLocal || live.retryText || "mas tarde";
      const hostNote = !retryLocal && live.retryText ? " (hora host/UTC)" : "";
      return {
        source: "codex", kind: "detected-percent", ok: true, windows: [], creditsList: [], manual,
        limited: true, limitedRetry: retryShown, limitedRetryRaw: live.retryText || "",
        resetAt: retryDate ? retryDate.toISOString() : null, stale: false,
        note: `LIMITE ALCANZADO — reintentar ${retryShown}${hostNote}${cd ? ` (en ~${cd})` : ""}`,
      };
    }
    return manual;
  }

  const entries = (Array.isArray(detected) ? detected : [detected])
    .map(normalizeCodexRateLimitEntry)
    .filter(Boolean);
  const reportedLimited = explicitlyLimited || entries.some((entry) => Boolean(entry.rate_limit_reached_type));
  const windows = [];
  const creditsList = [];
  const resetCredits = normalizeResetCredits(live?.rate_limit_reset_credits || live?.rateLimitResetCredits);

  for (const entry of entries) {
    const limitId = entry.limit_id || "codex";
    const planType = entry.plan_type || limitId;

    for (const [name, defaultLabel] of [
      ["primary", "5h"],
      ["secondary", "semana"],
    ]) {
      const item = entry[name];
      if (!item || typeof item.used_percent !== "number") continue;
      const windowLabel = codexWindowLabel(item.window_minutes, defaultLabel);
      const label = limitId === "premium" ? `mini-${windowLabel}` : windowLabel;
      windows.push({
        key: `${limitId}_${name}_${item.window_minutes || windowLabel}`,
        label,
        limitId,
        sourceWindow: name,
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
    const individual = entry.individual_limit;
    if (individual) {
      windows.push({
        key: `${limitId}_individual_limit`,
        label: entry.limit_name || "limite mensual",
        limitId,
        sourceWindow: "individual",
        windowType: "monthly-spend",
        usedPercent: Math.max(0, 100 - individual.remaining_percent),
        remainingPercent: individual.remaining_percent,
        reset: individual.resets_at ? new Date(individual.resets_at * 1000) : null,
        limitText: individual.limit == null ? "" : String(individual.limit),
        usedText: individual.used == null ? "" : String(individual.used),
      });
    }
  }
  const codexAvailability = groupedQuotaAvailability(windows, "limitId");
  let reachedGroups = entries
    .filter((entry) => Boolean(entry.rate_limit_reached_type))
    .map((entry) => entry.limit_id);
  if (explicitlyLimited && !reachedGroups.length) {
    reachedGroups = entries.map((entry) => entry.limit_id);
  }
  reachedGroups = [...new Set(reachedGroups)];
  if (reachedGroups.length) {
    for (const window of windows) {
      if (reachedGroups.includes(window.limitId)) window.status = "rate-limited";
    }
    codexAvailability.availableGroups = codexAvailability.availableGroups.filter((group) => !reachedGroups.includes(group));
    codexAvailability.limitingGroups = [...new Set([...codexAvailability.limitingGroups, ...reachedGroups])];
    codexAvailability.available = codexAvailability.availableGroups.length > 0;
    codexAvailability.limited = !codexAvailability.available;
    if (!codexAvailability.available) codexAvailability.effectiveRemainingPercent = 0;
  }
  const hasUsableCredits = creditsList.some((credit) => credit.unlimited || credit.has_credits);
  if (hasUsableCredits && !codexAvailability.available && !reachedGroups.length) {
    codexAvailability.available = true;
    codexAvailability.limited = false;
  }
  const limited = codexAvailability.limited || (reportedLimited && !codexAvailability.available);

  // La lectura app-server trae capturedAt. Solo el fallback de sesiones puede quedar viejo si
  // Codex no se ha usado recientemente o si una ventana ya se reinicio.
  const detectedTimes = entries.map((e) => Date.parse(e.detectedAt || "")).filter(Number.isFinite);
  const liveCapturedMs = Date.parse(live?.capturedAt || "");
  const freshestMs = fromLive
    ? (Number.isFinite(liveCapturedMs) ? liveCapturedMs : Date.now())
    : (detectedTimes.length ? Math.max(...detectedTimes) : NaN);
  const ageMin = Number.isFinite(freshestMs) ? Math.max(0, Math.round((Date.now() - freshestMs) / 60000)) : null;
  for (const w of windows) {
    if ((!fromLive || live?.cacheStale) && w.reset instanceof Date && w.reset.getTime() < Date.now()) w.stale = true;
  }
  const codexStale = fromLive
    ? Boolean(live?.cacheStale)
    : ((ageMin != null && ageMin >= 20) || windows.some((w) => w.stale));
  const ageStr = ageMin == null ? "" : ageMin >= 120 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
  const ageTag = !fromLive && ageMin != null && ageMin >= 20 ? `  [dato de hace ${ageStr}; usa codex para refrescar]` : "";
  const limitTag = limited ? `LIMITE ALCANZADO (reintentar ${live.retryText || "mas tarde"}).  ` : "";
  const codexDetectedAt = Number.isFinite(freshestMs) ? new Date(freshestMs).toISOString() : null;

  if (!windows.length && creditsList.length) {
    return {
      source: "codex",
      dataSource: fromLive ? (live.source || "codex-app-server") : "codex-sessions",
      kind: "detected-credits",
      ok: true,
      ...codexAvailability,
      plan: entries[0]?.plan_type || entries[0]?.limit_id || "",
      creditsList,
      manual,
      resetCredits,
      detectedAt: codexDetectedAt,
      observedAt: codexDetectedAt,
      stale: codexStale,
      limited,
      limitedRetry: limited ? live.retryText : undefined,
      note: limitTag + creditsList.map((c) => {
        const name = c.limitId === "premium" ? "mini" : c.limitId;
        return c.unlimited ? `${name}: ilimitado` : c.has_credits ? `${name}: balance ${c.balance}` : `${name}: sin creditos`;
      }).join(" | ") + (resetCredits?.availableCount ? ` | reinicios disponibles: ${resetCredits.availableCount}` : "") + ageTag,
    };
  }

  return {
    source: "codex",
    dataSource: fromLive ? (live.source || "codex-app-server") : "codex-sessions",
    kind: "detected-percent",
    ok: true,
    ...codexAvailability,
    plan: entries[0]?.plan_type || "",
    windows,
    creditsList,
    resetCredits,
    manual,
    detectedAt: codexDetectedAt,
    observedAt: codexDetectedAt,
    stale: codexStale,
    limited,
    limitedRetry: limited ? live.retryText : undefined,
    note: limitTag
      + (fromLive ? "Codex app-server (consulta oficial)." : windows.length ? "Rate limit detectado desde sesiones Codex." : "Codex sin rate_limits recientes.")
      + (resetCredits?.availableCount ? ` Reinicios disponibles: ${resetCredits.availableCount}.` : "")
      + ageTag,
  };
}

function tzOffsetMs(utcMs, tz) {
  // Cuanto ADELANTA `tz` respecto a UTC en ese instante (ms). America/Bogota -> -5h.
  // Devuelve null si la zona es invalida para Intl (p.ej. abreviaturas como "PST").
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return Number.isNaN(asUTC) ? null : asUTC - utcMs;
  } catch {
    return null;
  }
}

function zonedWallClockToUtc(year, mon, day, hour, min, tz, isUtc) {
  // Convierte una hora de pared (year-mon-day hour:min) interpretada en `tz` al instante UTC.
  const guess = Date.UTC(year, mon, day, hour, min);
  if (isUtc) return guess;
  const offset = tzOffsetMs(guess, tz);
  return offset == null ? guess : guess - offset; // wall-clock en tz -> instante absoluto
}

function parseClaudeResetText(text) {
  // Claude /usage da el reset como texto absoluto con zona EXPLICITA entre parentesis, ej
  // "Jun 22, 10am (UTC)" o "Jun 29, 10am (America/Bogota)". La hora es WALL-CLOCK en ESA zona,
  // NO en UTC: hay que respetar la etiqueta o el countdown sale corrido (10am Bogota = 15:00
  // UTC, +5h) y la sesion aparece "vencida". Claude varia la zona segun el TZ del entorno.
  const t = normalizeResetText(text);
  if (!t) return null;
  // Zona explicita al final: "(UTC)", "(GMT)", "(America/Bogota)". Sin zona o UTC/GMT/Z -> UTC.
  const tzMatch = t.match(/\(([^)]+)\)\s*$/);
  const tz = tzMatch ? tzMatch[1].trim() : "";
  const isUtc = !tz || /^(utc|gmt|z)$/i.test(tz);
  const m = t.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = months[m[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]);
  const min = m[4] ? Number(m[4]) : 0;
  const ap = (m[5] || "").toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  const now = new Date();
  let d = new Date(zonedWallClockToUtc(now.getUTCFullYear(), mon, day, hour, min, tz, isUtc));
  // Claude no incluye el anio: si el instante quedo >1 dia en el pasado, es del proximo anio.
  if (d.getTime() < now.getTime() - 86400000) {
    d = new Date(zonedWallClockToUtc(now.getUTCFullYear() + 1, mon, day, hour, min, tz, isUtc));
  }
  return Number.isNaN(d.getTime()) ? null : d;
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
    const windows = live.windows.map((w) => {
      const rawLabel = w.rawLabel || w.label || w.key || "";
      return {
        ...w,
        key: claudeWindowKey(rawLabel),
        label: claudeWindowLabel(rawLabel),
        rawLabel,
        reset: w.reset || parseClaudeResetText(w.resetText),
      };
    });
    const globalWindows = windows.filter((window) => window.key === "session" || window.key === "week_all");
    const availability = conjunctiveQuotaAvailability(globalWindows.length ? globalWindows : windows);
    return {
      source: "claude",
      dataSource: "claude-cli",
      kind: "detected-percent",
      ok: true,
      ...availability,
      windows,
      activeBlock,
      observedAt: live.capturedAt || null,
      stale: Boolean(live.cacheStale),
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
  const modelQuotas = Array.isArray(live?.modelQuotas) ? live.modelQuotas : [];
  const hasGlobalQuota = live?.usedPercent !== null
    && live?.usedPercent !== undefined
    && Number.isFinite(Number(live.usedPercent));
  if (live?.ok && (hasGlobalQuota || modelQuotas.length)) {
    const usedPercent = hasGlobalQuota ? Math.min(999, Number(live.usedPercent)) : null;
    const remainingPercent = hasGlobalQuota
      ? Math.max(0, Number(live.remainingPercent ?? 100 - usedPercent))
      : null;
    const limitRequests = Number(live.usageLimit || config.dailyRequests || 0) || null;
    const remainingRequests =
      live.remainingRequests != null
        ? Number(live.remainingRequests)
        : limitRequests && remainingPercent != null
          ? Math.max(0, Math.round((remainingPercent / 100) * limitRequests))
          : null;
    const reset = dateFromProviderValue(live.resetAt);
    const windows = [];
    if (hasGlobalQuota) {
      windows.push({
        key: "daily_global",
        label: "dia",
        windowType: "daily",
        windowMinutes: 1440,
        usedPercent,
        remainingPercent,
        reset,
        resetText: live.resetText || "",
        limit: limitRequests,
        remaining: remainingRequests,
        used: limitRequests && remainingRequests != null ? Math.max(0, limitRequests - remainingRequests) : null,
      });
    }
    for (const quota of modelQuotas) {
      const modelUsed = quota.usedPercent == null ? NaN : Number(quota.usedPercent);
      const modelRemaining = quota.remainingPercent == null ? NaN : Number(quota.remainingPercent);
      if (!Number.isFinite(modelUsed) && !Number.isFinite(modelRemaining)) continue;
      windows.push({
        key: `model_${String(quota.model || "model").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        label: quota.model || "modelo",
        model: quota.model || "",
        windowType: "model",
        usedPercent: Number.isFinite(modelUsed) ? modelUsed : Math.max(0, 100 - modelRemaining),
        remainingPercent: Number.isFinite(modelRemaining) ? modelRemaining : Math.max(0, 100 - modelUsed),
        reset: dateFromProviderValue(quota.resetAt),
        resetText: quota.resetText || "",
      });
    }
    const modelWindows = windows.filter((window) => window.windowType === "model");
    const availableModels = modelWindows
      .filter((window) => window.remainingPercent > 0)
      .map((window) => window.model || "modelo");
    const unavailableModels = modelWindows
      .filter((window) => window.remainingPercent <= 0)
      .map((window) => window.model || "modelo");
    const modelCapacity = modelWindows.length
      ? Math.max(...modelWindows.map((window) => window.remainingPercent))
      : null;
    const globalAvailable = remainingPercent == null || remainingPercent > 0;
    const modelsAvailable = !modelWindows.length || availableModels.length > 0;
    const available = globalAvailable && modelsAvailable;
    const limited = !available;
    const capacityValues = [remainingPercent, modelCapacity].filter((value) => value !== null);
    return {
      source: "gemini",
      dataSource: "gemini-cli",
      kind: "detected-requests",
      ok: true,
      available,
      limited,
      effectiveRemainingPercent: capacityValues.length ? Math.min(...capacityValues) : null,
      limitingWindows: remainingPercent !== null && remainingPercent <= 0 ? ["dia"] : [],
      availableGroups: availableModels,
      limitingGroups: unavailableModels,
      unavailableModels,
      windows,
      usedPercent,
      remainingPercent,
      limitRequests,
      remainingRequests,
      resetText: live.resetText || "",
      resetAt: reset,
      tier: live.tier || "",
      plan: live.tier || "",
      modelQuotas,
      observedAt: live.capturedAt || null,
      stale: Boolean(live.cacheStale),
      live,
      note: live.cacheHit ? "Gemini /stats model desde cache local." : "Gemini /stats model detectado desde el CLI.",
    };
  }

  if (live?.needsAuth || live?.authDead) {
    return {
      source: "gemini",
      kind: "unknown",
      ok: false,
      available: false,
      needsAuth: true,
      windows: [],
      observedAt: live.capturedAt || null,
      note: live.note || "Gemini CLI requiere autenticacion; ejecuta `gemini`.",
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
  const used = Number(usage?.totals?.effectiveTokens ?? usage?.totals?.totalTokens ?? 0);
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

function dateFromProviderValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function miniMaxWindowValues(model, prefix) {
  const directRemaining = finiteNumberOrNull(model?.[`${prefix}_remaining_percent`]);
  const status = finiteNumberOrNull(model?.[`${prefix}_status`]);
  const total = finiteNumberOrNull(model?.[`${prefix}_total_count`]);
  // Despite the historical field name, MiniMax returns remaining requests here.
  const remainingCount = finiteNumberOrNull(model?.[`${prefix}_usage_count`]);
  let remainingPercent = directRemaining;
  if (remainingPercent === null && total !== null && total > 0 && remainingCount !== null) {
    remainingPercent = (remainingCount / total) * 100;
  }
  return {
    active: status === null || status === 1 || status === 2,
    status,
    remainingPercent: remainingPercent === null ? null : Math.max(0, Math.min(100, remainingPercent)),
    limit: total !== null && total > 0 ? total : null,
    remaining: total !== null && total > 0 && remainingCount !== null ? Math.max(0, remainingCount) : null,
    used: total !== null && total > 0 && remainingCount !== null ? Math.max(0, total - remainingCount) : null,
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
    const unavailableModels = [];
    for (const m of data.model_remains) {
      const modelName = m.model_name || "model";
      const interval = miniMaxWindowValues(m, "current_interval");
      const weekly = miniMaxWindowValues(m, "current_weekly");
      const intervalIsDaily = modelName !== "general";
      if (interval.active && interval.remainingPercent !== null) {
        windows.push({
          key: `${intervalIsDaily ? "daily" : "interval"}_${modelName}`,
          label: `${modelName} ${intervalIsDaily ? "dia" : "5h"}`,
          model: modelName,
          windowType: intervalIsDaily ? "daily" : "rolling",
          windowMinutes: intervalIsDaily ? 1440 : 300,
          status: interval.status,
          usedPercent: Math.max(0, 100 - interval.remainingPercent),
          remainingPercent: interval.remainingPercent,
          reset: dateFromProviderValue(m.end_time),
          limit: interval.limit,
          used: interval.used,
          remaining: interval.remaining,
        });
      }
      if (weekly.active && weekly.remainingPercent !== null) {
        windows.push({
          key: `weekly_${modelName}`,
          label: `${modelName} sem`,
          model: modelName,
          windowType: "weekly",
          windowMinutes: 10080,
          status: weekly.status,
          usedPercent: Math.max(0, 100 - weekly.remainingPercent),
          remainingPercent: weekly.remainingPercent,
          reset: dateFromProviderValue(m.weekly_end_time),
          limit: weekly.limit,
          used: weekly.used,
          remaining: weekly.remaining,
        });
      }
      if (!interval.active && !weekly.active) unavailableModels.push(modelName);
    }
    if (windows.length) {
      const availability = groupedQuotaAvailability(windows, "model");
      return {
        source: "minimax",
        dataSource: "minimax-api",
        kind: "detected-percent",
        ok: true,
        ...availability,
        windows,
        unavailableModels,
        observedAt: usage.capturedAt || null,
        stale: Boolean(usage.cacheStale),
        raw: usage.raw || null,
        note: usage.note || (usage.cacheHit ? "MiniMax desde cache local." : "MiniMax Token Plan."),
      };
    }
    if (unavailableModels.length) {
      return {
        source: "minimax",
        dataSource: "minimax-api",
        kind: "unknown",
        ok: false,
        available: false,
        unusable: true,
        reason: "not-configured",
        windows: [],
        unavailableModels,
        observedAt: usage.capturedAt || null,
        stale: Boolean(usage.cacheStale),
        note: "MiniMax Token Plan sin modelos suscritos en esta cuenta.",
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
  const windows = finalUsedPercent != null ? [{
    key: "plan",
    label: plan || "plan",
    usedPercent: finalUsedPercent,
    remainingPercent,
    reset: resetAt,
    resetText,
  }] : [];
  const availability = conjunctiveQuotaAvailability(windows);

  return {
    source: "minimax",
    dataSource: usage.source || "minimax-api",
    kind: limit > 0 ? "configured-credits" : "detected-percent",
    ok: true,
    ...availability,
    windows,
    used,
    limit: limit || null,
    remaining: finalRemaining,
    usedPercent: finalUsedPercent,
    remainingPercent,
    resetAt,
    resetText,
    plan,
    observedAt: usage.capturedAt || null,
    stale: Boolean(usage.cacheStale),
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

function staleAntigravityQuota(note, reason = null) {
  const stale = readJsonSafe(ANTIGRAVITY_QUOTA_CACHE_PATH);
  if (stale?.ok) {
    return { ...stale, cacheHit: true, cacheStale: true, note: `${note} Usando cache.` };
  }
  return { source: "antigravity", ok: false, note, ...(reason ? { unusable: true, reason } : {}) };
}

function parseRefreshShort(text) {
  // "93h 46m" / "55m" / "2d 3h" -> Date futura.
  let ms = 0;
  let found = false;
  for (const m of String(text || "").matchAll(/(\d+)\s*([dhms])/gi)) {
    found = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    ms += n * (u === "d" ? 86400000 : u === "h" ? 3600000 : u === "m" ? 60000 : 1000);
  }
  return found ? new Date(Date.now() + ms) : null;
}

async function captureAntigravityUsage(config = {}) {
  // Captura el comando interactivo `/usage` del CLI agy, que muestra la cuota por
  // GRUPO (Gemini y Claude/GPT) — la API SDK solo expone Gemini.
  const helper = path.join(SCRIPT_DIR, "antigravity-usage-capture.py");
  if (!existsSync(helper)) return { ok: false };
  const timeoutSeconds = Math.max(15, Number(config.usageTimeoutSeconds || 40));
  try {
    const { stdout } = await execFileAsync("python3", [helper], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: (timeoutSeconds + 5) * 1000,
      env: { ...process.env, AI_USAGE_ANTIGRAVITY_TIMEOUT: String(timeoutSeconds) },
    });
    return JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
}

// NOTA: antigravity es SINGLE-ACCOUNT por diseno (resolveAccounts lo rechaza con >1
// cuenta): su CLI fija la raiz en ~/.gemini/antigravity-cli y la captura es scraping por
// PTY. Acepta `account` solo para que el runner generico lo llame igual que a los demas.
async function collectAntigravityQuotaLive(config = {}, { ignoreCache = false, account = null } = {}) {
  void account;
  // Cuota REAL del plan consumer de Antigravity (Gemini) via el backend
  // cloudcode-pa.googleapis.com:retrieveUserQuota, usando el oauth-token local.
  if (process.env.AI_USAGE_ANTIGRAVITY_LIVE === "0" || config.liveCapture === false) {
    return { source: "antigravity", ok: false, disabled: true, note: "Antigravity API desactivada." };
  }

  const cacheMinutes = Number(process.env.ANTIGRAVITY_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 3);
  if (!ignoreCache) {
    const cached = readJsonCache(ANTIGRAVITY_QUOTA_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
    if (cached) return { ...cached, cacheHit: true };
  }

  // 1) Fuente PRIMARIA: el comando /usage del CLI agy (cuota por grupo Gemini + Claude/GPT).
  if (process.env.AI_USAGE_ANTIGRAVITY_USAGE !== "0") {
    const viaUsage = await captureAntigravityUsage(config);
    if (viaUsage?.ok && Array.isArray(viaUsage.groups) && viaUsage.groups.length) {
      const output = {
        source: "antigravity",
        ok: true,
        groups: viaUsage.groups,
        capturedAt: viaUsage.capturedAt || new Date().toISOString(),
        cacheHit: false,
        note: "Antigravity /usage (CLI).",
      };
      writeJsonCache(ANTIGRAVITY_QUOTA_CACHE_PATH, output);
      return output;
    }
  }

  // 2) Fallback: API SDK retrieveUserQuota (solo Gemini por-modelo).
  const tokenRaw = readJsonSafe(ANTIGRAVITY_TOKEN_PATH);
  const accessToken = tokenRaw?.token?.access_token || tokenRaw?.access_token;
  if (!accessToken) {
    return staleAntigravityQuota("No encuentro token de Antigravity (~/.gemini/antigravity-cli/antigravity-oauth-token).", "not-configured");
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
        remainingFraction: finiteNumberOrNull(b.remainingFraction),
        resetTime: b.resetTime || null,
        tokenType: b.tokenType || "",
      }))
      .filter((b) => b.remainingFraction !== null);
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
  // Antigravity ofrece una cuota separada de Gemini CLI y tambien agrupa modelos Claude/GPT.
  // Cuota real desde CLI/API consumer; fallback a limites manuales; consumo (sesiones,
  // pasos de modelo, ultima actividad) derivado de transcripts locales.
  const installed = Boolean(usage?.installed);
  const sessions = usage?.sessions ?? 0;
  const modelSteps = usage?.modelSteps ?? 0;
  const lastActivity = usage?.lastActivity || null;
  const statBits = [`sesiones=${sessions}`, `pasos=${modelSteps}`];
  if (lastActivity) statBits.push(`ult ${timeOnly(lastActivity)}`);
  const statsNote = statBits.join("  ");

  // 1) Fuente CLI /usage: grupos Gemini y Claude/GPT, cada uno con limite 5h y semanal.
  if (live?.ok && Array.isArray(live.groups) && live.groups.length) {
    const windows = [];
    for (const g of live.groups) {
      const fam = g.name || "grupo";
      for (const [key, label, w] of [["5h", "5 horas", g.fiveHour], ["sem", "semanal", g.weekly]]) {
        const rem = finiteNumberOrNull(w?.remainingPercent);
        if (rem === null) continue;
        const remPct = Math.max(0, Math.min(100, rem));
        windows.push({
          key: `${fam}-${key}`,
          label,
          family: fam,
          usedPercent: Math.max(0, Math.min(100, 100 - remPct)),
          remainingPercent: remPct,
          reset: parseRefreshShort(w.refreshText),
          resetText: w.refreshText || "",
        });
      }
    }
    if (windows.length) {
      const ageMs = live.capturedAt ? Date.now() - Date.parse(live.capturedAt) : NaN;
      const ageTag = Number.isFinite(ageMs) ? `  [hace ${Math.max(0, Math.round(ageMs / 60000))}m]` : "";
      const availability = groupedQuotaAvailability(windows, "family");
      return {
        source: "antigravity",
        dataSource: "antigravity-cli",
        kind: "detected-percent",
        ok: true,
        ...availability,
        windows,
        observedAt: live.capturedAt || null,
        stale: Boolean(live.cacheStale),
        note: `Antigravity /usage (CLI, ${live.groups.length} grupos: Gemini + Claude/GPT).  ${statsNote}${ageTag}${live.cacheStale ? "  [cache vieja]" : ""}`,
      };
    }
  }

  // 2) Fallback API: retrieveUserQuota expone cuotas Gemini por modelo.
  if (live?.ok && Array.isArray(live.buckets) && live.buckets.length) {
    const isGemini = (b) => /gemini/i.test(b.modelId);
    const sorted = live.buckets
      .filter((bucket) => finiteNumberOrNull(bucket.remainingFraction) !== null)
      .map((bucket) => ({ ...bucket, remainingFraction: Number(bucket.remainingFraction) }))
      .sort((a, b) => {
      const ga = isGemini(a) ? 0 : 1;
      const gb = isGemini(b) ? 0 : 1;
      if (ga !== gb) return ga - gb; // gemini primero
      return a.remainingFraction - b.remainingFraction; // dentro del grupo, mas usado primero
      });
    const windows = sorted.map((b) => {
      const remPct = Math.max(0, Math.min(100, b.remainingFraction * 100));
      return {
        key: b.modelId,
        label: shortText(b.modelId.replace(/-preview$/, ""), 18),
        model: b.modelId,
        family: isGemini(b) ? "gemini" : "otros",
        usedPercent: Math.max(0, Math.min(100, 100 - remPct)),
        remainingPercent: remPct,
        reset: b.resetTime ? new Date(b.resetTime) : null,
      };
    });
    // `agy models` solo confirma que un modelo se ofrece, no que tenga cuota.
    const offeredModels = (Array.isArray(usage?.models) ? usage.models : [])
      .filter((model) => !/gemini/i.test(model));
    const unit = live.buckets[0]?.tokenType || "req";
    const offeredNote = offeredModels.length
      ? `; ${offeredModels.length} Claude/GPT ofrecidos con cuota desconocida`
      : "";
    const availability = groupedQuotaAvailability(windows, "model");
    return {
      source: "antigravity",
      dataSource: "antigravity-api",
      kind: "detected-percent",
      ok: true,
      ...availability,
      windows,
      unavailableModels: availability.limitingGroups,
      offeredModels,
      observedAt: live.capturedAt || null,
      stale: Boolean(live.cacheStale),
      note: `Antigravity (API real, ${unit}, ${windows.length} con cuota${offeredNote}).  ${statsNote}${live.cacheStale ? "  [cache]" : ""}`,
    };
  }

  if (!installed && !(live && live.ok === false && live.note)) {
    return { source: "antigravity", kind: "unknown", ok: false, unusable: true, reason: "not-installed", note: "Antigravity no instalado (no encuentro antigravity/agy)." };
  }

  // 2) Fallback: limites manuales en quotas.json.
  const monthlyCredits = config?.monthlyCredits != null ? Number(config.monthlyCredits) : null;
  const usedCredits = config?.usedCredits != null ? Number(config.usedCredits) : null;
  const resetsAt = config?.resetsAt ? new Date(config.resetsAt) : null;
  if (Number.isFinite(monthlyCredits) && monthlyCredits > 0) {
    const used = Number.isFinite(usedCredits) ? Math.max(0, usedCredits) : 0;
    const usedPercent = Math.min(999, (used / monthlyCredits) * 100);
    const windows = [{
      key: "manual",
      label: "manual",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      reset: resetsAt,
    }];
    return {
      source: "antigravity",
      kind: "configured-credits",
      ok: true,
      ...conjunctiveQuotaAvailability(windows),
      windows,
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

function buildOpenCodeQuota(usage, config = {}, server = null) {
  const data = usage?.data || usage || {};

  const availabilityFor = (windows) => {
    const numeric = windows.filter((window) => finiteNumberOrNull(window.remainingPercent) !== null);
    const limitingWindows = numeric
      .filter((window) => Number(window.remainingPercent) <= 0 || /rate.?limited|blocked|exhausted/i.test(String(window.status || "")))
      .map((window) => String(window.label || window.key || "limite"));
    const effectiveRemainingPercent = numeric.length
      ? Math.min(...numeric.map((window) => Number(window.remainingPercent)))
      : null;
    return {
      available: numeric.length > 0 && limitingWindows.length === 0,
      limited: limitingWindows.length > 0,
      limitingWindows,
      effectiveRemainingPercent,
    };
  };

  // 0) Cuota REAL desde opencode.ai/auth (scrape web autenticado). Precedencia maxima.
  if (server?.ok && Array.isArray(server.windows) && server.windows.length) {
    const localBits = [];
    if (typeof data.cost5h === "number") localBits.push(`5h ${fmtMoney(data.cost5h)}`);
    if (typeof data.costWeek === "number") localBits.push(`sem ${fmtMoney(data.costWeek)}`);
    if (typeof data.costMonth === "number") localBits.push(`mes ${fmtMoney(data.costMonth)}`);
    const availability = availabilityFor(server.windows);
    const requiredKeys = ["5h", "week", "month"];
    const missingWindows = requiredKeys
      .filter((key) => !server.windows.some((window) => window.key === key))
      .map((key) => key === "5h" ? "5 horas" : key === "week" ? "semanal" : "mensual");
    if (missingWindows.length) availability.available = false;
    return {
      source: "opencode",
      dataSource: "opencode-web",
      kind: "detected-percent",
      ok: true,
      windows: server.windows,
      ...availability,
      incomplete: missingWindows.length > 0,
      missingWindows,
      observedAt: server.capturedAt || null,
      stale: Boolean(server.cacheStale),
      totalCost: data.totalCost || 0,
      totalTokens: data.totalTokens || 0,
      sessionCount: data.sessionCount || 0,
      serverOverride: false,
      note: `${availability.limited ? `LIMITE ALCANZADO (${availability.limitingWindows.join(", ")}). ` : ""}${missingWindows.length ? `Cuota incompleta: falta ${missingWindows.join(", ")}; disponibilidad no confirmada. ` : ""}Cuota real (opencode.ai/auth)${server.cacheStale ? " [cache]" : ""}.${localBits.length ? `  ·  estimado local (tarifa publica): ${localBits.join("  ")}` : ""}`,
    };
  }

  if (!usage) {
    return { source: "opencode", kind: "unknown", ok: false, note: "Sin datos." };
  }
  if (usage.ok === false) {
    return { source: "opencode", kind: "unknown", ok: false, note: usage.note || "OpenCode Go no configurado." };
  }

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
    const availability = availabilityFor(windows);
    let noteText = useOverride
      ? (override.note ? `Override manual: ${override.note}` : "Override manual desde opencode.ai/auth.")
      : (usage.note || (usage.cacheHit ? "OpenCode Go desde cache local." : "OpenCode Go DB local."));
    let overrideStale = useOverride;
    if (useOverride) {
      const capturedAt = Date.parse(override.capturedAt || "");
      if (Number.isFinite(capturedAt)) {
        const ageH = Math.max(0, Math.round((Date.now() - capturedAt) / 3600000));
        overrideStale = ageH >= 12;
        noteText = `${ageH >= 12 ? `[stale ${ageH}h - actualiza opencode.ai/auth] ` : `[hace ${ageH}h] `}${noteText}`;
      } else {
        noteText = `[stale - capturedAt desconocido] ${noteText}`;
      }
      const localBits = [];
      if (typeof data.cost5h === "number") localBits.push(`5h ${fmtMoney(data.cost5h)}`);
      if (typeof data.costWeek === "number") localBits.push(`sem ${fmtMoney(data.costWeek)}`);
      if (typeof data.costMonth === "number") localBits.push(`mes ${fmtMoney(data.costMonth)}`);
      if (localBits.length) noteText += `  ·  estimado local (tarifa publica): ${localBits.join("  ")}`;
    }
    return {
      source: "opencode",
      dataSource: allServer ? "opencode-override" : "opencode-db",
      kind: "detected-percent",
      ok: true,
      windows,
      ...availability,
      observedAt: useOverride ? (override.capturedAt || null) : (usage.capturedAt || null),
      stale: Boolean(usage.cacheStale) || overrideStale,
      totalCost: data.totalCost || 0,
      totalTokens: data.totalTokens || 0,
      sessionCount: data.sessionCount || 0,
      serverOverride: allServer,
      note: `${availability.limited ? `LIMITE ALCANZADO (${availability.limitingWindows.join(", ")}). ` : ""}${noteText}`,
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

async function collectCodexLive(config = {}, { ignoreCache = false, account = null } = {}) {
  // Codex moderno ofrece account/rateLimits/read por app-server, sin crear una sesion ni gastar
  // tokens. codex-probe.py conserva el antiguo `codex exec` solo como fallback opt-in.
  const cachePath = account ? accountCachePath(account, "probe-cache") : CODEX_PROBE_CACHE_PATH;
  if (process.env.AI_USAGE_CODEX_LIVE === "0" || config?.liveUsage === false) {
    return { ok: false, disabled: true, note: "Codex app-server desactivado." };
  }
  if (!commandExists("codex")) return { ok: false, unusable: true, reason: "not-installed", note: "codex no instalado." };
  const legacyCacheMinutes = Number(process.env.CODEX_PROBE_CACHE_MINUTES ?? config.probeCacheMinutes ?? 1);
  const cacheSeconds = Number(process.env.CODEX_USAGE_CACHE_SECONDS ?? config.liveUsageCacheSeconds ?? legacyCacheMinutes * 60);
  if (!ignoreCache) {
    const cached = readJsonCache(cachePath, Math.max(0, cacheSeconds) * 1000);
    if (cached) return { ...cached, cacheHit: true };
  }
  const helper = path.join(SCRIPT_DIR, "codex-probe.py");
  if (!existsSync(helper)) return { ok: false, unusable: true, reason: "not-installed", note: "falta codex-probe.py." };
  try {
    // codex-probe.py hace Popen(...) sin env=, asi que hereda este entorno; CODEX_HOME
    // llega tanto al app-server como al escaneo de sesiones (que ahora tambien lo respeta).
    const { stdout } = await execFileAsync("python3", [helper], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 35000,
      env: accountEnv(account, {
        AI_USAGE_LIVE_VERSION: APP_VERSION,
        CODEX_PROBE_TIMEOUT: process.env.CODEX_PROBE_TIMEOUT || "16",
        CODEX_ALLOW_EXEC_PROBE: config.probe === true && process.env.AI_USAGE_CODEX_PROBE !== "0" ? "1" : "0",
      }),
    });
    const parsed = JSON.parse(stdout);
    if (parsed?.ok) {
      writeJsonCache(cachePath, parsed);
      return parsed;
    }
    const stale = readJsonSafe(cachePath);
    if (stale?.ok) return { ...stale, cacheHit: true, cacheStale: true };
    return parsed || { ok: false };
  } catch (error) {
    const stale = readJsonSafe(cachePath);
    if (stale?.ok) return { ...stale, cacheHit: true, cacheStale: true };
    return { ok: false, note: `codex probe fallo: ${shortError(error)}` };
  }
}

function collectCodexRateLimits() {
  // CODEX_HOME manda: sin esto el fallback de escaneo de sesiones de la cuenta B leeria
  // los rate_limits de la cuenta A y los reportaria como suyos (bug silencioso).
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
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

async function collectClaudeUsageLive(config = {}, { ignoreCache = false, account = null } = {}) {
  // Sin `account` (modo legacy) el cache y el entorno son EXACTAMENTE los de siempre.
  const cachePath = account ? accountCachePath(account, "usage-cache") : CLAUDE_USAGE_CACHE_PATH;
  const childEnv = accountEnv(account);
  if (process.env.AI_USAGE_CLAUDE_LIVE === "0" || config.liveUsage === false) {
    return { source: "claude", ok: false, disabled: true, note: "Claude /usage desactivado." };
  }

  const cacheSeconds = Number(config.liveUsageCacheSeconds ?? 300);
  if (!ignoreCache) {
    const cached = readJsonCache(cachePath, Math.max(0, cacheSeconds) * 1000);
    if (cached) return { ...cached, cacheHit: true };
  }

  if (!commandExists("claude")) {
    return { source: "claude", ok: false, unusable: true, reason: "not-installed", note: "No encuentro el comando claude." };
  }

  try {
    // Quota polling needs authentication but never user/project customizations. Loading the
    // regular profile here starts channel plugins on every short-lived poll; detached Telegram
    // and Clawbus Bun workers can then outlive Claude and leak CPU/RAM without bound.
    const { stdout } = await execFileAsync("claude", ["--safe-mode", "-p", "/usage", "--output-format", "json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
      // accountEnv() devuelve undefined para la cuenta implicita: mismas opciones que antes.
      // Con credential.kind="configDir" inyecta CLAUDE_CONFIG_DIR y aisla la credencial
      // (verificado en claude 2.1.220: una raiz vacia no devuelve barras de uso).
      ...(childEnv ? { env: childEnv } : {}),
    });
    let resultText = stdout;
    try {
      const parsedJson = JSON.parse(stdout);
      resultText = parsedJson.result || parsedJson.message || stdout;
    } catch {
      // Some older builds may print plain text.
    }
    const parsed = parseClaudeUsageOutput(resultText);
    const stale = readJsonSafe(cachePath);

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
          lastCheckedAt: new Date().toISOString(),
          cacheHit: true,
          cacheStale: true,
          note: "Claude no devolvio barras (limitado); mostrando ultimo dato conocido.",
        };
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
      writeJsonCache(cachePath, output);
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
    writeJsonCache(cachePath, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(cachePath);
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
  if (lower.includes("session")) return "session";
  if (lower.includes("week")) {
    const scope = lower.match(/\(([^)]+)\)/)?.[1]?.trim() || "";
    if (!scope || scope === "all" || scope.includes("all model")) return "week_all";
    const normalizedScope = scope
      .replace(/\bonly\b/g, "")
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    return `week_${normalizedScope || "other"}`;
  }
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function claudeWindowLabel(label) {
  const key = claudeWindowKey(label);
  if (key === "session") return "sesion";
  if (key === "week_all") return "semana";
  if (key.startsWith("week_")) {
    const scope = String(label).match(/\(([^)]+)\)/)?.[1]?.replace(/\bonly\b/gi, "").trim();
    if (scope) return scope;
    return key.slice(5).replace(/_/g, " ");
  }
  return label;
}

async function collectGeminiQuotaLive(config = {}, { ignoreCache = false, account = null } = {}) {
  const cachePath = account ? accountCachePath(account, "quota-cache") : GEMINI_QUOTA_CACHE_PATH;
  if (process.env.AI_USAGE_GEMINI_LIVE === "0" || config.liveCapture === false) {
    return { source: "gemini", ok: false, disabled: true, note: "Gemini /stats model desactivado." };
  }

  const cacheMinutes = Number(config.liveCaptureCacheMinutes ?? 15);
  if (!ignoreCache) {
    const cached = readJsonCache(cachePath, Math.max(0, cacheMinutes) * 60000);
    if (cached) return { ...cached, cacheHit: true };
  }

  if (!commandExists("gemini")) {
    return { source: "gemini", ok: false, unusable: true, reason: "not-installed", note: "No encuentro el comando gemini." };
  }

  const helper = path.join(SCRIPT_DIR, "gemini-quota-capture.py");
  if (!existsSync(helper)) {
    return { source: "gemini", ok: false, unusable: true, reason: "not-installed", note: "Falta gemini-quota-capture.py." };
  }

  const timeoutSeconds = Math.max(10, Number(config.liveCaptureTimeoutSeconds || 45));
  try {
    const { stdout } = await execFileAsync("python3", [helper], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: (timeoutSeconds + 5) * 1000,
      // gemini-quota-capture.py hace os.environ.copy(), asi que GEMINI_CLI_HOME se propaga.
      env: accountEnv(account, { AI_USAGE_GEMINI_TIMEOUT: String(timeoutSeconds) }),
    });
    const parsed = JSON.parse(stdout);
    const output = {
      source: "gemini",
      ...parsed,
      capturedAt: parsed.capturedAt || new Date().toISOString(),
      cacheHit: false,
    };
    if (output.ok) {
      writeJsonCache(cachePath, output);
      return output;
    }
    if (output.needsAuth || output.authError) return output;
    const stale = readJsonSafe(cachePath);
    if (stale?.ok) {
      return {
        ...stale,
        cacheHit: true,
        cacheStale: true,
        note: `Gemini /stats model no se pudo parsear; usando cache anterior (${output.note || "formato desconocido"}).`,
      };
    }
    return output;
  } catch (error) {
    const stale = readJsonSafe(cachePath);
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

async function collectMiniMaxUsage(quotaConfig = null, { ignoreCache = false, account = null } = {}) {
  const config = quotaConfig || loadQuotaConfig();
  const configEntry = account?.config || config?.minimax || {};
  const cachePath = account ? accountCachePath(account, "usage-cache") : MINIMAX_USAGE_CACHE_PATH;
  // Con credential.kind="env" la key sale de la env var declarada por la cuenta y se lee
  // SOLO aqui, al construir el header. Sin cuenta (legacy) el orden env-primero es el de
  // siempre. En ningun caso el valor sale al output, a los logs ni al TUI.
  const credentialKind = account?.credential?.kind || "legacy";
  const keyFromEnv = credentialKind === "env"
    ? (process.env[account.credential.var] || "")
    : (process.env.MINIMAX_API_KEY || "");
  const keyFromFile = credentialKind === "env" ? "" : (configEntry.apiKey || "");
  const apiKey = keyFromEnv || keyFromFile;
  const keySourceLabel = credentialKind === "env"
    ? `env:${account.credential.var}`
    : keyFromEnv ? "env" : keyFromFile ? "quotas.json" : "none";
  const debug = process.env.AI_USAGE_MINIMAX_DEBUG === "1";
  const liveDisabled = process.env.AI_USAGE_MINIMAX_LIVE === "0" || configEntry.liveCapture === false;
  const cacheMinutes = Number(process.env.MINIMAX_USAGE_CACHE_MINUTES ?? configEntry.liveCaptureCacheMinutes ?? 0);
  const cached = readJsonCache(cachePath, Math.max(0, cacheMinutes) * 60000);
  if (cached && (!ignoreCache || liveDisabled)) {
    if (debug) process.stderr.write(`[minimax] cache hit (age < ${cacheMinutes}m)\n`);
    return { ...cached, cacheHit: true };
  }
  if (liveDisabled) {
    const stale = readJsonSafe(cachePath);
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
    process.stderr.write(`[minimax] key source: ${keySourceLabel} (${apiKey ? "present" : "empty"})\n`);
  }
  if (!apiKey) {
    return {
      source: "minimax",
      ok: false,
      unusable: true,
      reason: "not-configured",
      note: "MINIMAX_API_KEY no definida. Define la env var o agrega minimax.apiKey en quotas.json (ai-usage-quota edit).",
    };
  }

  const url = process.env.MINIMAX_USAGE_URL || "https://www.minimax.io/v1/token_plan/remains";
  if (debug) {
    process.stderr.write(`[minimax] GET ${url}\n[minimax] Authorization: Bearer [redacted]\n`);
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
      const stale = readJsonSafe(cachePath);
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
    writeJsonCache(cachePath, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(cachePath);
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

function staleOpenCodeServer(note, workspaceId = "") {
  const stale = readJsonSafe(OPENCODE_SERVER_CACHE_PATH);
  if (stale?.ok && (!workspaceId || stale.workspaceId === workspaceId)) {
    return { ...stale, cacheHit: true, cacheStale: true, note: `${note} Usando cache.` };
  }
  return { ok: false, note };
}

function parseResetDuration(text) {
  let ms = 0;
  let found = false;
  const re = /(\d+)\s*(day|hour|minute|second)s?/gi;
  let m;
  while ((m = re.exec(text))) {
    found = true;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    ms += n * (unit === "day" ? 86400000 : unit === "hour" ? 3600000 : unit === "minute" ? 60000 : 1000);
  }
  return found ? new Date(Date.now() + ms) : null;
}

function parseOpenCodeServerUsage(html) {
  // El dashboard de opencode.ai/auth es SSR (SolidStart). Quitamos los marcadores
  // de hidratacion y extraemos los 3 bloques Rolling/Weekly/Monthly.
  const clean = String(html).replace(/<!--\$-->/g, "").replace(/<!--\/-->/g, "");
  const specs = [
    { match: "Rolling", object: "rollingUsage", key: "5h", label: "5 horas", windowMinutes: 300 },
    { match: "Weekly", object: "weeklyUsage", key: "week", label: "semanal", windowMinutes: 10080 },
    { match: "Monthly", object: "monthlyUsage", key: "month", label: "mensual", windowMinutes: null },
  ];

  // SolidStart serializa tambien el estado de negocio. Es mas estable y, a diferencia de la
  // barra visual, indica explicitamente `status:"rate-limited"`.
  const structuredWindows = [];
  for (const spec of specs) {
    const objectRe = new RegExp(`${spec.object}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^}]+)\\}`, "i");
    const body = clean.match(objectRe)?.[1] || "";
    const usedMatch = body.match(/usagePercent\s*:\s*(\d+(?:\.\d+)?)/i);
    if (!usedMatch) continue;
    const resetSeconds = Number(body.match(/resetInSec\s*:\s*(\d+)/i)?.[1]);
    const status = body.match(/status\s*:\s*["']([^"']+)["']/i)?.[1] || "";
    const usedPercent = Math.max(0, Math.min(100, Number(usedMatch[1])));
    structuredWindows.push({
      key: spec.key,
      label: spec.label,
      windowType: spec.key === "5h" ? "rolling" : spec.key === "week" ? "weekly" : "monthly",
      windowMinutes: spec.windowMinutes,
      status,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      reset: Number.isFinite(resetSeconds) ? new Date(Date.now() + resetSeconds * 1000) : null,
      resetText: Number.isFinite(resetSeconds) ? fmtCountdown(new Date(Date.now() + resetSeconds * 1000)) : "",
      source: "web",
    });
  }
  const windows = [...structuredWindows];
  for (const spec of specs) {
    if (windows.some((window) => window.key === spec.key)) continue;
    const labelRe = new RegExp(`<span[^>]*data-slot=["']usage-label["'][^>]*>\\s*${spec.match}\\s+Usage\\s*</span>`, "i");
    const labelMatch = labelRe.exec(clean);
    if (!labelMatch) continue;
    const afterLabel = clean.slice(labelMatch.index + labelMatch[0].length);
    const nextLabel = afterLabel.search(/<span[^>]*data-slot=["']usage-label["']/i);
    const section = nextLabel >= 0 ? afterLabel.slice(0, nextLabel) : afterLabel;
    const valueMatch = section.match(/data-slot=["']usage-value["'][^>]*>[\s\S]*?(\d+(?:\.\d+)?)\s*%/i);
    if (!valueMatch) continue;
    const usedPercent = Math.max(0, Math.min(100, Number(valueMatch[1])));
    const resetMatch = section.match(/data-slot=["']reset-time["'][^>]*>([\s\S]*?)<\/span>/i);
    const resetText = String(resetMatch?.[1] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^\s*Resets in\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    windows.push({
      key: spec.key,
      label: spec.label,
      windowType: spec.key === "5h" ? "rolling" : spec.key === "week" ? "weekly" : "monthly",
      windowMinutes: spec.windowMinutes,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      reset: parseResetDuration(resetText),
      resetText,
      source: "web",
    });
  }
  if (!windows.length) return { ok: false, note: "no pude parsear opencode.ai/go (cambio el HTML o cookie invalida)." };
  const missingWindows = specs
    .filter((spec) => !windows.some((window) => window.key === spec.key))
    .map((spec) => spec.label);
  return {
    ok: true,
    windows,
    complete: missingWindows.length === 0,
    missingWindows,
    format: structuredWindows.length === specs.length
      ? "solid-state"
      : structuredWindows.length
        ? "solid-state+html"
        : "html",
  };
}

function resolveOpenCodeDbPath() {
  if (process.env.OPENCODE_DB_PATH) return process.env.OPENCODE_DB_PATH;
  if (commandExists("opencode")) {
    try {
      const value = execFileSync("opencode", ["db", "path"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }).trim();
      if (value) return value;
    } catch {
      // Older OpenCode versions do not expose `db path`.
    }
  }
  return OPENCODE_DB_FALLBACK_PATH;
}

async function queryOpenCodeSessions(dbPath, sql) {
  if (!process.env.OPENCODE_DB_PATH && commandExists("opencode")) {
    try {
      const { stdout } = await execFileAsync("opencode", ["db", sql, "--format", "json"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15000,
      });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch {
      // Fall through to sqlite3 for older or partially upgraded installations.
    }
  }
  const { stdout } = await execFileAsync("sqlite3", [dbPath, "-json", sql], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function collectOpenCodeServerUsage(config = {}, { ignoreCache = false } = {}) {
  // Cuota REAL del plan Go via scrape autenticado de opencode.ai/auth (no hay API).
  if (process.env.AI_USAGE_OPENCODE_WEB === "0") return { ok: false, disabled: true, note: "OpenCode web desactivado." };
  const cookie = config?.cookie;
  const workspaceId = config?.workspaceId;
  if (!cookie || !workspaceId) {
    return { ok: false, note: "Sin cookie/workspaceId de opencode.ai (pon opencode.cookie y opencode.workspaceId en quotas.json)." };
  }
  const cacheMinutes = Number(process.env.OPENCODE_USAGE_CACHE_MINUTES ?? config.liveCaptureCacheMinutes ?? 5);
  if (!ignoreCache) {
    const cached = readJsonCache(OPENCODE_SERVER_CACHE_PATH, Math.max(0, cacheMinutes) * 60000);
    if (cached?.workspaceId === workspaceId) return { ...cached, cacheHit: true };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let html;
    let httpStatus;
    try {
      const resp = await fetch(`https://opencode.ai/workspace/${workspaceId}/go`, {
        headers: { "User-Agent": OPENCODE_WEB_UA, Cookie: `auth=${cookie}`, Accept: "text/html" },
        redirect: "manual",
        signal: controller.signal,
      });
      httpStatus = resp.status;
      if (resp.status >= 300) {
        const hint = resp.status === 302 || resp.status === 401 || resp.status === 403 ? " (cookie expirada? repega la cookie auth)" : "";
        return staleOpenCodeServer(`opencode.ai HTTP ${resp.status}${hint}.`, workspaceId);
      }
      html = await resp.text();
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseOpenCodeServerUsage(html);
    if (!parsed.ok) return staleOpenCodeServer(parsed.note, workspaceId);
    if (!parsed.complete) {
      return {
        source: "opencode",
        ...parsed,
        workspaceId,
        capturedAt: new Date().toISOString(),
        cacheHit: false,
        cachePartial: true,
      };
    }
    const output = { source: "opencode", ...parsed, workspaceId, capturedAt: new Date().toISOString(), cacheHit: false };
    writeJsonCache(OPENCODE_SERVER_CACHE_PATH, output);
    return output;
  } catch (error) {
    return staleOpenCodeServer(`opencode.ai web fallo: ${shortError(error)}`, workspaceId);
  }
}

async function collectOpenCodeUsage(quotaConfig = null, { ignoreCache = false, account = null } = {}) {
  const config = quotaConfig || loadQuotaConfig();
  const configEntry = account?.config || config?.opencode || {};
  const cachePath = account ? accountCachePath(account, "usage-cache") : OPENCODE_USAGE_CACHE_PATH;
  const liveDisabled = process.env.AI_USAGE_OPENCODE_LIVE === "0" || configEntry.liveCapture === false;
  const cacheMinutes = Number(process.env.OPENCODE_USAGE_CACHE_MINUTES ?? configEntry.liveCaptureCacheMinutes ?? 5);
  const usageRangeKey = `${state.view}|${state.since || ""}|${state.until || ""}`;
  const cached = readJsonCache(cachePath, Math.max(0, cacheMinutes) * 60000);
  if (cached?.usageRangeKey === usageRangeKey && (!ignoreCache || liveDisabled)) {
    return { ...cached, cacheHit: true };
  }
  if (liveDisabled) {
    const stale = readJsonSafe(cachePath);
    if (stale?.ok && stale.usageRangeKey === usageRangeKey) {
      return { ...stale, cacheHit: true, cacheStale: true, note: "OpenCode Go DB desactivado; usando cache local." };
    }
    return { source: "opencode", ok: false, disabled: true, note: "OpenCode Go DB desactivado." };
  }

  const dbPath = resolveOpenCodeDbPath();
  if (!existsSync(dbPath)) {
    return { source: "opencode", ok: false, unusable: true, reason: "not-installed", note: "No encuentro opencode.db; corre opencode al menos una vez." };
  }

  try {
    let rows;
    let dbGranularity;
    try {
      const messageColumns = await queryOpenCodeSessions(dbPath, "PRAGMA table_info(message)");
      if (!messageColumns.some((column) => column.name === "data")) throw new Error("message.data no disponible");
      const messageSql = "SELECT m.session_id, json_extract(m.data, '$.modelID') AS model_id, " +
        "COALESCE(json_extract(m.data, '$.cost'), 0) AS cost, " +
        "COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS tokens_input, " +
        "COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS tokens_output, " +
        "COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS tokens_reasoning, " +
        "COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS tokens_cache_read, " +
        "COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS tokens_cache_write, " +
        "COALESCE(json_extract(m.data, '$.time.created'), m.time_created) AS time_created " +
        "FROM message m WHERE json_extract(m.data, '$.role') = 'assistant' " +
        "AND (json_extract(m.data, '$.providerID') = 'opencode-go' " +
        "OR json_extract(m.data, '$.providerID') LIKE 'opencode-go:%') " +
        "ORDER BY time_created DESC";
      rows = await queryOpenCodeSessions(dbPath, messageSql);
      dbGranularity = "message";
    } catch {
      const columns = await queryOpenCodeSessions(dbPath, "PRAGMA table_info(session)");
      const hasReasoning = columns.some((column) => column.name === "tokens_reasoning");
      const reasoningColumn = hasReasoning ? "s.tokens_reasoning" : "0 AS tokens_reasoning";
      const sessionSql = `SELECT s.id AS session_id, s.model, s.cost, s.tokens_input, s.tokens_output, ${reasoningColumn}, s.tokens_cache_read, s.tokens_cache_write, s.time_created ` +
        "FROM session s WHERE json_extract(s.model, '$.providerID') = 'opencode-go' " +
        "OR json_extract(s.model, '$.providerID') LIKE 'opencode-go:%' " +
        "ORDER BY s.time_created DESC";
      rows = await queryOpenCodeSessions(dbPath, sessionSql);
      dbGranularity = "session";
    }
    const now = Date.now();
    const nowDate = new Date();
    const HOUR = 3600000;

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
    const usageStartMs = state.since ? Date.parse(`${state.since}T00:00:00Z`) : NaN;
    const untilStartMs = state.until ? Date.parse(`${state.until}T00:00:00Z`) : NaN;
    const usageEndMs = Number.isFinite(untilStartMs) ? untilStartMs + 86400000 : NaN;

    let cost5h = 0, costWeek = 0, costMonth = 0, totalCost = 0;
    let totalTokens = 0, totalInput = 0, totalOutput = 0, totalReasoning = 0, totalCacheRead = 0, totalCacheWrite = 0;
    const reasoningByModel = {};
    const usageSessions = new Set();
    let earliestIn5h = null;

    for (const row of rows) {
      const rawTimestamp = Number(row.time_created);
      const ts = rawTimestamp > 0 && rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
      const cost = Number(row.cost || 0);
      if (!Number.isFinite(ts)) continue;
      const input = Number(row.tokens_input || 0);
      const outputTokens = Number(row.tokens_output || 0);
      const reasoning = Number(row.tokens_reasoning || 0);
      const cacheRead = Number(row.tokens_cache_read || 0);
      const cacheWrite = Number(row.tokens_cache_write || 0);
      const inUsageRange = (!Number.isFinite(usageStartMs) || ts >= usageStartMs)
        && (!Number.isFinite(usageEndMs) || ts < usageEndMs);
      if (inUsageRange) {
        totalCost += cost;
        totalTokens += input + outputTokens + reasoning + cacheWrite;
        totalInput += input;
        totalOutput += outputTokens;
        totalReasoning += reasoning;
        totalCacheRead += cacheRead;
        totalCacheWrite += cacheWrite;
        if (row.session_id) usageSessions.add(String(row.session_id));
      }
      if (inUsageRange && reasoning > 0) {
        try {
          const model = row.model_id
            ? { id: row.model_id }
            : typeof row.model === "string" ? JSON.parse(row.model) : row.model;
          const modelId = String(model?.id || "").toLowerCase();
          if (modelId) reasoningByModel[modelId] = Number(reasoningByModel[modelId] || 0) + reasoning;
        } catch {
          // Keep the provider total even if an older row has malformed model metadata.
        }
      }

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
        totalReasoning: totalReasoning,
        reasoningByModel: reasoningByModel,
        totalCacheRead: totalCacheRead,
        totalCacheWrite: totalCacheWrite,
        sessionCount: usageSessions.size,
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
      usageRangeKey,
      dbGranularity,
      cacheHit: false,
      note: "Estimado local (opencode.db). Para valores exactos ve a opencode.ai/auth.",
    };
    writeJsonCache(cachePath, output);
    return output;
  } catch (error) {
    const stale = readJsonSafe(cachePath);
    if (stale?.ok && stale.usageRangeKey === usageRangeKey) {
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
  for (const command of ["antigravity", "agy"]) {
    if (!commandExists(command)) continue;
    try {
      const output = execFileSync(command, ["models"], {
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      // Try the other supported binary name.
    }
  }
  return [];
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
    if (input.startsWith("\x1b[C", i)) {
      handleKey("\x1b[C");
      i += 2;
      continue;
    }
    if (input.startsWith("\x1b[D", i)) {
      handleKey("\x1b[D");
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
  else if (key === "g") setSource("gemini");
  else if (key === "v") setSource("gemini"); // alias historico de Antigravity
  else if (key === "m") setSource("minimax");
  else if (key === "o") setSource("opencode");
  else if (key === "h") onHideToggle();
  else if (key === "H") onRevealToggle();
  else if (key === "\x1b[A") onArrow("up");
  else if (key === "\x1b[B") onArrow("down");
  else if (key === "\x1b[C") onArrow("right");
  else if (key === "\x1b[D") onArrow("left");
  else if (key === "\r" || key === "\n") onEnter();
  else if (key === "\x1b") onBack();
}

function onArrow(dir) {
  if (state.tab === "consumo") {
    if (dir === "up") moveModel(-1);
    else if (dir === "down") moveModel(1);
    return;
  }
  // Cuotas: en detalle, arriba/abajo mueven el cursor de modelo; izq/der cambian de tarjeta.
  if (state.detail) {
    if (dir === "up") moveDetailModel(-1);
    else if (dir === "down") moveDetailModel(1);
    else moveCard(dir === "left" ? -1 : 1);
    return;
  }
  // Grid: flechas mueven la tarjeta seleccionada (dentro del set VISIBLE).
  if (dir === "up" || dir === "left") moveCard(-1);
  else moveCard(1);
}

function quotaCardRowLabel(window) {
  const type = String(window?.windowType || window?.key || "").toLowerCase();
  if (type === "session" || type === "5h" || type === "five_hour") return "5 horas";
  if (type === "weekly" || type === "sem" || type === "seven_day" || type === "week_all") return "semanal";
  return String(window?.label || window?.key || "cuota");
}

function quotaCardResetLabel(window, quota = null) {
  const direct = window?.reset ?? window?.resetAt ?? null;
  if (direct) {
    const countdown = fmtCountdown(direct);
    if (countdown !== "--") return `↻${countdown}`;
  }
  if (Number.isFinite(Number(window?.resetInSeconds))) {
    return `↻${fmtCountdown(new Date(Date.now() + Number(window.resetInSeconds) * 1000))}`;
  }
  if (window?.resetText) {
    const compact = String(window.resetText)
      .replace(/^resets?\s+(?:in|at)\s+/i, "")
      .trim();
    return `↻${shortText(compact || "--", 7)}`;
  }
  const fallback = quota?.resetAt ?? null;
  return fallback ? `↻${fmtCountdown(fallback)}` : "↻--";
}

function quotaAccountEntries(provider, quota) {
  if (Array.isArray(quota?.accounts) && quota.accounts.length) {
    return quota.accounts.map((entry, index) => ({
      account: String(entry.accountId || `cuenta${index + 1}`),
      quota: entry.quota || { ok: false, note: entry.health?.detail || "sin datos" },
    }));
  }
  if (!quota?.accounts || !Array.isArray(quota.windows)) return [];
  const groups = new Map();
  for (const window of quota.windows) {
    const account = String(window.family || window.account || "cuenta").trim() || "cuenta";
    if (!groups.has(account)) groups.set(account, []);
    groups.get(account).push(window);
  }
  return [...groups].map(([account, windows]) => ({ account, quota: { ...quota, windows } }));
}

// Convierte el snapshot tecnico en el modelo visual: una tarjeta por licencia/cuenta.
function buildQuotaCards(quotas = {}) {
  const cards = [];
  for (const provider of PROVIDER_ORDER) {
    const quota = quotas[provider];
    const entries = provider === "claude" || provider === "gemini"
      ? quotaAccountEntries(provider, quota)
      : [];
    if (!entries.length) {
      cards.push({ id: provider, provider, title: PROVIDER_META[provider]?.label || provider, quota });
      continue;
    }
    for (const { account, quota: accountQuota } of entries) {
      let rawWindows = Array.isArray(accountQuota?.windows) ? accountQuota.windows : [];
      if (provider === "claude") {
        const global = rawWindows.filter((window) => {
          const key = String(window.key || window.windowType || "").toLowerCase();
          return key === "session" || key === "5h" || key === "five_hour"
            || key === "week_all" || key === "weekly" || key === "seven_day";
        });
        if (global.length) rawWindows = global;
      }
      const windows = rawWindows.map((window) => ({
        ...window,
        label: quotaCardRowLabel(window),
        model: quotaCardRowLabel(window),
        family: null,
      }));
      const availability = conjunctiveQuotaAvailability(windows);
      const idPart = account.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "cuenta";
      cards.push({
        id: `${provider}:${idPart}`,
        provider,
        title: `${provider === "gemini" ? "Gemini" : "Claude"} · ${account}`,
        account,
        quota: {
          ...accountQuota,
          accounts: false,
          cardAccount: account,
          windows,
          ...(windows.length ? availability : {}),
        },
      });
    }
  }
  return cards;
}

function quotaCardHidden(card) {
  return displayConfig.hiddenProviders.includes(card.id)
    || displayConfig.hiddenProviders.includes(card.provider);
}

function visibleQuotaCards() {
  const cards = buildQuotaCards(state.lastSnapshot?.quotas || {});
  if (state.revealHidden) return cards;
  return cards.filter((card) =>
    isProviderVisible(card.provider, card.quota, displayConfig, false)
    && !quotaCardHidden(card));
}

function reconcileCardIndex() {
  const n = visibleQuotaCards().length;
  if (n === 0) { state.cardIndex = 0; return; }
  if (state.cardIndex > n - 1) state.cardIndex = n - 1;
  if (state.cardIndex < 0) state.cardIndex = 0;
}

// Lista aplanada de ventanas del detalle en el MISMO orden que las pinta drawQuotaDetail
// (familias por orden de insercion en Map), tras aplicar el filtro de modelos ocultos.
function detailWindowList(quota, provider) {
  const ws = (Array.isArray(quota?.windows) ? quota.windows : [])
    .filter((w) => isModelVisible(provider, w, displayConfig, state.revealHidden));
  if (!ws.some((w) => w.family)) return ws;
  const groups = new Map();
  for (const w of ws) {
    const fam = w.family || "default";
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(w);
  }
  return [...groups.values()].flat();
}

function moveCard(delta) {
  const order = visibleQuotaCards();
  const n = order.length;
  if (!n) return;
  state.cardIndex = (((state.cardIndex + delta) % n) + n) % n;
  state.detailModelIndex = 0; // cambiar de proveedor resetea el cursor de modelo
  render();
}

function moveDetailModel(delta) {
  const order = visibleQuotaCards();
  const card = order[state.cardIndex];
  const list = card ? detailWindowList(card.quota, card.provider) : [];
  if (!list.length) { state.detailModelIndex = 0; return; }
  state.detailModelIndex = Math.max(0, Math.min(list.length - 1, state.detailModelIndex + delta));
  render();
}

function onEnter() {
  if (state.tab !== "cuotas") return;
  state.detail = !state.detail;
  state.detailModelIndex = 0;
  render();
}

function onBack() {
  if (state.tab === "cuotas" && state.detail) {
    state.detail = false;
    render();
  }
}

function toggleTab() {
  const idx = TAB_KEYS.indexOf(state.tab);
  state.tab = TAB_KEYS[(idx + 1) % TAB_KEYS.length];
  state.detail = false;
  state.detailModelIndex = 0;
  render();
}

// h: oculta/muestra el proveedor seleccionado (grid) o el modelo seleccionado (detalle).
function onHideToggle() {
  if (state.tab !== "cuotas") return;
  const card = visibleQuotaCards()[state.cardIndex];
  if (!card) return;
  const provider = card.provider;
  if (state.detail) {
    const list = detailWindowList(card.quota, provider);
    const key = windowModelKey(provider, list[state.detailModelIndex]);
    if (!key) return;
    const i = displayConfig.hiddenModels.indexOf(key);
    if (i >= 0) displayConfig.hiddenModels.splice(i, 1);
    else displayConfig.hiddenModels.push(key);
    saveDisplayConfig();
    const newLen = detailWindowList(state.lastSnapshot?.quotas?.[provider], provider).length;
    if (state.detailModelIndex > newLen - 1) state.detailModelIndex = Math.max(0, newLen - 1);
  } else {
    const i = displayConfig.hiddenProviders.indexOf(card.id);
    if (i >= 0) displayConfig.hiddenProviders.splice(i, 1);
    else displayConfig.hiddenProviders.push(card.id);
    saveDisplayConfig();
    reconcileCardIndex();
    // No dejar el grid completamente vacio: si todo queda oculto, entra en modo "ver ocultos".
    if (!state.revealHidden && visibleQuotaCards().length === 0) state.revealHidden = true;
  }
  render();
}

// H: alterna el modo "ver ocultos" (revela tarjetas/modelos ocultos con marca, sin desocultarlos).
function onRevealToggle() {
  if (state.tab !== "cuotas") return;
  state.revealHidden = !state.revealHidden;
  reconcileCardIndex();
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
  const idx = visibleQuotaCards().findIndex((card) => card.provider === source);
  if (idx >= 0) {
    state.cardIndex = idx;
    state.detailModelIndex = 0; // cambiar de proveedor resetea el cursor de modelo del detalle
  }
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
  const title = `${colors.bold}${colors.cyan}AI Usage TUI${RESET} ${colors.gray}ccusage + Agy quota monitor${RESET}`;
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
    ? (state.detail
        ? `${colors.gray}\u2191\u2193 modelo \u00B7 \u2190\u2192 proveedor \u00B7 h ocultar \u00B7 H ver ocultos \u00B7 esc volver \u00B7 tab consumo \u00B7 q salir${RESET}`
        : `${colors.gray}\u2191\u2193\u2190\u2192 navegar \u00B7 enter detalle \u00B7 h ocultar \u00B7 H ver ocultos \u00B7 tab consumo \u00B7 r refrescar \u00B7 q salir${RESET}`)
    : `${colors.gray}\u2191\u2193\u2190\u2192 modelos \u00B7 1-5 vista \u00B7 a/c/x/v/m/o fuente \u00B7 tab cuotas \u00B7 r refrescar \u00B7 q salir${RESET}`;
  lines.push(fit(helpText, width));
  return lines.slice(0, height);
}

function drawQuotaTab(width, maxHeight, snap) {
  const quotas = (snap && snap.quotas) || {};
  const cards = visibleQuotaCards();
  const selected = cards[state.cardIndex] || cards[0];

  let lines;
  if (state.detail) {
    lines = selected ? drawQuotaDetail(width, selected.provider, selected.quota, selected.title) : [];
  } else {
    lines = drawQuotaGrid(width, maxHeight, quotas, cards, selected);
  }
  const cap = Math.max(1, Number(maxHeight) || 1);
  return lines.slice(0, cap);
}

function drawQuotaGrid(width, maxHeight, quotas, cards, selected) {
  const gap = 2;
  const targetW = 52; // tarjetas ~el doble de anchas; las columnas se adaptan al ancho
  const cols = Math.max(1, Math.floor((width + gap) / (targetW + gap)));
  const cardW = Math.max(30, Math.floor((width - (cols - 1) * gap) / cols));

  const hiddenCount = buildQuotaCards(quotas).filter(quotaCardHidden).length;
  const footer = hiddenCount > 0
    ? `${colors.gray}oculto: ${hiddenCount} · h gestiona · H ${state.revealHidden ? "vuelve a ocultar" : "revela"}${RESET}`
    : null;
  const rowCap = Math.max(1, (Number(maxHeight) || cards.length * 6) - (footer ? 1 : 0));

  const out = [];
  if (!cards.length) {
    out.push(fit(`${colors.gray} Todo oculto o no-usable. Pulsa H para revelar los proveedores ocultos.${RESET}`, width));
    return out;
  }

  const cardList = cards.map((card) =>
    renderQuotaCard(cardW, card.provider, card.quota, card.id === selected?.id, quotaCardHidden(card), card.title),
  );

  for (let i = 0; i < cardList.length; i += cols) {
    if (out.length >= rowCap) break;
    const rowCards = cardList.slice(i, i + cols);
    const maxH = Math.max(...rowCards.map((c) => c.length));
    for (let y = 0; y < maxH; y += 1) {
      if (out.length >= rowCap) break;
      const parts = rowCards.map((card) => {
        const line = card[y];
        if (line === undefined) return " ".repeat(cardW);
        const vl = visibleLength(line);
        if (vl < cardW) return line + " ".repeat(cardW - vl);
        if (vl > cardW) return truncateAnsi(line, cardW);
        return line;
      });
      out.push(fit(parts.join(" ".repeat(gap)), width));
    }
  }
  if (footer) out.push(fit(footer, width));
  return out;
}

// Multi-account providers need enough rows to identify every account. Keeping only three
// silently hid the fourth account even though its quota had been collected successfully.
function maxCardRows(quota) {
  return quota?.accounts ? 4 : 3;
}

function renderQuotaCard(cardW, provider, quota, selected, hidden = false, titleOverride = null) {
  const meta = PROVIDER_META[provider] || { label: provider, color: colors.gray, icon: "?" };
  const inner = Math.max(4, cardW - 2);
  const lines = [];
  // Resaltado = borde en bold+color del proveedor; sin seleccionar = borde gris.
  // El titulo siempre en el color del proveedor; el contenido en colores normales.
  // (Sin inverse: antes pintaba TODA la tarjeta seleccionada y se veia horrible.)
  const borderColor = selected ? `${colors.bold}${meta.color}` : colors.gray;

  const headPrefix = ` ${meta.icon} ${titleOverride || meta.label}${hidden ? " [oculto]" : ""} `;
  const headFill = Math.max(1, inner - visibleLength(headPrefix));
  lines.push(`${borderColor}\u250C${RESET}${meta.color}${headPrefix}${RESET}${borderColor}${"\u2500".repeat(headFill)}\u2510${RESET}`);

  const windows = quota && quota.ok !== false && Array.isArray(quota.windows)
    ? quota.windows.filter((w) => isModelVisible(provider, w, displayConfig, state.revealHidden))
    : [];
  const bodyLine = (content) =>
    `${borderColor}\u2502${RESET}${fit(content, inner)}${borderColor}\u2502${RESET}`;

  if (!quota || quota.ok === false || !windows.length) {
    const note = truncate(String(quota?.note || "sin datos"), Math.max(0, inner - 2));
    lines.push(bodyLine(` ${note} `));
  } else {
    const pctMax = 5;
    const shown = windows.filter((w) => !w.available).slice(0, maxCardRows(quota));
    // Primero se identifica la cuenta y despues se dibuja la barra. Antes el nombre tenia
    // apenas 8 columnas ("steven7.", "stevenv."), mientras la barra absorbia todo el resto.
    // Reservamos el ancho natural del nombre cuando cabe; la barra usa TODO el espacio que
    // queda despues de nombre y porcentaje, sin un tope fijo que deje media tarjeta vacia.
    const naturalLabelW = Math.max(0, ...shown.map((w) => visibleLength(String(w.label || w.key || ""))));
    const maxLabelW = Math.max(8, inner - pctMax - 4 - 5);
    const labelW = Math.min(18, maxLabelW, Math.max(10, naturalLabelW));
    const resetLabels = shown.map((w) => quotaCardResetLabel(w, quota));
    const resetW = Math.min(8, Math.max(4, ...resetLabels.map(visibleLength)));
    // Cada ventana lleva SU reset en la misma fila. La barra cede unas columnas para que
    // "5 horas" y "semanal" nunca compartan un unico countdown ambiguo en el pie.
    const barW = Math.max(5, inner - (labelW + resetW + pctMax + 5));
    for (const [index, w] of shown.entries()) {
      const label = truncate(String(w.label || w.key || ""), labelW).padEnd(labelW);
      const resetLabel = truncate(resetLabels[index], resetW).padEnd(resetW);
      if (w.remainingPercent === null || w.remainingPercent === undefined) {
        lines.push(bodyLine(` ${label} ${resetLabel} ? ${colors.gray}${truncate(String(w.status || "sin dato"), Math.max(6, barW + pctMax - 2))}${RESET} `));
        continue;
      }
      const pct = fmtPct(w.usedPercent);
      const bar = blockBar(w.usedPercent, barW, quotaColor(Number(w.remainingPercent)));
      const content = ` ${label} ${resetLabel} ${bar} ${pct.padStart(pctMax)} `;
      lines.push(bodyLine(content));
    }
  }

  let tag = "";
  const tagged = windows.find((w) => w.source === "web" || w.source === "server" || w.source === "local");
  if (tagged?.source) {
    tag = ` [${tagged.source}]`;
  } else {
    const family = windows.find((w) => w.family)?.family;
    if (family) tag = ` [${family}]`;
  }
  const rowCap = maxCardRows(quota);
  const more = windows.length > rowCap ? ` +${windows.length - rowCap} \u21B5` : "";
  const limitTag = quota?.limited ? ` [LIMITE${quota.limitedRetry ? ` ${quota.limitedRetry}` : ""}]` : "";
  const staleTag = quota?.stale ? " [viejo]" : "";
  const footContent = `${tag}${limitTag}${staleTag}${more}`.trim();
  if (footContent) lines.push(bodyLine(` ${footContent} `));

  lines.push(`${borderColor}\u2514${"\u2500".repeat(inner)}\u2518${RESET}`);
  return lines;
}

function drawQuotaDetail(width, provider, quota, titleOverride = null) {
  const meta = PROVIDER_META[provider] || { label: provider, color: colors.gray, icon: "?" };
  const lines = [];
  const noteRaw = quota?.note ? String(quota.note) : "";
  const titleLabel = titleOverride || meta.label;
  const maxNote = Math.max(0, width - titleLabel.length - 8);
  const noteSuffix = noteRaw ? ` \u2014 ${truncate(noteRaw, maxNote)}` : "";
  const title = ` ${meta.icon} ${titleLabel}${noteSuffix}`;
  lines.push(fit(`${colors.bold}${meta.color}${title}${RESET}`, width));
  lines.push(hr(width));

  if (!quota || quota.ok === false) {
    lines.push(fit(` ${colors.gray}${truncate(String(quota?.note || "sin datos"), Math.max(0, width - 2))}${RESET}`, width));
    return lines;
  }

  // Filtra modelos ocultos (en modo "ver ocultos" se muestran todos con marca).
  const allWindows = Array.isArray(quota.windows) ? quota.windows : [];
  const windows = allWindows.filter((w) => isModelVisible(provider, w, displayConfig, state.revealHidden));
  if (!windows.length) {
    lines.push(fit(` ${colors.gray}${truncate(String(quota.note || "sin datos"), Math.max(0, width - 2))}${RESET}`, width));
    return lines;
  }

  const barW = Math.max(8, Math.floor(width * 0.4));
  const hasFamily = windows.some((w) => w.family);
  const labelW = 28;
  // El cursor de modelo indexa la lista APLANADA en el mismo orden que se pinta (ver detailWindowList).
  let flatIdx = 0;
  const emit = (w) => {
    const selected = flatIdx === state.detailModelIndex;
    const hidden = state.revealHidden && displayConfig.hiddenModels.includes(windowModelKey(provider, w));
    flatIdx += 1;
    lines.push(fit(detailQuotaLine(w, barW, labelW, selected, hidden), width));
  };

  if (hasFamily) {
    const groups = new Map();
    for (const w of windows) {
      const fam = w.family || "default";
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam).push(w);
    }
    for (const fam of groups.keys()) { // Map: preserva orden de insercion (Gemini primero)
      const famLabel = fam === "gemini" ? "Gemini" : fam === "otros" ? "Otros" : fam;
      lines.push(fit(`${colors.bold}${colors.yellow} ${famLabel}${RESET}`, width));
      for (const w of groups.get(fam)) emit(w);
    }
  } else {
    for (const w of windows) emit(w);
  }

  return lines;
}

function detailQuotaLine(w, barW, labelW, selected = false, hidden = false) {
  const cur = selected ? `${colors.cyan}\u276F${RESET}` : " ";
  const tag = hidden ? ` ${colors.gray}[oculto]${RESET}` : "";
  const label = truncate(String(w.label || w.key || ""), labelW).padEnd(labelW);
  if (w.available) {
    return `${cur} ${label} ${colors.gray}\u2014 disponible (sin cuota expuesta por la API)${RESET}${tag}`;
  }
  const pct = fmtPct(w.usedPercent);
  const cd = w.reset ? fmtCountdown(w.reset) : (w.resetText ? shortText(w.resetText, 24) : "--");
  const bar = blockBar(w.usedPercent, barW, quotaColor(Number(w.remainingPercent)));
  return `${cur} ${label} ${bar} ${pct} usado  \u21BB ${cd}${tag}`;
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

  if (state.source === "gemini") {
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
  const reasoningTokens = total?.reasoningOutputTokens || 0;
  const cards = [
    card("Netos", fmtInt(effectiveTokens), "in+cacheCreate+out", cardWidth, colors.cyan),
    card("Cache leido", fmtInt(cacheReadTokens), cacheReadTokens ? `${((cacheReadTokens / Math.max(1, total?.totalTokens || 1)) * 100).toFixed(0)}% del total` : "sin cache", cardWidth, colors.gray),
    card("Coste est.", fmtMoney(total?.totalCost || 0), "no es factura oficial", cardWidth, colors.green),
    card("Salida", fmtInt(total?.outputTokens || 0), reasoningTokens ? `${fmtInt(reasoningTokens)} reasoning reportado` : "tokens output", cardWidth, colors.magenta),
    card("Latencia", `${snap.elapsedMs} ms`, "lectura local", cardWidth, colors.yellow),
  ];
  return zipCards(cards, width);
}

function sourceCards(width, snap) {
  const sources = ["claude", "codex", "gemini", "minimax", "opencode"];
  const max = Math.max(
    1,
    ...sources.map((source) => {
      if (source === "gemini") return snap.sources.antigravity?.modelSteps || 0;
      if (source === "opencode") return snap.sources.opencode?.data?.totalCost || 0;
      const totals = snap.sources[source]?.totals;
      return totals?.effectiveTokens ?? totals?.totalTokens ?? 0;
    }),
  );
  const gapWidth = (sources.length - 1) * 2;
  const cardWidth = Math.max(18, Math.floor((width - gapWidth) / sources.length));
  const cards = sources.map((source) => {
    const meta = SOURCE_META[source];
    if (source === "gemini") {
      const ag = snap.sources.antigravity;
      const body = [
        `${ag.installed ? "Agy OAuth" : "Agy no instalado"} | ${ag.sessions} sesiones`,
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
        `${colors.bold}Detalle:${RESET} ${selected.modelName} | netos ${fmtInt(effective)} | input ${fmtInt(selected.inputTokens)} | cache create ${fmtInt(selected.cacheCreationTokens)} | cache read ${fmtInt(selected.cacheReadTokens)} | output ${fmtInt(selected.outputTokens)} | reasoning ${fmtInt(selected.reasoningOutputTokens)} | coste ${fmtMoney(selected.cost)}`,
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
  rows.push(`Tokens netos: ${fmtInt(effective)} (in: ${fmtInt(usage.totals.inputTokens || 0)} out: ${fmtInt(usage.totals.outputTokens || 0)} reasoning: ${fmtInt(usage.totals.reasoningOutputTokens || 0)})`);
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
  if (state.source === "gemini") return [snap.sources.antigravity].filter(Boolean);
  return [snap.sources[state.source]].filter(Boolean);
}

function visibleModels() {
  const snap = state.lastSnapshot;
  if (!snap) return [];
  if (state.source === "all") return snap.sources.all?.models ?? [];
  if (state.source === "gemini") return snap.sources.antigravity?.models ?? [];
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
    const reasoningNote = usage.totals.reasoningOutputTokens ? ` reasoning=${fmtInt(usage.totals.reasoningOutputTokens)}` : "";
    lines.push(`${SOURCE_META[source].label.padEnd(8)} effective=${fmtInt(effective)}${cacheNote}${reasoningNote} total=${fmtInt(usage.totals.totalTokens)} cost=${fmtMoney(usage.totals.totalCost)} models=${usage.models.length}`);
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
          const reset = w.reset ? ` reset=${fmtReset(w.reset)}` : (w.resetText ? ` reset="${w.resetText}"` : "");
          const tag = w.source === "web" ? " [web]" : w.source === "server" ? " [server]" : " [local]";
          const amount = w.used != null ? `${fmtMoney(w.used)}/${fmtMoney(w.limit || 0)} ` : "";
          lines.push(`OpenCode Go ${w.label}: used=${amount}(${fmtPct(w.usedPercent)}) remaining=${fmtPct(w.remainingPercent)}${reset}${tag}`);
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

function fmtCountdown(date) {
  if (!date) return "--";
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return "--";
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "<1m";

  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function blockBar(usedPercent, width, color) {
  const size = Math.max(1, width);
  const pct = Number.isFinite(usedPercent) ? usedPercent : 0;
  const filled = Math.max(0, Math.min(size, Math.round((Math.max(0, Math.min(100, pct)) / 100) * size)));
  return `${color}${"█".repeat(filled)}${colors.gray}${"░".repeat(Math.max(0, size - filled))}${RESET}`;
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

function agentRound(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function agentIsoDate(value) {
  const date = dateFromProviderValue(value);
  return date ? date.toISOString() : null;
}

// Resumen estructurado de cuotas para consumo por agentes (MCP / --json).
// Aplana cada proveedor en {windows:[{usedPercent, remainingPercent, resetInSeconds, ...}]}
// para que un agente decida que proveedor/modelo usar segun disponibilidad.
function buildAgentQuotaSummary(snap) {
  const nowMs = Date.now();
  const out = {
    schemaVersion: 2,
    appVersion: APP_VERSION,
    capturedAt: new Date().toISOString(),
    since: snap?.since || null,
    providers: {},
  };
  const quotas = snap?.quotas || {};
  // Filtro de visibilidad (mismo que la TUI): oculta no-usables y los elegidos por el
  // usuario en quotas.json `display`. `AI_USAGE_SHOW_ALL=1` lo desactiva para agentes.
  const display = snap?.quotaConfig?.display || {};
  const showAll = /^(1|true|yes|on)$/i.test(String(process.env.AI_USAGE_SHOW_ALL || ""));
  for (const provider of ["claude", "codex", "gemini", "antigravity", "minimax", "opencode"]) {
    const quota = quotas[provider];
    if (!quota) continue;
    if (!showAll && !isProviderVisible(provider, quota, display)) continue;
    const windows = (Array.isArray(quota.windows) ? quota.windows : [])
      .filter((w) => showAll || isModelVisible(provider, w, display))
      .map((w) => {
      const resetValue = w.reset ?? w.resetAt ?? null;
      const resetDate = dateFromProviderValue(resetValue);
      const resetMs = resetDate ? resetDate.getTime() : NaN;
      const entry = {
        label: String(w.label || w.key || ""),
        usedPercent: agentRound(w.usedPercent),
        remainingPercent: agentRound(w.remainingPercent),
        resetInSeconds: Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null,
        resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      };
      for (const key of ["key", "rawLabel", "limitId", "sourceWindow", "windowType", "model", "limitText", "usedText", "accountId"]) {
        if (w[key] !== undefined && w[key] !== null && w[key] !== "") entry[key] = w[key];
      }
      if (typeof w.status === "string" && w.status) entry.status = w.status;
      for (const key of ["windowMinutes", "status", "used", "remaining", "limit"]) {
        if (w[key] === null || w[key] === undefined || w[key] === "") continue;
        const value = Number(w[key]);
        if (Number.isFinite(value)) entry[key] = value;
      }
      if (w.family) entry.family = w.family;
      if (w.source) entry.source = w.source;
      if (w.resetText) entry.resetText = w.resetText;
      if (w.available) entry.available = true;
      if (w.stale) entry.stale = true;
      return entry;
    });
    const inferredAvailable = windows.some((window) => {
      const remaining = finiteNumberOrNull(window.remainingPercent);
      return remaining !== null && remaining > 0;
    }) && !quota.limited;
    const directRemaining = finiteNumberOrNull(quota.remainingPercent);
    const directUsed = finiteNumberOrNull(quota.usedPercent);
    const scalarRemaining = directRemaining !== null
      ? directRemaining
      : directUsed !== null
        ? 100 - directUsed
        : null;
    const providerEntry = {
      ok: quota.ok !== false,
      available: typeof quota.available === "boolean"
        ? quota.available
        : quota.ok !== false && !quota.limited && (
            inferredAvailable
            || (String(quota.kind || "").startsWith("configured-") && scalarRemaining !== null && scalarRemaining > 0)
          ),
      kind: quota.kind || "unknown",
      windows,
      note: quota.note || "",
    };
    if (quota.plan) providerEntry.plan = quota.plan;
    if (quota.dataSource) providerEntry.source = quota.dataSource;
    if (finiteNumberOrNull(quota.effectiveRemainingPercent) !== null) {
      providerEntry.effectiveRemainingPercent = agentRound(quota.effectiveRemainingPercent);
    }
    if (Array.isArray(quota.limitingWindows) && quota.limitingWindows.length) {
      providerEntry.limitingWindows = quota.limitingWindows;
    }
    if (quota.incomplete) providerEntry.incomplete = true;
    if (Array.isArray(quota.missingWindows) && quota.missingWindows.length) {
      providerEntry.missingWindows = quota.missingWindows;
    }
    for (const key of ["availableGroups", "limitingGroups"]) {
      if (Array.isArray(quota[key]) && quota[key].length) providerEntry[key] = quota[key];
    }
    if (quota.stale) providerEntry.stale = true;
    if (quota.needsAuth) providerEntry.needsAuth = true;
    if (quota.limited) providerEntry.limited = true;
    if (quota.limitedRetry) providerEntry.limitedRetry = quota.limitedRetry;
    if (quota.detectedAt) providerEntry.detectedAt = agentIsoDate(quota.detectedAt);
    const observedAt = agentIsoDate(quota.observedAt || quota.detectedAt);
    if (observedAt) {
      providerEntry.observedAt = observedAt;
      providerEntry.ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(observedAt)) / 1000));
    }
    if (Array.isArray(quota.unavailableModels) && quota.unavailableModels.length) {
      providerEntry.unavailableModels = quota.unavailableModels;
    }
    if (Array.isArray(quota.offeredModels) && quota.offeredModels.length) {
      providerEntry.offeredModels = quota.offeredModels;
    }
    if (quota.resetCredits) {
      providerEntry.resetCredits = {
        availableCount: Number(quota.resetCredits.availableCount || 0),
        credits: (quota.resetCredits.credits || []).map((credit) => ({
          status: credit.status || "",
          resetType: credit.resetType || "",
          expiresAt: agentIsoDate(credit.expiresAt),
        })),
      };
    }
    if (Array.isArray(quota.creditsList) && quota.creditsList.length) {
      providerEntry.creditBalances = quota.creditsList.map((credit) => ({
        limitId: credit.limitId || "",
        planType: credit.planType || "",
        hasCredits: Boolean(credit.has_credits),
        unlimited: Boolean(credit.unlimited),
        balance: credit.balance == null ? null : String(credit.balance),
      }));
    }
    // Multi-cuenta: SOLO se emite cuando hay mas de una cuenta resuelta para el
    // proveedor (foldProviderAccounts las agrega en `quota.accounts` desde v-multiaccount).
    // Con 0 o 1 cuenta (el 100% del parque hoy, sin `accounts[]` en quotas.json) estos
    // campos quedan ausentes y el output es identico al de antes de esta funcionalidad:
    // el hook (min(remainingPercent) sobre providers[p].windows) y cualquier otro
    // consumidor viejo siguen funcionando sin cambios.
    if (Number(quota.accountCount) > 1 && Array.isArray(quota.accounts)) {
      providerEntry.accountCount = quota.accountCount;
      if (quota.selectedAccountId) providerEntry.selectedAccountId = quota.selectedAccountId;
      providerEntry.accounts = quota.accounts.map((entry) => {
        const accountQuota = entry.quota || {};
        const item = {
          id: entry.accountId,
          label: entry.label || entry.accountId,
          blocked: Boolean(entry.blocked),
          healthStatus: entry.healthStatus || null,
          ok: accountQuota.ok !== false,
          available: Boolean(accountQuota.available),
        };
        const remaining = finiteNumberOrNull(accountQuota.effectiveRemainingPercent);
        if (remaining !== null) item.effectiveRemainingPercent = agentRound(remaining);
        if (Array.isArray(accountQuota.availableGroups) && accountQuota.availableGroups.length) {
          item.availableGroups = accountQuota.availableGroups;
        }
        if (Array.isArray(accountQuota.limitingGroups) && accountQuota.limitingGroups.length) {
          item.limitingGroups = accountQuota.limitingGroups;
        }
        return item;
      });
    }
    // Errores de configuracion de cuentas (id duplicado, credencial invalida, proveedor
    // sin soporte multi-cuenta, etc.) — nunca credenciales, solo texto diagnostico.
    if (Array.isArray(quota.configErrors) && quota.configErrors.length) {
      providerEntry.configErrors = quota.configErrors;
    }
    out.providers[provider] = providerEntry;
  }
  return out;
}

// Punto de entrada para el servidor MCP: colecta un snapshot fresco (con live) y
// devuelve el resumen para agentes. Importable sin ejecutar el TUI (INVOKED_DIRECTLY).
async function runQuotaSnapshot() {
  if (!ccusageCommand) ccusageCommand = detectCcusage();
  const snap = await collectSnapshot({ includeLive: true });
  return buildAgentQuotaSummary(snap);
}

// Exports para pruebas unitarias y el servidor MCP (no se ejecuta main() al importar).
export {
  APP_VERSION,
  buildAgentQuotaSummary,
  runQuotaSnapshot,
  classifyProviderAvailability,
  isProviderVisible,
  windowModelKey,
  isModelVisible,
  quotaHasData,
  annotateUnusable,
  normalizeTotals,
  sumRows,
  extractModels,
  mergeModels,
  enrichUnifiedReasoning,
  buildCodexQuota,
  normalizeCodexRateLimitEntry,
  codexWindowLabel,
  parseCodexRetryTime,
  fmtTimeInTz,
  renderQuotaCard,
  buildClaudeQuota,
  buildGeminiQuota,
  buildMiniMaxQuota,
  buildOpenCodeQuota,
  buildAntigravityQuota,
  buildTokenQuota,
  parseOpenCodeServerUsage,
  parseResetDuration,
  parseClaudeResetText,
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
  fmtCountdown,
  blockBar,
  drawQuotaTab,
  PROVIDER_META,
  fmtMoney,
  fmtInt,
  fmtCompact,
  buildQuotaCards,
  resolveAccounts,
  resolveAllAccounts,
  foldProviderAccounts,
  aggregateAccountQuotas,
  selectAccountEntry,
  buildQuotaState,
  collectProviderAccountsLive,
  accountCachePath,
  accountEnv,
  inspectAccountCredential,
  DEFAULT_ACCOUNT_ID,
};

// Arranque real: recien aca, al final del modulo (ver comentario junto a INVOKED_DIRECTLY
// mas arriba), TODAS las const de nivel de modulo ya estan inicializadas.
if (INVOKED_DIRECTLY) {
  main().catch((error) => {
    cleanup();
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
