# ai-usage-live

Terminal dashboard for local AI CLI usage — monitors Claude Code, Codex CLI, Antigravity, MiniMax, and OpenCode Go in a single btop-style TUI. (Note: Gemini CLI has been removed as Google revoked its OAuth).

## Features

- **Interactive card grid dashboard** with drill-down detailed view per provider (v0.8.0)
  - One card per provider (Claude, Codex, Antigravity, MiniMax, OpenCode) featuring provider icon, block mini-bars (% used) per window, and compact reset countdowns (e.g., `↻ 1h27m`, `↻ 23h54m`)
  - Detailed drill-down view with Antigravity grouping models by family (Gemini / Claude/GPT)
- **Real-time quota monitoring** for Claude, Codex, Antigravity, and MiniMax
- **Effective token counting** — separates cache-read tokens from real consumption so Claude usage isn't inflated by prompt caching (cache reads can be 97%+ of reported totalTokens)
- **Live quota detection** from `claude /usage` and real quota for Antigravity via CLI capture / Google's consumer API
- **Codex rate-limit detection** from local session events
- **Model-by-model breakdown** with sorting by effective tokens
- **Auto-refresh** with configurable interval

## Installation

### From .deb package

```bash
bash package-ai-usage-live.sh
sudo dpkg -i dist/ai-usage-live_0.10.0_all.deb
```

### Manual

```bash
# Requires Node.js 18+
chmod +x ai-usage-live ai-usage.sh ai-usage-quota
./ai-usage-live
```

## Commands

```bash
ai-usage-live                          # Interactive TUI
ai-usage-live --once                   # One-shot plain text summary
ai-usage-live --json                   # JSON output for scripts/agents
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
tab change tab
up/down/left/right navigate cards in the grid
enter open detailed view of selected provider
esc return to grid
c Claude, x Codex, v Antigravity, m MiniMax, o OpenCode (directly select provider card)
```

## MCP server

El proyecto incluye un servidor Model Context Protocol (MCP) llamado `ai-usage-mcp` (implementado en `ai-usage-mcp.mjs`). Es un servidor zero-dependency que funciona mediante stdio con JSON-RPC 2.0. Permite a agentes y modelos de IA consultar dinámicamente el estado y uso de las cuotas locales para decidir qué proveedor o modelo utilizar.

### Registro en el cliente

Para registrar el servidor MCP en clientes compatibles (como Claude Desktop o Claude Code), añade la configuración a tu archivo de settings correspondiente:

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "ai-usage-mcp"
    }
  }
}
```

O bien, usando la ruta absoluta al script en sistemas donde no esté el binario en el PATH global:

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "node",
      "args": ["/absolute/path/to/ai-usage-mcp.mjs"]
    }
  }
}
```

### Herramientas expuestas (Tools)

* **`get_ai_quotas`**: Retorna el uso y cuotas estructuradas de todos los proveedores configurados.
  - **Argumentos**: Sin argumentos (`{}`).
  - **Nota**: La primera llamada puede tardar unos segundos ya que realiza consultas en vivo a los CLIs/APIs de los proveedores (Claude, Codex, Antigravity, MiniMax, OpenCode Go). Las llamadas subsecuentes utilizan la caché local rápida.

### Ejemplo de respuesta JSON

```json
{
  "capturedAt": "2026-06-19T18:16:36.527Z",
  "since": "2026-06-19",
  "providers": {
    "claude": {
      "ok": true,
      "kind": "detected-percent",
      "windows": [
        {
          "label": "sesion",
          "usedPercent": 72,
          "remainingPercent": 28,
          "resetInSeconds": 3143,
          "resetAt": "2026-06-19T19:09:00.000Z",
          "resetText": "Jun 19, 7:09pm (UTC)"
        }
      ],
      "note": "Claude /usage desde cache local."
    },
    "codex": {
      "ok": true,
      "kind": "detected-percent",
      "windows": [
        {
          "label": "5h",
          "usedPercent": 100,
          "remainingPercent": 0,
          "resetInSeconds": 2820,
          "resetAt": "2026-06-19T19:03:37.000Z"
        }
      ],
      "note": "Rate limit detectado desde sesiones Codex."
    },
    "antigravity": {
      "ok": true,
      "kind": "detected-percent",
      "windows": [
        {
          "label": "5 horas",
          "usedPercent": 41,
          "remainingPercent": 59,
          "resetInSeconds": 3120,
          "resetAt": "2026-06-19T19:08:36.527Z",
          "family": "Gemini",
          "resetText": "52m"
        },
        {
          "label": "semanal",
          "usedPercent": 35,
          "remainingPercent": 65,
          "resetInSeconds": 299700,
          "resetAt": "2026-06-23T05:31:36.527Z",
          "family": "Claude/GPT",
          "resetText": "83h 15m"
        }
      ],
      "note": "Antigravity /usage (CLI, 2 grupos: Gemini + Claude/GPT)."
    },
    "minimax": {
      "ok": true,
      "kind": "detected-percent",
      "windows": [
        {
          "label": "general 5h",
          "usedPercent": 13,
          "remainingPercent": 87,
          "resetInSeconds": 6203,
          "resetAt": "2026-06-19T20:00:00.000Z"
        }
      ],
      "note": "MiniMax Coding Plan."
    },
    "opencode": {
      "ok": true,
      "kind": "detected-percent",
      "windows": [
        {
          "label": "5 horas",
          "usedPercent": 0,
          "remainingPercent": 100,
          "resetInSeconds": 18000,
          "resetAt": "2026-06-19T23:16:36.238Z",
          "source": "web",
          "resetText": "5 hours"
        }
      ],
      "note": "Cuota real (opencode.ai/auth)."
    }
  }
}
```

## Data sources

| Source | Method | Notes |
|---|---|---|
| Claude Code | `ccusage` local logs | Effective tokens = input + cacheCreate + output (excludes cache reads) |
| Claude quota | `claude -p /usage` | Reports session, weekly (all), weekly (Sonnet) percentages |
| Codex CLI | `ccusage` local logs + rate_limits from sessions | Rate limit detection (passive from sessions) + live probe (`codex-probe.py`, opt-in via `quotas.json`). Probe free when rate-limited; costs ~13K tokens when sounding. |
| Gemini CLI | (Removido) | Proveedor removido. Google revocó el OAuth de gemini-cli (`invalid_grant`). Antigravity es ahora la vía de acceso a los modelos Gemini. |
| Antigravity | Local transcript analysis + Cuota real automática (CLI + API fallback) | Es la vía de acceso a los modelos Gemini, Claude y GPT-OSS. Muestra cuota real de todos los modelos (Gemini Flash/Pro, Claude Opus, Claude Sonnet y GPT-OSS). Captura la cuota como fuente principal ejecutando el comando interactivo `/usage` del CLI `agy`/`antigravity` mediante el script `antigravity-usage-capture.py` (que automatiza el TUI vía pty y parsea su salida). Como fallback para Gemini, usa la API de Google Cloud Code (`cloudcode-pa retrieveUserQuota`). Consumo local derivado de transcripts locales. |
| MiniMax | Coding Plan API + local cache | Requires `MINIMAX_API_KEY` or `minimax.apiKey` in quota config |
| OpenCode Go | Cuota real vía scrape web autenticado + fallback override/local | Requires `opencode` installed with `opencode-go` provider. Soporta scrape web (cookie + workspaceId), override manual o estimado local. |

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
    "probe": false,
    "probeCacheMinutes": 15,
    "dailyTokens": null
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

Para **Antigravity**, la cuota real se obtiene automáticamente y no requiere configuración manual. Sin embargo, los campos `monthlyCredits`, `usedCredits` y `resetsAt` (con valores numéricos y formato ISO respectivamente) se pueden configurar opcionalmente en `quotas.json` como fallback si la captura de cuota real falla.

Set `AI_USAGE_ANTIGRAVITY_LIVE=0` to disable Antigravity live quota capture, and `AI_USAGE_ANTIGRAVITY_USAGE=0` to disable CLI capture (using API SDK only).

### Antigravity

Antigravity es la vía de acceso principal a los modelos Gemini, Claude (Opus, Sonnet) y GPT-OSS. Se renderiza en el dashboard y en la vista `--once` bajo la tarjeta/sección de Antigravity.

- **Cuota real de todos los modelos**: Muestra la cuota real de todos los modelos disponibles en Antigravity (no solo Gemini).
  - **Captura por CLI (Fuente Principal)**: Ejecuta de forma automática el comando interactivo `/usage` de la herramienta CLI `agy` o `antigravity`. Utiliza para ello el script `antigravity-usage-capture.py` (requiere que el CLI esté instalado y la sesión iniciada), el cual inicializa un pseudo-terminal (pty) para automatizar la interacción y parsear la salida.
  - **API SDK de Google (Fallback)**: Si la captura por CLI falla o está desactivada (`AI_USAGE_ANTIGRAVITY_USAGE=0`), se realiza un fallback a la API de Google Cloud Code (`cloudcode-pa retrieveUserQuota`), la cual solo reporta cuota para los modelos Gemini (URL: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`).
  - **Cuota manual**: Si ambas opciones fallan, se recurre a los valores de fallback manuales configurados en `antigravity.monthlyCredits`, `usedCredits` y `resetsAt` de `quotas.json`.
- **Agrupación de límites**: Las cuotas se consolidan en 2 grupos:
  - **Gemini**: Incluye Gemini Flash, Gemini Pro, etc.
  - **Claude/GPT**: Incluye Claude Opus, Claude Sonnet y GPT-OSS.
  - Cada uno de estos dos grupos dispone de límites específicos para ventanas de 5 horas y semanales, mostrando el porcentaje de uso actual y el tiempo restante de refresco.
- **Detalle en el Dashboard**: Al pulsar `Enter` sobre la tarjeta de Antigravity en la interfaz TUI, se abre la vista detallada agrupando por Gemini y Claude/GPT, listando los límites con barras de progreso y temporizadores de cuenta regresiva (countdown).
- **Consumo local**: El consumo interno de la sesión (sesiones individuales, pasos del modelo y timestamps de actividad) se sigue deduciendo del análisis de transcripts locales de Antigravity.

### Gemini CLI (Removido)

El soporte para Gemini CLI ha sido removido debido a que Google revocó el OAuth de gemini-cli (`invalid_grant`), inhabilitando la consulta directa de cuota. Antigravity es ahora la vía exclusiva para acceder y monitorear el consumo de los modelos Gemini.

### OpenCode Go — server-override

OpenCode Go no expone una API pública para leer la cuota real del servidor. Sin embargo, ahora es posible consultar la cuota real automáticamente mediante un scrape web autenticado del dashboard.

#### Cómo funciona el scrape web
- **Fetch**: Realiza peticiones HTTP GET a `https://opencode.ai/workspace/<workspaceId>/go` enviando la cookie de sesión `auth`.
- **User-Agent**: Se utiliza un User-Agent de navegador Chrome para evitar que Cloudflare bloquee la petición al detectarla como bot.
- **Parsing**: Parsea el HTML SSR del dashboard buscando los bloques de consumo (*Rolling/Weekly/Monthly Usage*) para extraer el porcentaje usado real y los tiempos de reset de cada período.
- **Caché**: Los datos obtenidos se almacenan en caché por 5 minutos.

#### Configuración en `quotas.json`
Edita la sección `opencode` en tu archivo `quotas.json` y agrega las siguientes claves:

```json
"opencode": {
  "cookie": "tu_valor_de_cookie_auth",
  "workspaceId": "wrk_xxx"
}
```

- **`cookie`**: El valor de la cookie `auth` de sesión de `opencode.ai`.
- **`workspaceId`**: El identificador de tu workspace (por ejemplo, `wrk_xxx`).

#### Cómo obtener la cookie
1. Inicia sesión en tu cuenta en [opencode.ai](https://opencode.ai) en el navegador.
2. Abre las herramientas de desarrollo (**F12** o clic derecho -> Inspeccionar).
3. Dirígete a la pestaña **Application** (Chrome/Edge) o **Almacenamiento** (Firefox) y expande la sección **Cookies** seleccionando `https://opencode.ai`.
4. Copia el valor del campo `auth`.

#### Precedencia de datos
El dashboard procesará las fuentes de datos según la siguiente prioridad:
1. **Scrape Web (`[web]`)**: Si se configuran `cookie` y `workspaceId` en `quotas.json` (y `AI_USAGE_OPENCODE_WEB` no está establecido en `0`), se mostrará la cuota real obtenida de la web.
2. **Server Override Manual**: Si el scrape no está disponible o falla, pero `serverOverride.enabled` está en `true`, se usarán los valores manuales de `quotas.json`.
3. **Estimado Local**: Si no hay datos web ni manuales, se utilizará la estimación local de consumo a partir del archivo de base de datos `opencode.db`.

#### Desactivación del Scrape Web
Puedes desactivar temporal o permanentemente el scrape web estableciendo la variable de entorno `AI_USAGE_OPENCODE_WEB=0`. Por defecto, su valor es `1`.

#### Nota de seguridad
La cookie es un secreto de sesión sensible:
- El comando `ai-usage-quota show` oculta/redacta el valor de la cookie automáticamente en pantalla.
- El archivo `quotas.json` se ubica fuera del repositorio (en `~/.config/ai-usage-live/`) y nunca debe ser añadido al control de versiones.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REFRESH_SEC` | `10` | Auto-refresh interval in seconds |
| `AI_USAGE_CLAUDE_LIVE` | `1` | Set to `0` to disable Claude /usage |
| `AI_USAGE_CODEX_PROBE` | `1` | Set to `0` to disable Codex live probe |
| `CODEX_PROBE_CACHE_MINUTES` | `15` | Codex probe cache duration |
| `CODEX_PROBE_TIMEOUT` | `16` | Timeout for Codex probe execution (in seconds) |
| `AI_USAGE_ANTIGRAVITY_USAGE` | `1` | Set to `0` to disable CLI capture, using API SDK only / Establece en `0` para desactivar la captura del CLI y usar solo la API SDK |
| `AI_USAGE_ANTIGRAVITY_LIVE` | `1` | Set to `0` to disable Antigravity live quota capture / Establece en `0` para desactivar la captura de cuota real de Antigravity |
| `ANTIGRAVITY_USAGE_CACHE_MINUTES` | `3` | Antigravity quota cache duration / Minutos de caché para la cuota de Antigravity (la captura `/usage` tarda ~4-5s) |
| `MINIMAX_API_KEY` | — | MiniMax Coding Plan API key |
| `AI_USAGE_MINIMAX_LIVE` | `1` | Set to `0` to disable MiniMax API capture |
| `MINIMAX_USAGE_CACHE_MINUTES` | `0` | MiniMax API cache duration |
| `AI_USAGE_MINIMAX_DEBUG` | — | Debug de captura MiniMax (boolean o ruta al archivo de log) |
| `MINIMAX_USAGE_URL` | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` | Override endpoint API de MiniMax |
| `AI_USAGE_OPENCODE_LIVE` | `1` | Set to `0` to disable OpenCode Go DB capture |
| `OPENCODE_USAGE_CACHE_MINUTES` | `5` | OpenCode Go DB cache duration |
| `AI_USAGE_OPENCODE_WEB` | `1` | Set to `0` to disable OpenCode Go web scraping / Establece en `0` para desactivar el scrape web de cuota de OpenCode Go |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for `ai-usage-live/quotas.json` and local caches |
| `AI_USAGE_GEMINI_LIVE` | `1` | *(Obsoleta/Removida)* Set to `0` to disable Gemini capture |
| `AI_USAGE_GEMINI_TIMEOUT` | `45` | *(Obsoleta/Removida)* Gemini capture timeout in seconds |
| `AI_USAGE_GEMINI_DEBUG_FILE` | — | *(Obsoleta/Removida)* Write raw Gemini capture output to file |

## License

MIT
