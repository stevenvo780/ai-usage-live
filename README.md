# ai-usage-live

Terminal dashboard for local AI CLI usage — monitors Claude Code, Codex CLI, Gemini CLI, Antigravity, MiniMax, and OpenCode Go in a single btop-style TUI.

## Features

- **Real-time quota monitoring** for Claude, Codex, Gemini, Antigravity, and MiniMax
- **Effective token counting** — separates cache-read tokens from real consumption so Claude usage isn't inflated by prompt caching (cache reads can be 97%+ of reported totalTokens)
- **Live quota detection** from `claude /usage` and `gemini /stats model`
- **Codex rate-limit detection** from local session events
- **Model-by-model breakdown** with sorting by effective tokens
- **Auto-refresh** with configurable interval

## Installation

### From .deb package

```bash
bash package-ai-usage-live.sh
sudo dpkg -i dist/ai-usage-live_0.5.5_all.deb
```

### Manual

```bash
# Requires Node.js 18+ and optionally Python 3 for Gemini quota capture
chmod +x ai-usage-live ai-usage.sh ai-usage-quota
./ai-usage-live
```

## Commands

```bash
ai-usage-live                          # Interactive TUI
ai-usage-live --once                   # One-shot plain text summary
ai-usage-live daily all --refresh 5    # Auto-refresh every 5s
ai-usage-live daily antigravity        # Focus on Antigravity
ai-usage daily                         # ccusage daily summary
ai-usage claude blocks                 # Claude blocks view
ai-usage-quota show                    # Show quota config with secrets redacted
ai-usage-quota show-raw                # Show raw quota config
ai-usage-quota edit                    # Edit quota limits
```

## TUI keys

```text
q exit
r refresh (forces live provider refresh)
1 daily, 2 weekly, 3 monthly, 4 session, 5 blocks
a all, c Claude, x Codex, g Gemini, v Antigravity, m MiniMax, o OpenCode
up/down select model
```

## Data sources

| Source | Method | Notes |
|---|---|---|
| Claude Code | `ccusage` local logs | Effective tokens = input + cacheCreate + output (excludes cache reads) |
| Claude quota | `claude -p /usage` | Reports session, weekly (all), weekly (Sonnet) percentages |
| Codex CLI | `ccusage` local logs + rate_limits from sessions | Auto-detects 5h and weekly windows |
| Gemini CLI | `ccusage` local logs | Cuota `/stats model` muerta por revocación OAuth (devuelve `authDead`). CLI sigue funcional para `ccusage` de consumo local. |
| Antigravity | Local transcript analysis + Cuota manual | Es la ruta a modelos Gemini. Cuota manual se define en `quotas.json`. Consumo (sesiones, pasos, actividad) se deriva de transcripts locales. |
| MiniMax | Coding Plan API + local cache | Requires `MINIMAX_API_KEY` or `minimax.apiKey` in quota config |
| OpenCode Go | Local opencode.db SQLite + configured limits | Requires `opencode` installed with `opencode-go` provider (or variants `opencode-go:*`). Set `opencode.serverOverride.enabled=true` to use exact web values |

## Why "effective tokens"?

Claude Code uses prompt caching aggressively. A typical session may show 918M `totalTokens`, but ~893M of those are **cache reads** — previously cached context being re-read at 90% discount. The actual new token consumption is only ~25M.

This dashboard shows **effective tokens** (input + cache creation + output) as the primary metric, with cache reads shown separately, so you get an accurate picture of your real consumption.

## Quota configuration

```bash
ai-usage-quota edit
```

Useful fields:

```json
{
  "version": 1,
  "notes": [],
  "claude": {
    "liveUsage": true,
    "liveUsageCacheSeconds": 300,
    "fiveHourTokens": null,
    "weeklyTokens": null
  },
  "codex": {
    "useDetectedRateLimits": true,
    "dailyTokens": null
  },
  "gemini": {
    "liveCapture": true,
    "liveCaptureCacheMinutes": 15,
    "dailyTokens": null,
    "dailyRequests": null
  },
  "antigravity": {
    "monthlyCredits": null,
    "usedCredits": null,
    "resetsAt": null
  },
  "minimax": {
    "liveCaptureCacheMinutes": 0,
    "monthlyCredits": null,
    "resetsAt": null,
    "apiKey": null
  },
  "opencode": {
    "liveCaptureCacheMinutes": 5,
    "fiveHourCost": 12,
    "weeklyCost": 30,
    "monthlyCost": 60,
    "apiKey": null,
    "serverOverride": {
      "enabled": false,
      "fiveHourUsed": null,
      "weeklyUsed": null,
      "monthlyUsed": null,
      "reset5h": null,
      "resetWeek": null,
      "resetMonth": null,
      "note": "Pega aqui los valores reales de opencode.ai/auth..."
    }
  }
}
```

Para **Antigravity**, es necesario configurar manualmente los campos `monthlyCredits`, `usedCredits` y `resetsAt` (con valores numéricos y formato ISO respectivamente) para que el dashboard muestre la barra de cuota.

Set `AI_USAGE_GEMINI_LIVE=0` or `"liveCapture": false` to disable Gemini CLI capture.

### Antigravity (Gemini)

Antigravity es ahora la ruta principal a los modelos Gemini, ya que Google lo expone vía Antigravity (y no vía CLI directo de manera estable). Se renderiza como "Antigravity (Gemini)" en los tabs de Cuotas y en la vista `--once`.

- **Cuota manual**: Al no haber una API de cuota estable expuesta localmente, la cuota es 100% manual. Se debe definir a través de los valores `antigravity.monthlyCredits`, `usedCredits` y `resetsAt` en `quotas.json`.
- **Consumo**: El consumo interno (sesiones, pasos del modelo y timestamps de actividad) se deriva analizando directamente los transcripts locales generados por Antigravity.

### OpenCode Go — server-override

OpenCode Go no expone una API publica para leer la cuota real del servidor. El TUI calcula un estimado desde `~/.local/share/opencode/opencode.db` que suele diferir del dashboard (los costes locales usan tarifas publicas, no las del plan Go).

Si querés ver los valores exactos que muestra `opencode.ai/auth`, pegalos manualmente en `quotas.json` bajo `opencode.serverOverride`:

```json
"serverOverride": {
  "enabled": true,
  "fiveHourUsed": 1.32,
  "weeklyUsed": 1.20,
  "monthlyUsed": 1.20,
  "reset5h": "2026-06-17T22:00:00Z",
  "resetWeek": "2026-06-22T00:00:00Z",
  "resetMonth": "2026-07-01T00:00:00Z"
}
```

Con `enabled=true` las barras de cuota se calculan desde `fiveHourUsed/weeklyUsed/monthlyUsed` en lugar del DB local. Cuando habilitás esta opción, el dashboard ahora muestra **TAMBIÉN el estimado local (tarifas públicas)** al lado de la cuota del servidor para que puedas comparar fácilmente.
Ejemplo: `estimado local (tarifa publica): 5h $1.58 sem $30.52 mes $30.52`.

Los campos `reset*` son opcionales (ISO 8601); si no los pasas, se usan los limites por defecto del plan. Ponelo en `enabled=false` para volver únicamente al estimado local.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REFRESH_SEC` | `10` | Auto-refresh interval in seconds |
| `AI_USAGE_CLAUDE_LIVE` | `1` | Set to `0` to disable Claude /usage |
| `AI_USAGE_GEMINI_LIVE` | `1` | Set to `0` to disable Gemini capture |
| `AI_USAGE_GEMINI_TIMEOUT` | `45` | Gemini capture timeout in seconds |
| `AI_USAGE_GEMINI_DEBUG_FILE` | — | Write raw Gemini capture output to file |
| `MINIMAX_API_KEY` | — | MiniMax Coding Plan API key |
| `AI_USAGE_MINIMAX_LIVE` | `1` | Set to `0` to disable MiniMax API capture |
| `MINIMAX_USAGE_CACHE_MINUTES` | `0` | MiniMax API cache duration |
| `AI_USAGE_MINIMAX_DEBUG` | — | Debug de captura MiniMax (boolean o ruta al archivo de log) |
| `MINIMAX_USAGE_URL` | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` | Override endpoint API de MiniMax |
| `AI_USAGE_OPENCODE_LIVE` | `1` | Set to `0` to disable OpenCode Go DB capture |
| `OPENCODE_USAGE_CACHE_MINUTES` | `5` | OpenCode Go DB cache duration |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for `ai-usage-live/quotas.json` and local caches |

## License

MIT
