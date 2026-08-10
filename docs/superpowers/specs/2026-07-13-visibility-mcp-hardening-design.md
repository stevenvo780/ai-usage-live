# Diseño — Visibilidad de proveedores/modelos + endurecimiento MCP (v0.12.0)

> Fecha: 2026-07-13 · Rama: `agent/update-cli-quotas` · Fase 1 de 2.
> Fase 2 (fuera de este spec): partir `ai-usage-tui.mjs` en módulos.

## Problema

1. **Ruido en el listado.** La cuadrícula de cuotas, `--json` y el MCP siempre muestran los 6
   proveedores, incluso los que no están autenticados, no están instalados o no están configurados.
   Un CLI sin cuenta usable no aporta y ensucia la vista y la respuesta para agentes.
2. **Sin control de qué ver.** No se puede decir "no me muestres MiniMax" ni "oculta el modelo
   Sonnet de Claude". La selección de proveedores/modelos visibles no existe.
3. **MCP no está a prueba de todo.** El servidor serializa TODOS los mensajes en una sola cadena de
   promesas: un `tools/call` lento (que lanza CLIs en vivo) deja sin responder un `ping`/`initialize`
   posterior → riesgo de timeout del cliente. Falta cobertura de tests para ese y otros bordes.

## Objetivos

- Auto-ocultar proveedores **no-usables** (no autenticado / no instalado / no configurado /
  desactivado) manteniendo visibles los **agotados** (autenticados, al límite).
- Permitir ocultar/mostrar **proveedores** y **modelos** concretos, por config y por tecla en la TUI,
  persistido a `quotas.json`.
- Aplicar la visibilidad de forma **uniforme** a TUI, `--json` y MCP, con escape hatch para agentes.
- Dejar el MCP **correcto y robusto** (fast-path de protocolo, filtrado, tests).
- Mejoras de calidad acotadas: lógica de visibilidad en funciones puras testeadas; clasificación de
  disponibilidad **explícita** en vez de adivinar por strings de nota.

## No-objetivos (Fase 2)

- Partir el monolito `ai-usage-tui.mjs`. Se hará en un spec/fase separada.
- Añadir `hideExhausted` u otros filtros por umbral de porcentaje (se descartó en brainstorming).

## Diseño

### A. Configuración `display`

Nueva sección en `defaultQuotaConfig()` y por tanto en `quotas.json`:

```jsonc
"display": {
  "hideUnusable": true,        // auto-oculta no-auth / no-instalado / no-configurado / desactivado
  "hiddenProviders": [],       // proveedores ocultados a mano: ["minimax"]
  "hiddenModels": []           // modelos ocultados a mano: ["claude:sonnet", "antigravity:gpt"]
}
```

- `hideUnusable` default `true`. Es el único knob del auto-ocultamiento (no hay `hideExhausted`).
- `hiddenModels` usa el token estable `"<provider>:<modelKey>"`, donde `modelKey` se deriva de forma
  canónica desde el campo identificador de la ventana (`model` / `family` / `key` / `label`,
  normalizado a minúsculas y sin espacios). Lo define `windowModelKey(provider, window)`.

### B. Clasificación explícita de disponibilidad

Se agrega un flag explícito en los objetos de cuota para no depender de comparar strings de nota:

- En los sitios que ya devuelven `ok:false` por **no instalado / no configurado / desactivado**, se
  añade `unusable: true` y `reason: "not-installed" | "not-configured" | "disabled"`.
- `needsAuth: true` ya existe para el caso **no autenticado**.
- **Agotado** = autenticado y legible pero `available:false` / `limited` → NO lleva `unusable`.

Función pura `classifyProviderAvailability(quota)` → uno de:
`"unauthenticated" | "not-installed" | "not-configured" | "disabled" | "exhausted" | "error" | "available"`.

Regla derivada: el conjunto **auto-ocultable** = `{unauthenticated, not-installed, not-configured, disabled}`.

### C. Resolución de visibilidad (funciones puras)

```
isProviderVisible(provider, quota, display) -> boolean
  oculto si:
    - display.hiddenProviders incluye provider, o
    - display.hideUnusable && classifyProviderAvailability(quota) ∈ auto-ocultable
  (en modo "reveal hidden" de la TUI, se muestran todos con marca)

windowModelKey(provider, window) -> "provider:modelkey" | null
isModelVisible(provider, window, display) -> boolean
  oculto si display.hiddenModels incluye windowModelKey(provider, window)
```

Se aplican en tres consumidores:
- **Grid TUI** (`drawQuotaGrid`): filtra `PROVIDER_ORDER`; reconciliar `state.cardIndex` al set visible.
- **Detalle TUI** (`drawQuotaDetail`): filtra ventanas por `isModelVisible`; cursor de modelo.
- **Resumen para agentes** (`buildAgentQuotaSummary`, usado por `--json` y MCP): omite proveedores no
  visibles y ventanas de modelos ocultos. Escape hatch: `AI_USAGE_SHOW_ALL=1` desactiva el filtro.

### D. Interacción en la TUI

- **Grid:** `h` alterna ocultar/mostrar el **proveedor** seleccionado (`hiddenProviders`).
- **Detalle:** `↑/↓` mueven un cursor de modelo (`state.detailModelIndex`); `h` alterna ocultar/mostrar
  la **ventana/modelo** seleccionada (`hiddenModels`). El cursor respeta la rama agrupada por familia.
- **`H`** (shift-h): alterna modo "ver ocultos" — muestra los ocultos atenuados con marca `[oculto]`
  para poder des-ocultarlos.
- Pie de la cuadrícula: `oculto: N (h gestiona)` cuando hay ocultos.
- Cada cambio persiste con `saveDisplayConfig(display)`: lee `quotas.json`, reemplaza solo el bloque
  `display`, reescribe con `mode 0o600`. Nunca toca credenciales ni el resto de la config.

### E. Endurecimiento MCP

- **Fast-path de protocolo:** `initialize`, `tools/list` y `ping` se responden de inmediato, sin
  encolarse detrás de un `tools/call` en vuelo. Solo `tools/call` se serializa (evita doble spawn de
  CLIs). Elimina el riesgo de timeout del cliente.
- **Filtrado:** el output del MCP respeta la visibilidad (D/C), salvo `AI_USAGE_SHOW_ALL=1`.
- **Timeouts:** verificar que la colección por proveedor tenga timeout para que `tools/call` no
  cuelgue indefinidamente.
- Otras correcciones de robustez que surjan del audit adversarial (framing, error codes, batch, ids).

### F. Calidad (acotado, Fase 1)

- Funciones puras de visibilidad y clasificación, testeadas en `test-units.mjs`.
- Flags `unusable`/`reason` explícitos en los sitios `ok:false` correspondientes.
- MCP: fast-path + filtrado + tests en `test-mcp.mjs`.
- README: sección `display`, teclas `h`/`H`, filtrado del MCP y `AI_USAGE_SHOW_ALL`.

## Testing

- **Unit (`test-units.mjs`):** `classifyProviderAvailability` (cada rama), `isProviderVisible`
  (hiddenProviders, hideUnusable on/off, agotado permanece), `windowModelKey` (normalización),
  `isModelVisible`, `buildAgentQuotaSummary` con filtro y con `AI_USAGE_SHOW_ALL`.
- **MCP (`test-mcp.mjs`):** `ping` respondido mientras un `tools/call` está en vuelo; filtrado en
  output; método desconocido; request inválido; rechazo de argumentos; negociación de versión.
- **Integración:** `test-tui.py` sigue verde; `npm test` completo verde.
- **Verificación manual:** intercambio JSON-RPC real contra `ai-usage-mcp` (initialize → tools/call →
  ping intercalado) y arranque de la TUI.

## Riesgos

- `state.cardIndex` fuera de rango cuando el set visible se encoge → clamplear al filtrar.
- Persistencia: no clobberear secretos de `quotas.json`; escribir solo `display`, preservar el resto.
- Filtrar el MCP podría ocultar a un agente un proveedor que querría; mitigado por: solo se ocultan
  no-usables + los que el usuario elige explícitamente, más `AI_USAGE_SHOW_ALL=1`.
- Cursor de modelo en la rama agrupada por familia: el índice debe mapear al orden aplanado real.

## Entregable

Versión `0.12.0`. Cambios en `ai-usage-tui.mjs`, `ai-usage-mcp.mjs`, `test-units.mjs`, `test-mcp.mjs`,
`README.md`, `package.json` (version). Paquete `.deb` se regenera aparte si se decide publicar.
