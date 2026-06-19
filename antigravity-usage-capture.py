#!/usr/bin/env python3
"""
antigravity-usage-capture.py — captura la cuota REAL de Antigravity desde el CLI
`agy`/`antigravity` ejecutando su comando interactivo `/usage`.

A diferencia de la API SDK (cloudcode-pa retrieveUserQuota, que solo expone los
modelos Gemini), el `/usage` del CLI muestra la cuota agrupada en GEMINI MODELS y
CLAUDE AND GPT MODELS, cada grupo con un limite semanal y uno de 5 horas.

Salida: JSON en stdout. Variables de entorno:
  AI_USAGE_ANTIGRAVITY_TIMEOUT   timeout en segundos (default 35)
  AI_USAGE_ANTIGRAVITY_DEBUG_FILE  vuelca el texto crudo capturado
"""
import json
import os
import pty
import signal
import re
import select
import struct
import sys
import time


def find_binary():
    for name in ("antigravity", "agy"):
        for d in os.environ.get("PATH", "").split(os.pathsep):
            p = os.path.join(d, name)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return name
    home = os.path.expanduser("~")
    for name in ("antigravity", "agy"):
        p = os.path.join(home, ".local", "bin", name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def clean(buf):
    s = buf.decode("utf-8", "replace")
    s = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", s)
    s = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", s)
    s = re.sub(r"\x1b[PX^_].*?\x1b\\", "", s, flags=re.S)
    s = re.sub(r"\x1b[\(\)][AB0]", "", s)
    s = re.sub(r"\x1b[=>]", "", s)
    return s


def parse(text):
    groups = []
    cur = None
    limit = None

    def new_group(name):
        for existing in groups:
            if existing["name"] == name:
                return existing  # reusar: si el panel se redibuja, actualiza el mismo grupo
        g = {"name": name, "models": "", "weekly": None, "fiveHour": None}
        groups.append(g)
        return g

    for raw in text.split("\n"):
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        up = s.upper()
        # Detener al llegar al texto de ayuda / footer del panel: evita que frases como
        # "...your weekly limit is tied to your tier" se confundan con la cabecera de seccion
        # y que fragmentos sueltos (re-render tras esc) sobrescriban valores ya parseados.
        if (low.startswith("within each group") or s.startswith("│")
                or low.startswith("↑/↓") or low.startswith("esc to")):
            cur = None
            limit = None
            continue
        if "GEMINI MODELS" in up:
            cur = new_group("Gemini")
            limit = None
            continue
        if "CLAUDE AND GPT MODELS" in up or "CLAUDE AND GPT" in up:
            cur = new_group("Claude/GPT")
            limit = None
            continue
        if cur is None:
            continue
        if low.startswith("models within this group:"):
            cur["models"] = s.split(":", 1)[1].strip()
            continue
        # Cabeceras de seccion EXACTAS (no la palabra suelta dentro del texto de ayuda).
        if low == "weekly limit":
            limit = "weekly"
            continue
        if low in ("five hour limit", "5 hour limit", "5-hour limit"):
            limit = "fiveHour"
            continue
        if limit:
            m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*remaining\b(?:.*?refreshes in\s*([0-9hmd ]+))?", s, re.I)
            if m:
                refresh = (m.group(2) or "").strip().rstrip("·").strip()
                cur[limit] = {"remainingPercent": round(float(m.group(1))), "refreshText": refresh}
                limit = None
                continue
            # "Quota available" / 100% solo es valido para el limite de 5h. El semanal
            # SIEMPRE muestra "X% remaining · Refreshes in Y", asi que un 100/placeholder
            # en weekly es un frame de carga -> se ignora y se espera el dato real.
            if limit == "fiveHour" and ("quota available" in low or re.search(r"\b100(?:\.0+)?\s*%", s)):
                cur[limit] = {"remainingPercent": 100, "refreshText": ""}
                limit = None
                continue

    groups = [g for g in groups if g.get("weekly") or g.get("fiveHour")]
    if not groups:
        return {"ok": False, "note": "No pude parsear /usage de Antigravity (formato cambiado o sin sesion)."}
    return {"ok": True, "groups": groups}


def run():
    binary = find_binary()
    if not binary:
        return {"ok": False, "note": "No encuentro el binario antigravity/agy."}
    timeout = max(15, int(float(os.environ.get("AI_USAGE_ANTIGRAVITY_TIMEOUT", "35"))))

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "120"
        os.environ["LINES"] = "44"
        os.execvp(binary, [binary])

    try:
        import fcntl
        import termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
    except Exception:
        pass

    buf = bytearray()
    start = time.monotonic()
    sent = False
    sent_at = None
    while time.monotonic() - start < timeout:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
        text = clean(buf)
        elapsed = time.monotonic() - start
        if not sent and ("for shortcuts" in text or "esc to" in text.lower() or elapsed > 9):
            os.write(fd, b"/usage\r")
            sent = True
            sent_at = time.monotonic()
        # Parsear el buffer en cada iteracion y romper solo cuando AMBOS grupos tienen
        # su limite semanal REAL (con "Refreshes in"); asi evitamos capturar el frame de
        # "Loading quota summary..." con placeholders. Fallback por si tarda demasiado.
        if sent and time.monotonic() - sent_at > 1.5:
            snap = parse(clean(buf))
            ready = {}
            if snap.get("ok"):
                for g in snap["groups"]:
                    wk = g.get("weekly") or {}
                    ready[g["name"]] = bool(wk.get("refreshText"))
            done = ready.get("Gemini") and ready.get("Claude/GPT")
            fallback = "GEMINI MODELS" in text.upper() and time.monotonic() - sent_at > 12
            if done or fallback:
                time.sleep(0.8)
                for _ in range(4):
                    r, _, _ = select.select([fd], [], [], 0.4)
                    if not r:
                        break
                    try:
                        buf.extend(os.read(fd, 65536))
                    except OSError:
                        break
                break

    try:
        os.write(fd, b"\x1b")  # cerrar panel
    except OSError:
        pass
    # Matar TODO el grupo de procesos (agy es un TUI Node que puede tener hijos):
    # killpg evita dejar procesos huerfanos (ppid=1) que se acumulan y cargan el sistema.
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

    text = clean(buf)
    debug = os.environ.get("AI_USAGE_ANTIGRAVITY_DEBUG_FILE")
    if debug:
        try:
            with open(debug, "w", encoding="utf-8") as handle:
                handle.write(text)
        except OSError:
            pass
    result = parse(text)
    if result.get("ok"):
        # Un grupo cargado SIEMPRE trae weekly con "Refreshes in". Si falta, fue una carga
        # parcial (placeholder): devolvemos ok:False para que el dashboard conserve el ultimo
        # dato bueno (cache) en vez de mostrar 100% falsos.
        incomplete = [g["name"] for g in result["groups"] if not ((g.get("weekly") or {}).get("refreshText"))]
        if incomplete:
            result = {"ok": False, "note": f"Carga parcial de /usage ({', '.join(incomplete)}); se conserva el dato anterior."}
    result["capturedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return result


def main():
    try:
        print(json.dumps(run(), ensure_ascii=True))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "note": f"Antigravity capture failed: {str(exc)[:160]}",
                          "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
