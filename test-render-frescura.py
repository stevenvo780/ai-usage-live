#!/usr/bin/env python3
"""Tests de propiedad del renderizador de saldos. Sin dependencias: python3 test_render.py

Fija la propiedad que faltaba: un saldo que el sondeo NO pudo medir no puede viajar
bajo un titulo "EN VIVO" sin su edad.

Trae control POSITIVO (rancio -> marca) y control NEGATIVO (fresco -> NO marca), porque
un test que solo comprueba el caso malo no distingue "detecta rancio" de "marca todo".
"""
import json
import subprocess
import sys
import os

AQUI = os.path.dirname(os.path.abspath(__file__))

# El renderizador a probar es parametrizable A PROPOSITO: cada contenedor tiene
# hoy su propia copia sin versionar de `ai-usage-context.py` y NO son el mismo
# programa (el de ws-personal desglosa por cuenta y llama "Gemini" a lo que aqui
# es "Antigravity"). Este fichero fija las PROPIEDADES que cualquier variante
# tiene que cumplir, asi que se puede apuntar a otra:
#   AI_USAGE_CONTEXT=/ruta/a/su/ai-usage-context.py python3 test-render-frescura.py
NUEVO = os.environ.get("AI_USAGE_CONTEXT") or (
    sys.argv[1] if len(sys.argv) > 1 else os.path.join(AQUI, "ai-usage-context.py")
)
# Fixture de regresion: la version ANTERIOR, que publicaba el dato rancio bajo el
# titulo "EN VIVO". Solo se usa en el diferencial (seccion 6); si no esta, se salta.
ORIG = os.path.join(AQUI, "fixtures", "ai-usage-context.pre-frescura.py")

fallos = []


def render(snapshot, script=NUEVO):
    r = subprocess.run([sys.executable, script], input=json.dumps(snapshot),
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, f"rc={r.returncode} stderr={r.stderr}"
    return r.stdout


def check(nombre, cond, detalle=""):
    print(("  ok   " if cond else "  FALLO") + f" {nombre}" + (f"  <- {detalle}" if not cond and detalle else ""))
    if not cond:
        fallos.append(nombre)


def prov(ok=True, edad=None, stale=None, libre=50, reset=3600):
    p = {"ok": ok, "windows": [{"remainingPercent": libre, "resetInSeconds": reset}]}
    if edad is not None:
        p["ageSeconds"] = edad
    if stale is not None:
        p["stale"] = stale
    return p


# ---------------------------------------------------------------- 1. CONTROL POSITIVO
# Snapshot REAL capturado en mi contenedor 2026-08-14T05:33:32Z (edades medidas, no inventadas).
print("\n1. CONTROL POSITIVO — snapshot real 05:33Z: claude 7d, codex 5d, antigravity/opencode vivos")
real = {
    "capturedAt": "2026-08-14T05:33:32.720Z",
    "providers": {
        "claude": {"ok": True, "available": True, "stale": True, "ageSeconds": 614482,
                   "windows": [{"remainingPercent": 77, "resetInSeconds": 30933927},
                               {"remainingPercent": 58, "resetInSeconds": 31422327}]},
        "codex": {"ok": True, "available": True, "stale": True, "ageSeconds": 510831,
                  "windows": [{"remainingPercent": 97, "resetInSeconds": 81221},
                              {"remainingPercent": 90, "resetInSeconds": 0}]},
        "antigravity": {"ok": True, "available": True, "ageSeconds": 1,
                        "windows": [{"remainingPercent": 100, "resetInSeconds": 86399}]},
        "opencode": {"ok": True, "available": True, "ageSeconds": 3,
                     "windows": [{"remainingPercent": 100, "resetInSeconds": 17997}]},
    },
}
out = render(real)
linea = [l for l in out.splitlines() if l.startswith("SALDOS")][0]
# 58 y no 77: se reporta la ventana MAS AJUSTADA (semanal), que es el limite que ata.
check("claude (7d) sale marcado con su edad", "Claude 58%libre[SIN MEDIR hace 7d2h]" in linea, linea)
check("codex (5d) sale marcado con su edad", "Codex 90%libre[SIN MEDIR hace 5d21h]" in linea, linea)
check("antigravity (1s) NO sale marcado", "Antigravity 100%libre(↻" in linea, linea)
check("opencode (3s) NO sale marcado", "OpenCode 100%libre(↻" in linea, linea)
check("el titulo NO dice 'EN VIVO' si hay algun rancio", "EN VIVO" not in linea, linea)
check("aparece la explicacion de que hacer con un rancio", "trata al proveedor como caido" in out)
check("el sello de cabecera se etiqueta como del agregador", "agregador-corrio=05:33UTC" in out)
check("el ↻ de una ventana rancia NO se imprime (era inventado)",
      "8592h" not in out and "↻8" not in out.split("Antigravity")[0], out.splitlines()[1])

# ---------------------------------------------------------------- 2. CONTROL NEGATIVO
print("\n2. CONTROL NEGATIVO — todo fresco: el instrumento NO debe marcar nada")
fresco = {"capturedAt": "2026-08-14T05:33:32.720Z",
          "providers": {k: prov(edad=2) for k in ("claude", "codex", "antigravity", "opencode")}}
out2 = render(fresco)
linea2 = [l for l in out2.splitlines() if l.startswith("SALDOS")][0]
check("con todo fresco NO aparece 'SIN MEDIR'", "SIN MEDIR" not in out2, linea2)
check("con todo fresco el titulo SI dice 'EN VIVO'", "SALDOS IA EN VIVO" in linea2, linea2)
check("con todo fresco NO aparece el aviso", "trata al proveedor como caido" not in out2)
check("con todo fresco SI se imprime el reset", "(↻1h00m)" in linea2, linea2)

# ---------------------------------------------------------------- 3. NO MEDIBLE vs RANCIO
print("\n3. 'no se pudo medir' (ok:false) sigue siendo ':?' y no se confunde con rancio")
nomed = {"capturedAt": "2026-08-14T05:33:32.720Z",
         "providers": {"claude": prov(ok=False), "codex": prov(edad=2)}}
out3 = render(nomed)
linea3 = [l for l in out3.splitlines() if l.startswith("SALDOS")][0]
check("ok:false -> 'Claude:?'", "Claude:?" in linea3, linea3)
check("ok:false NO inventa un porcentaje", "Claude 50" not in linea3, linea3)

# ---------------------------------------------------------------- 4. DEFENSA EN PROFUNDIDAD
print("\n4. edad alta SIN el flag `stale` -> igual se marca (no depender de un solo campo)")
sinflag = {"capturedAt": "2026-08-14T05:33:32.720Z",
           "providers": {"claude": prov(edad=90000)}}  # 25h, sin "stale"
linea4 = [l for l in render(sinflag).splitlines() if l.startswith("SALDOS")][0]
check("25h sin flag se marca igual", "[SIN MEDIR hace 1d1h]" in linea4, linea4)

print("\n5. borde del umbral (900s): 899s pasa, 901s se marca")
l899 = [l for l in render({"capturedAt": "x" * 16, "providers": {"claude": prov(edad=899)}}).splitlines() if l.startswith("SALDOS")][0]
l901 = [l for l in render({"capturedAt": "x" * 16, "providers": {"claude": prov(edad=901)}}).splitlines() if l.startswith("SALDOS")][0]
check("899s NO se marca", "SIN MEDIR" not in l899, l899)
check("901s SI se marca", "SIN MEDIR" in l901, l901)

# ---------------------------------------------------------------- 6. DIFERENCIAL vs ORIGINAL
print("\n6. DIFERENCIAL contra el renderizador original (evidencia, no asercion de diseño)")
if os.path.exists(ORIG):
    origout = [l for l in render(real, ORIG).splitlines() if l.startswith("SALDOS")][0]
    print(f"     ORIG:  {origout}")
    print(f"     NUEVO: {linea}")
    check("el original publica el dato de 7 dias bajo el titulo 'EN VIVO'", "EN VIVO" in origout, origout)
    check("el original NO dice la edad en ningun sitio", "7d" not in origout and "hace" not in origout, origout)
else:
    print("     (sin copia del original: se omite)")

print("\n" + ("=" * 60))
if fallos:
    print(f"FALLOS: {len(fallos)} -> " + "; ".join(fallos))
    sys.exit(1)
print("TODO VERDE")
