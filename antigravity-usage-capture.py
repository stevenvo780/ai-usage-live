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


def redact_sensitive(value):
    return re.sub(r"[\w.+-]+@[\w.-]+\.\w+", "account", str(value))


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
            # --- Formato viejo (inline): "X% remaining · Refreshes in Y" ---
            m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*remaining\b(?:.*?refreshes in\s*([0-9hmd ]+))?", s, re.I)
            if m:
                refresh = (m.group(2) or "").strip().rstrip("·").strip()
                cur[limit] = {"remainingPercent": round(float(m.group(1))), "refreshText": refresh}
                limit = None
                continue
            # --- Formato nuevo (agy >=1.0.13): la barra "[███...░░░] NN.NN%" da el % RESTANTE
            # y la linea de estado va aparte: "Refreshes in Y" | "Quota available" | "Disabled: ...".
            existing = cur.get(limit)
            if existing is None:
                mp = re.search(r"(\d+(?:\.\d+)?)\s*%", s)
                if mp:
                    cur[limit] = {"remainingPercent": round(float(mp.group(1))), "refreshText": ""}
                    continue  # la linea de estado (refresh) viene en la siguiente linea
                if "quota available" in low:  # cupo lleno sin barra (raro): 100% restante
                    cur[limit] = {"remainingPercent": 100, "refreshText": ""}
                    limit = None
                    continue
                if low.startswith("disabled"):  # 5h no aplica (semanal agotado): sin %, saltar
                    limit = None
                    continue
            else:
                # Ya tenemos el %; la linea de estado completa el refresh y cierra el limite.
                mr = re.search(r"refreshes?\s+in\s+([0-9hmd ]+)", low)
                if mr:
                    existing["refreshText"] = mr.group(1).strip().rstrip("·").strip()
                    limit = None
                    continue
                if "quota available" in low or low.startswith("disabled"):
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
        os.environ.setdefault("AGY_CLI_HIDE_ACCOUNT_INFO", "1")
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
    trust_done = False
    trust_at = None
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
        low = text.lower()
        elapsed = time.monotonic() - start
        # Antigravity CLI >=1.0.13 muestra "Do you trust the contents of this project?" ANTES del
        # prompt. Si no lo confirmamos, el menu se come el "/usage" (el \r elige "Yes" y el texto
        # se pierde) y el panel nunca aparece. Confirmamos "Yes, I trust this folder" (el default).
        if not trust_done and ("do you trust" in low or "i trust this folder" in low):
            os.write(fd, b"\r")
            trust_done = True
            trust_at = time.monotonic()
            continue
        # Aun no confirmado y el dialogo sigue visible -> NO disparar /usage por el fallback de
        # tiempo (lo consumiria el menu). Esperamos a confirmarlo arriba.
        trust_pending = (not trust_done) and ("do you trust" in low or "i trust this folder" in low)
        if not sent and not trust_pending and ("for shortcuts" in text or "esc to" in low or elapsed > 9):
            # Tras confirmar la confianza, dale un respiro para que cargue el prompt principal.
            if trust_at and time.monotonic() - trust_at < 1.0:
                continue
            os.write(fd, b"/usage\r")
            sent = True
            sent_at = time.monotonic()
        # El panel termino de dibujarse cuando aparece su PIE ("Within each group..." / "↑/↓
        # Scroll" / "esc Close"). Es el signal mas robusto y no depende del formato interno de
        # cada limite (que cambio en agy 1.0.13). Asi evitamos capturar un frame a medio cargar.
        # Fallback por si el pie no llega a tiempo.
        if sent and time.monotonic() - sent_at > 1.5:
            low_now = clean(buf).lower()
            panel_done = ("within each group" in low_now or "↑/↓ scroll" in low_now
                          or "esc close" in low_now)
            fallback = "gemini models" in low_now and time.monotonic() - sent_at > 12
            if panel_done or fallback:
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
                handle.write(redact_sensitive(text))
        except OSError:
            pass
    result = parse(text)
    if result.get("ok"):
        # Un grupo cargado trae su weekly con un % restante (la barra ya se dibujo). Si falta,
        # fue una carga parcial (placeholder): devolvemos ok:False para que el dashboard conserve
        # el ultimo dato bueno (cache) en vez de mostrar 100% falsos. Nota: a 100% el panel dice
        # "Quota available" SIN "Refreshes in", asi que ya no exigimos refreshText.
        incomplete = [g["name"] for g in result["groups"]
                      if not isinstance((g.get("weekly") or {}).get("remainingPercent"), (int, float))]
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
