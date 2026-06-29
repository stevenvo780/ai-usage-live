#!/usr/bin/env python3
"""
test-antigravity-parse.py — tests unitarios del parser de /usage de Antigravity.

Cubre el formato NUEVO (agy >=1.0.13: barras "[███] NN.NN%" + linea de estado aparte) y el
VIEJO (inline "X% remaining · Refreshes in Y", back-compat). Uso: python3 test-antigravity-parse.py
"""
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("agy_capture", REPO / "antigravity-usage-capture.py")
agy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agy)

_failures = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# --- Formato NUEVO (agy 1.0.13): barra con % restante + linea de estado ---
NEW_FORMAT = """
└ Models & Quota

  Account: user@example.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%
    Refreshes in 100h 5m

  Five Hour Limit
    Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply.


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  │Within each group, models share a weekly limit and a 5-hour limit.
  ↑/↓ Scroll · pgup/pgdown Page · esc Close
"""

res = agy.parse(NEW_FORMAT)
check("nuevo: ok=True", res.get("ok") is True)
groups = {g["name"]: g for g in res.get("groups", [])}
check("nuevo: tiene grupo Gemini", "Gemini" in groups)
check("nuevo: tiene grupo Claude/GPT", "Claude/GPT" in groups)
check("nuevo: Gemini semanal 0% restante", (groups.get("Gemini", {}).get("weekly") or {}).get("remainingPercent") == 0)
check("nuevo: Gemini semanal refresh '100h 5m'", (groups.get("Gemini", {}).get("weekly") or {}).get("refreshText") == "100h 5m")
check("nuevo: Gemini 5h disabled -> None", groups.get("Gemini", {}).get("fiveHour") is None)
check("nuevo: Claude/GPT semanal 100% (Quota available, sin refresh)", (groups.get("Claude/GPT", {}).get("weekly") or {}).get("remainingPercent") == 100)
check("nuevo: Claude/GPT 5h 100% restante", (groups.get("Claude/GPT", {}).get("fiveHour") or {}).get("remainingPercent") == 100)

# --- Formato VIEJO (inline) sigue funcionando (back-compat) ---
OLD_FORMAT = """
GEMINI MODELS
  Models within this group: Gemini Flash

  Weekly Limit
    42% remaining · Refreshes in 50h 10m

  Five Hour Limit
    Quota available

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus

  Weekly Limit
    88% remaining · Refreshes in 12h

  Within each group, models share a weekly limit.
"""

res_old = agy.parse(OLD_FORMAT)
groups_old = {g["name"]: g for g in res_old.get("groups", [])}
check("viejo: ok=True", res_old.get("ok") is True)
check("viejo: Gemini semanal 42%", (groups_old.get("Gemini", {}).get("weekly") or {}).get("remainingPercent") == 42)
check("viejo: Gemini semanal refresh '50h 10m'", (groups_old.get("Gemini", {}).get("weekly") or {}).get("refreshText") == "50h 10m")
check("viejo: Gemini 5h Quota available -> 100%", (groups_old.get("Gemini", {}).get("fiveHour") or {}).get("remainingPercent") == 100)
check("viejo: Claude/GPT semanal 88%", (groups_old.get("Claude/GPT", {}).get("weekly") or {}).get("remainingPercent") == 88)

# --- Texto sin paneles -> ok:False ---
res_empty = agy.parse("Welcome to the Antigravity CLI.\n? for shortcuts\n")
check("vacio: ok=False", res_empty.get("ok") is False)

print()
if _failures:
    print(f"{len(_failures)} test(s) fallaron")
    sys.exit(1)
print("todos los tests OK")
