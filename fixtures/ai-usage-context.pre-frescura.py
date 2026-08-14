#!/usr/bin/env python3
# Lee el snapshot JSON de ai-usage (stdin) y emite un bloque de contexto compacto
# para inyectar a Claude Code / OpenCode. Calidad-primero + reparto.
import sys, json
# "gemini" (gemini-cli) removido: Google revocó su OAuth; Gemini se reporta vía "antigravity".
NAMES={"claude":"Claude","codex":"Codex","antigravity":"Antigravity","minimax":"MiniMax","opencode":"OpenCode"}
def fmt_reset(s):
    if not s or s<0: return ""
    h=s//3600; m=(s%3600)//60
    return (f"{h}h{m:02d}m" if h else f"{m}m")
try:
    d=json.load(sys.stdin)
except Exception:
    print("[SALDOS IA] (no disponibles ahora)"); sys.exit(0)
provs=d.get("providers",{})
parts=[]
for k,nm in NAMES.items():
    p=provs.get(k)
    if not p or not p.get("ok"): parts.append(f"{nm}:?"); continue
    # LIMITADO: el proveedor RECHAZA por tope alcanzado -> marcar AGOTADO (rutear alrededor).
    if p.get("limited"):
        retry=p.get("limitedRetry") or ""
        parts.append(f"{nm} AGOTADO" + (f"(reintentar {retry})" if retry else "")); continue
    ws=p.get("windows") or []
    if not ws: parts.append(f"{nm}:?"); continue
    # ventana mas ajustada (menor remaining) = el limite que ata
    tight=min(ws,key=lambda w:(w.get("remainingPercent") if w.get("remainingPercent") is not None else 100))
    rem=tight.get("remainingPercent"); used=tight.get("usedPercent")
    r=fmt_reset(tight.get("resetInSeconds"))
    seg=f"{nm} {rem}%libre" if rem is not None else f"{nm} {used}%uso" if used is not None else f"{nm}:?"
    if p.get("stale"): seg+="[viejo]"
    if r: seg+=f"(↻{r})"
    parts.append(seg)
cap=d.get("capturedAt","")[11:16]
print(f"<ai-quotas capturado={cap}UTC>")
print("SALDOS IA EN VIVO: "+" | ".join(parts))
print("POLITICA (siempre): da los MEJORES resultados, NO ahorres. Reparte el trabajo entre los proveedores con MAS saldo (variedad, no abuses de uno). Para lo dificil usa el mas capaz con saldo. Si uno se agota, cae al siguiente MAS CAPAZ (no al mas barato). En fan-outs grandes, distribuye entre varios. Solo baja calidad si la cuota OBLIGA.")
print("</ai-quotas>")
