# ai-usage-live

Dashboard de terminal para consultar consumo y cuotas de Claude Code, Codex CLI, Gemini CLI, Antigravity, MiniMax y OpenCode Go desde una sola TUI. La version actual es **0.12.0**.

## Funciones

- Panel interactivo tipo btop con una tarjeta y una vista detallada por proveedor.
- Consulta en vivo de las cuotas que expone cada CLI o servicio, con cache local y marca de frescura.
- Semantica de disponibilidad adaptada a cada empresa: ventanas obligatorias, familias o modelos alternativos y estados explicitos de limite.
- Auto-oculta los proveedores no-usables (sin autenticar, no instalados o no configurados) y permite ocultar/mostrar proveedores y modelos a mano; el filtro se aplica igual a la TUI, `--json` y el MCP.
- Consumo local por modelo y tokens efectivos mediante `ccusage`, con `reasoningOutputTokens` visible sin duplicarlo dentro de la salida de Codex.
- Salida `--json` y servidor MCP para que otros agentes puedan elegir un proveedor con capacidad real.
- Fallbacks locales o manuales cuando un proveedor no expone la cuota en vivo.

## Requisitos

- Node.js 18 o posterior.
- Python 3 para los capturadores interactivos de Codex, Gemini y Antigravity.
- `npm` y `sqlite3` para las fuentes locales y el paquete `.deb`.
- Los CLI de los proveedores que se quieran consultar, autenticados en la cuenta correspondiente.

## Instalacion

### Paquete Debian 0.12.0

```bash
bash package-ai-usage-live.sh
sudo dpkg -i dist/ai-usage-live_0.12.0_all.deb
```

El paquete instala `ai-usage-live`, `ai-usage`, `ai-usage-quota` y `ai-usage-mcp` en el `PATH`.

### Ejecucion desde el repositorio

```bash
chmod +x ai-usage-live ai-usage.sh ai-usage-quota
./ai-usage-live
```

## Comandos

```bash
ai-usage-live                       # TUI interactiva
ai-usage-live --once                # Resumen de texto una sola vez
ai-usage-live --json                # Cuotas JSON para scripts y agentes
ai-usage-live daily all --refresh 5 # Refresco cada 5 segundos
ai-usage-live daily antigravity     # Vista centrada en Antigravity
ai-usage daily                      # Resumen diario de ccusage
ai-usage claude blocks              # Bloques de Claude
ai-usage-quota show                 # Configuracion con secretos redactados
ai-usage-quota show-raw             # Configuracion completa
ai-usage-quota edit                 # Editar limites y credenciales
```

## Teclas de la TUI

```text
q salir
r refrescar y forzar consultas en vivo
tab cambiar de pestana
flechas navegar por la cuadricula (en el detalle, arriba/abajo mueven el cursor de modelo)
enter abrir el detalle del proveedor
esc volver a la cuadricula
c Claude, x Codex, g Gemini, v Antigravity, m MiniMax, o OpenCode
h ocultar/mostrar el proveedor (grid) o el modelo (detalle) seleccionado
H ver/gestionar los ocultos (revela con marca [oculto] para des-ocultarlos)
```

## Visibilidad de proveedores y modelos

`ai-usage-live` no lista lo que no podes usar. Un proveedor se **auto-oculta** cuando no tiene una cuenta usable: no autenticado (`needsAuth`), CLI/helper no instalado, o no configurado/suscrito. En cambio, un proveedor **agotado** (autenticado pero al limite) permanece visible, porque saber que esta sin cuota es informacion util. Un `disabled` (probe en vivo apagado por env/config) tampoco se oculta: no es "sin cuenta".

Ademas podes ocultar/mostrar a mano proveedores enteros o modelos concretos con la tecla `h`, y revisar los ocultos con `H`. La seleccion se guarda en `quotas.json` bajo `display` y persiste entre reinicios:

```json
{
  "display": {
    "hideUnusable": true,
    "hiddenProviders": ["minimax"],
    "hiddenModels": ["claude:week_opus", "antigravity:claude/gpt"]
  }
}
```

- `hideUnusable` (default `true`) activa el auto-ocultamiento de no-usables. Ponelo en `false` para ver siempre todos.
- `hiddenProviders` son ids de proveedor (`claude`, `codex`, `gemini`, `antigravity`, `minimax`, `opencode`).
- `hiddenModels` usa el token `"<proveedor>:<modelKey>"`, donde `modelKey` se deriva del modelo/familia/clave de la ventana (minusculas). La forma mas simple de agregarlo es pararte en la fila en el detalle y pulsar `h`.

El filtro se aplica de forma **uniforme** a la cuadricula, `--json` y el MCP `get_ai_quotas`. Para que un agente reciba el set completo sin filtrar, exporta `AI_USAGE_SHOW_ALL=1`.

## Disponibilidad por proveedor

`ai-usage-live` no aplica una sola regla de porcentajes a todos los servicios. Una ventana con `remainingPercent: 0` o un estado explicito de bloqueo puede hacer que el proveedor no este disponible aunque la captura haya terminado correctamente.

| Proveedor | Regla de disponibilidad |
|---|---|
| Claude | Las ventanas globales de sesion y semana para todos los modelos son conjuntivas: ambas deben conservar capacidad. Las ventanas especificas, como Sonnet o Fable, se muestran por separado y no sustituyen los limites globales. |
| Codex | Dentro de cada `limitId`, sus ventanas de 5 horas, semana y limite individual son conjuntivas. Los distintos `limitId` son rutas alternativas: basta uno disponible. Un `rateLimitReached` explicito invalida su grupo; los saldos o reinicios de credito se informan aparte. |
| Gemini | La cuota global diaria, si el CLI la publica, debe conservar capacidad y al menos un modelo debe estar disponible. Si solo se reciben cuotas por modelo, basta un modelo disponible. La falta de autenticacion produce `needsAuth`, no un falso 100% libre. |
| Antigravity | Cada familia, por ejemplo Gemini o Claude/GPT, combina de forma conjuntiva sus ventanas de 5 horas y semana. Las familias son alternativas: el proveedor sigue utilizable mientras al menos una familia lo este. |
| MiniMax | Las ventanas activas se agrupan por modelo. Los limites de un mismo modelo son conjuntivos y los modelos son alternativas. Los estados de plan no suscrito se excluyen y se publican en `unavailableModels`; los modelos de texto usan 5h/semana y los no textuales pueden usar ventana diaria. |
| OpenCode Go | `rollingUsage`, `weeklyUsage` y `monthlyUsage` son limites conjuntivos. Si cualquiera llega a 0% restante o el dashboard devuelve `rate-limited`, `blocked` o `exhausted`, OpenCode queda `available: false`. Esto evita marcarlo disponible solo porque la ventana rolling aun tenga cuota. |

`effectiveRemainingPercent` representa el cuello de botella dentro de una ruta conjuntiva o la mejor capacidad efectiva entre grupos alternativos. `limitingWindows`, `availableGroups`, `limitingGroups` y `unavailableModels` explican la decision cuando existen.

## Fuentes de datos

| Proveedor | Fuente principal | Fallback o datos adicionales |
|---|---|---|
| Claude Code | Captura interactiva de `claude /usage` | Logs locales de `ccusage`; tokens efectivos = input + cache creation + output, sin cache reads |
| Codex CLI | RPC `account/rateLimits/read` de `codex app-server` | Eventos `rate_limits` de sesiones locales; el antiguo `codex exec` solo queda como fallback opt-in |
| Gemini CLI | Captura de `/stats model` y `/model` mediante `gemini-quota-capture.py` | Limites diarios locales opcionales cuando el CLI no publica una cuota |
| Antigravity | Captura de `/usage` mediante `agy` o `antigravity` | API `cloudcode-pa retrieveUserQuota`, limites manuales y estadisticas de transcripts locales |
| MiniMax | `GET https://www.minimax.io/v1/token_plan/remains` | Ultimo cache valido o limite manual de creditos |
| OpenCode Go | Estado autenticado de `opencode.ai/workspace/<workspaceId>/go` | Override manual y estimacion local consultada con `opencode db`; `sqlite3` para CLI antiguos |

Las respuestas conservadas fuera de su periodo de cache se marcan con `stale: true` y mantienen `observedAt`/`ageSeconds`, en lugar de presentarse como una observacion nueva.

## Codex app-server

Codex moderno permite leer la cuenta y las cuotas sin iniciar una inferencia:

```text
codex app-server --listen stdio://
initialize
account/rateLimits/read
```

`codex-probe.py` realiza ese intercambio JSON-RPC y normaliza `rateLimitsByLimitId`, ventanas primarias/secundarias, limites individuales, balances y creditos de reinicio. La consulta oficial esta activa por defecto con cache de 60 segundos.

El probe antiguo basado en `codex exec` puede consumir tokens y esta desactivado. Solo se habilita al establecer `codex.probe: true` en `quotas.json`; `AI_USAGE_CODEX_PROBE=0` permite bloquearlo incluso en ese caso.

## Gemini CLI

Gemini vuelve a ser un proveedor activo. El capturador abre el CLI en modo accesible, consulta `/stats model` y `/model`, y publica cuota global y por modelo cuando estan presentes. Si la sesion requiere autenticacion, ejecuta `gemini`, completa el inicio de sesion y vuelve a refrescar el dashboard.

Gemini CLI y los modelos Gemini de Antigravity se consideran proveedores independientes porque corresponden a sesiones y conjuntos de cuota distintos.

## OpenCode Go

OpenCode no ofrece un endpoint publico estable para la cuota Go, por lo que el dashboard lee el estado autenticado que usa su pagina de workspace. El parser prioriza los datos estructurados `rollingUsage`, `weeklyUsage` y `monthlyUsage`, incluido su campo `status`, y conserva un parser HTML como compatibilidad.

Configura en `~/.config/ai-usage-live/quotas.json`:

```json
{
  "opencode": {
    "cookie": "valor_de_la_cookie_auth",
    "workspaceId": "wrk_xxx"
  }
}
```

La cookie `auth` se obtiene desde el almacenamiento del sitio `opencode.ai` en las herramientas de desarrollo del navegador. Es un secreto de sesion: `ai-usage-quota show` lo redacta y el archivo de configuracion se crea con permisos privados; no debe incluirse en Git.

Precedencia de fuentes:

1. Cuota web autenticada, con rolling + semana + mes.
2. `serverOverride` manual cuando esta habilitado.
3. Estimacion de coste de las sesiones locales de `opencode-go`.

La ruta de la base se resuelve con `opencode db path`; `OPENCODE_DB_PATH` permite forzar otra ubicacion.

## Configuracion de cuotas v2

`ai-usage-quota edit` abre `~/.config/ai-usage-live/quotas.json`. La configuracion se fusiona con estos valores v2; los limites `null` no inventan capacidad:

```json
{
  "version": 2,
  "claude": {
    "liveUsage": true,
    "liveUsageCacheSeconds": 300,
    "fiveHourTokens": null,
    "weeklyTokens": null
  },
  "codex": {
    "liveUsage": true,
    "liveUsageCacheSeconds": 60,
    "useDetectedRateLimits": true,
    "probe": false,
    "probeCacheMinutes": 15,
    "dailyTokens": null
  },
  "gemini": {
    "liveCapture": true,
    "liveCaptureCacheMinutes": 15,
    "dailyTokens": null,
    "dailyRequests": null
  },
  "antigravity": {
    "liveCapture": true,
    "liveCaptureCacheMinutes": 3,
    "usageTimeoutSeconds": 40,
    "monthlyCredits": null,
    "usedCredits": null,
    "resetsAt": null
  },
  "minimax": {
    "liveCapture": true,
    "liveCaptureCacheMinutes": 0,
    "monthlyCredits": null,
    "resetsAt": null,
    "apiKey": null
  },
  "opencode": {
    "liveCapture": true,
    "liveCaptureCacheMinutes": 5,
    "fiveHourCost": 12,
    "weeklyCost": 30,
    "monthlyCost": 60,
    "apiKey": null,
    "cookie": null,
    "workspaceId": null,
    "serverOverride": {
      "enabled": false,
      "fiveHourUsed": null,
      "weeklyUsed": null,
      "monthlyUsed": null,
      "reset5h": null,
      "resetWeek": null,
      "resetMonth": null,
      "capturedAt": null
    }
  },
  "display": {
    "hideUnusable": true,
    "hiddenProviders": [],
    "hiddenModels": []
  }
}
```

Los campos manuales son fallbacks. No sustituyen una lectura en vivo valida salvo `opencode.serverOverride.enabled: true`. El bloque `display` controla la visibilidad (ver "Visibilidad de proveedores y modelos"); la TUI lo reescribe al usar `h`/`H` sin tocar el resto del archivo.

## Servidor MCP

`ai-usage-mcp` es un servidor Model Context Protocol sin dependencias externas que usa JSON-RPC 2.0 por stdio. Negocia MCP `2025-11-25` y `2025-06-18` (ambas versiones incluyen `outputSchema`/`structuredContent` y no usan batch). Los mensajes de protocolo (`initialize`, `tools/list`, `ping`) se responden de inmediato aunque un `get_ai_quotas` lento este consultando los CLIs; las llamadas concurrentes comparten una unica captura en vuelo.

El output respeta el filtro de visibilidad de `quotas.json` `display` (oculta proveedores no-usables o elegidos por el usuario). Exporta `AI_USAGE_SHOW_ALL=1` para recibir el set completo sin filtrar.

### Registro

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "ai-usage-mcp"
    }
  }
}
```

Desde el repositorio tambien se puede usar:

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "node",
      "args": ["/ruta/absoluta/ai-usage-mcp.mjs"]
    }
  }
}
```

### Tool `get_ai_quotas`

No recibe argumentos. Su resultado MCP contiene simultaneamente:

- `structuredContent`: objeto validable con `schemaVersion: 2`.
- `content`: representacion JSON de texto para clientes MCP antiguos.

Ejemplo abreviado de `structuredContent`:

```json
{
  "schemaVersion": 2,
  "appVersion": "0.12.0",
  "capturedAt": "2026-07-12T12:00:00.000Z",
  "providers": {
    "opencode": {
      "ok": true,
      "available": false,
      "limited": true,
      "kind": "detected-percent",
      "source": "opencode-web",
      "effectiveRemainingPercent": 0,
      "limitingWindows": ["mensual"],
      "windows": [
        {
          "label": "mensual",
          "status": "rate-limited",
          "usedPercent": 100,
          "remainingPercent": 0,
          "resetInSeconds": 86400,
          "resetAt": "2026-07-13T12:00:00.000Z"
        }
      ],
      "note": "LIMITE ALCANZADO (mensual)."
    }
  }
}
```

En el schema v2:

- `ok` indica que la fuente se pudo leer y normalizar.
- `available` indica que existe al menos una ruta utilizable segun las reglas del proveedor.
- `ok: true` y `available: false` es una respuesta valida cuando la cuenta esta agotada.
- `stale`, `observedAt` y `ageSeconds` indican la frescura de la observacion.
- `needsAuth` indica que el CLI requiere volver a autenticarse.

La primera llamada puede tardar porque consulta los CLI; las siguientes aprovechan los caches de cada proveedor.

## Variables de entorno

| Variable | Predeterminado | Descripcion |
|---|---|---|
| `REFRESH_SEC` | `10` | Intervalo de refresco de la TUI |
| `AI_USAGE_TZ` | zona del sistema | Zona IANA usada para mostrar reinicios |
| `AI_USAGE_SHOW_ALL` | sin valor | `1` desactiva el filtro de visibilidad en `--json` y el MCP (devuelve todos los proveedores) |
| `AI_USAGE_CLAUDE_LIVE` | `1` | `0` desactiva `claude /usage` |
| `AI_USAGE_CODEX_LIVE` | `1` | `0` desactiva la lectura oficial de Codex app-server |
| `CODEX_USAGE_CACHE_SECONDS` | `60` | Cache de cuotas de Codex app-server |
| `AI_USAGE_CODEX_PROBE` | `1` | `0` prohibe el fallback antiguo aunque `codex.probe` sea `true` |
| `CODEX_PROBE_TIMEOUT` | `16` | Timeout del helper de Codex en segundos |
| `AI_USAGE_GEMINI_LIVE` | `1` | `0` desactiva la captura de Gemini CLI |
| `AI_USAGE_GEMINI_TIMEOUT` | `45` | Timeout al ejecutar directamente el capturador de Gemini |
| `AI_USAGE_GEMINI_COMMAND` | `gemini --screen-reader` | Comando usado por el capturador de Gemini |
| `AI_USAGE_GEMINI_DEBUG_FILE` | sin valor | Guarda la salida cruda del capturador para diagnostico |
| `AI_USAGE_ANTIGRAVITY_LIVE` | `1` | `0` desactiva toda consulta de cuota Antigravity |
| `AI_USAGE_ANTIGRAVITY_USAGE` | `1` | `0` omite `/usage` y usa el fallback API |
| `ANTIGRAVITY_USAGE_CACHE_MINUTES` | `3` | Cache de la cuota Antigravity |
| `MINIMAX_API_KEY` | sin valor | Clave del MiniMax Token Plan; tambien admite `minimax.apiKey` |
| `AI_USAGE_MINIMAX_LIVE` | `1` | `0` desactiva la consulta MiniMax |
| `MINIMAX_USAGE_CACHE_MINUTES` | `0` | Cache de la consulta MiniMax |
| `MINIMAX_USAGE_URL` | `https://www.minimax.io/v1/token_plan/remains` | Override del endpoint MiniMax |
| `AI_USAGE_OPENCODE_LIVE` | `1` | `0` desactiva la lectura de sesiones OpenCode locales |
| `AI_USAGE_OPENCODE_WEB` | `1` | `0` desactiva la cuota web autenticada |
| `OPENCODE_USAGE_CACHE_MINUTES` | `5` | Cache de la cuota OpenCode |
| `OPENCODE_DB_PATH` | detectada por CLI | Fuerza la ruta de `opencode.db` |
| `XDG_CONFIG_HOME` | `~/.config` | Base de `ai-usage-live/quotas.json` y caches de configuracion |
| `XDG_DATA_HOME` | `~/.local/share` | Base alternativa para datos de los CLI |

## Por que "tokens efectivos"

Los cache reads pueden dominar `totalTokens`, aunque no representen contexto nuevo al mismo precio. El dashboard usa input + cache creation + output como consumo efectivo y muestra los cache reads por separado. En Codex, ccusage v20 publica reasoning como subconjunto de output, por lo que solo se muestra como metadato. OpenCode lo guarda fuera de output: en ese proveedor se agrega una vez desde la base local y se propaga al reporte unificado.

## Licencia

MIT
