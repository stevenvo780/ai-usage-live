#!/usr/bin/env python3
# Lee el snapshot JSON de ai-usage (stdin) y emite un bloque de contexto compacto
# para inyectar a Claude Code / OpenCode. Calidad-primero + reparto.
#
# ARREGLO 2026-08-14 (argos) — LA PROPIEDAD QUE FALTABA:
#   un numero que el sondeo NO pudo medir ahora mismo NO puede viajar bajo un titulo
#   que dice "EN VIVO" sin decir de cuando es. El agregador YA emite `stale` y
#   `ageSeconds`; el renderizador los tiraba.
#   Reglas: (1) todo saldo con edad > UMBRAL_RANCIO sale con la edad pegada;
#           (2) a un saldo rancio se le SUPRIME el "reset": ese ↻ se recalcula hacia
#               adelante y es inventado (visto: reset 2027-08-07 = ↻8728h);
#           (3) el sello de cabecera dice cuando corrio el AGREGADOR, no la edad de
#               cada dato — se etiqueta como tal para que no se lea como frescura;
#           (4) no se confia solo en el flag `stale`: si viene `ageSeconds` alto, basta.
import sys, json

# "gemini" (gemini-cli) removido: Google revoco su OAuth; Gemini se reporta via "antigravity".
NAMES = {"claude": "Claude", "codex": "Codex", "antigravity": "Antigravity",
         "minimax": "MiniMax", "opencode": "OpenCode"}

UMBRAL_RANCIO = 900  # 15 min: por encima de esto no es un saldo, es un recuerdo.


def fmt_reset(s):
    if not s or s < 0:
        return ""
    h = s // 3600
    m = (s % 3600) // 60
    return (f"{h}h{m:02d}m" if h else f"{m}m")


def fmt_edad(s):
    if s is None:
        return "?"
    d = s // 86400
    h = (s % 86400) // 3600
    m = (s % 3600) // 60
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m:02d}m"
    return f"{m}m"


def es_rancio(p):
    """No confiar solo en el flag: una edad alta basta, venga o no marcada."""
    edad = p.get("ageSeconds")
    if isinstance(edad, (int, float)) and edad > UMBRAL_RANCIO:
        return True, int(edad)
    if p.get("stale"):
        return True, (int(edad) if isinstance(edad, (int, float)) else None)
    return False, (int(edad) if isinstance(edad, (int, float)) else None)


try:
    d = json.load(sys.stdin)
except Exception:
    print("[SALDOS IA] (no disponibles ahora)")
    sys.exit(0)

provs = d.get("providers", {})
parts = []
hay_rancio = False

for k, nm in NAMES.items():
    p = provs.get(k)
    if not p or not p.get("ok"):
        parts.append(f"{nm}:?")
        continue
    # LIMITADO: el proveedor RECHAZA por tope alcanzado -> marcar AGOTADO (rutear alrededor).
    if p.get("limited"):
        retry = p.get("limitedRetry") or ""
        parts.append(f"{nm} AGOTADO" + (f"(reintentar {retry})" if retry else ""))
        continue
    ws = p.get("windows") or []
    if not ws:
        parts.append(f"{nm}:?")
        continue
    # ventana mas ajustada (menor remaining) = el limite que ata
    tight = min(ws, key=lambda w: (w.get("remainingPercent")
                                   if w.get("remainingPercent") is not None else 100))
    rem = tight.get("remainingPercent")
    used = tight.get("usedPercent")
    r = fmt_reset(tight.get("resetInSeconds"))

    rancio, edad = es_rancio(p)
    seg = f"{nm} {rem}%libre" if rem is not None else f"{nm} {used}%uso" if used is not None else f"{nm}:?"
    if rancio:
        hay_rancio = True
        # (1) la edad viaja pegada al numero; (2) el reset de una ventana rancia es inventado -> se suprime
        seg += f"[SIN MEDIR hace {fmt_edad(edad)}]"
    elif r:
        seg += f"(↻{r})"
    parts.append(seg)

cap = d.get("capturedAt", "")[11:16]
# (3) el sello es cuando corrio el agregador, NO la edad de cada dato.
print(f"<ai-quotas agregador-corrio={cap}UTC>")
titulo = "SALDOS IA" if hay_rancio else "SALDOS IA EN VIVO"
print(f"{titulo}: " + " | ".join(parts))
if hay_rancio:
    print("⚠️ [SIN MEDIR hace X] = el sondeo de ese proveedor FALLO y esto es el ultimo valor conocido, "
          "no un saldo actual. No rutees por ese numero: verifica con get_ai_quotas (mira ageSeconds) o "
          "trata al proveedor como caido. El sello de arriba es cuando corrio el agregador, no la edad del dato.")
print("POLITICA (siempre): da los MEJORES resultados, NO ahorres. Reparte el trabajo entre los proveedores con MAS saldo (variedad, no abuses de uno). Para lo dificil usa el mas capaz con saldo. Si uno se agota, cae al siguiente MAS CAPAZ (no al mas barato). En fan-outs grandes, distribuye entre varios. Solo baja calidad si la cuota OBLIGA.")
print("</ai-quotas>")
