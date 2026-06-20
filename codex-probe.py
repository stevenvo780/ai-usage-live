#!/usr/bin/env python3
"""
codex-probe.py — sondea el estado de cuota de Codex en vivo.

Codex no expone una query de cuota gratis: su rate_limit solo viaja en la respuesta
del backend. Este probe corre `codex exec --json` con un prompt minimo y:
  - si Codex esta RATE-LIMITED -> el backend responde un error "usage limit" (RAPIDO y
    SIN gastar cuota) con la hora de reintento -> devolvemos {limited, retryText}.
  - si NO esta limitado -> Codex hace un turno y escribe rate_limits; lo leemos del
    stream o de la sesion mas nueva -> devolvemos {rate_limits}.
Mata el proceso apenas obtiene la señal (no espera el turno completo).

Salida: JSON en stdout. Env: CODEX_PROBE_TIMEOUT (default 25).
"""
import datetime
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
SESSIONS = os.path.join(HOME, ".codex", "sessions")


def find_rate_limits(obj):
    if isinstance(obj, dict):
        rl = obj.get("rate_limits")
        if isinstance(rl, dict):
            return rl
        for value in obj.values():
            found = find_rate_limits(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_rate_limits(value)
            if found:
                return found
    return None


def newest_session_rate_limits(since_ms):
    files = glob.glob(os.path.join(SESSIONS, "**", "*.jsonl"), recursive=True)
    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    for path in files[:6]:
        try:
            lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            rl = d.get("payload", {}).get("rate_limits") or d.get("rate_limits")
            if not (isinstance(rl, dict) and isinstance(rl.get("primary"), dict)):
                continue
            ts = d.get("timestamp", "")
            try:
                tms = datetime.datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").timestamp() * 1000
            except ValueError:
                tms = 0
            if tms >= since_ms:
                return rl
    return None


def kill_proc(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


def parse_output(text):
    # Busca el error de "usage limit" (caso limitado) o un rate_limits en el JSONL de --json.
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        blob = json.dumps(d)
        low = blob.lower()
        if "usage limit" in low or "rate limit" in low or "rate_limit_reached" in low:
            msg = d.get("message") or (d.get("error") or {}).get("message") or blob
            m = re.search(r"try again at\s+([0-9]{1,2}:[0-9]{2}\s*[AP]M)", msg, re.I)
            return {"ok": True, "limited": True, "retryText": (m.group(1).strip() if m else ""), "message": msg[:180]}
        rl = find_rate_limits(d)
        if rl:
            return {"ok": True, "limited": False, "rate_limits": rl}
    return None


def run():
    timeout = max(8, float(os.environ.get("CODEX_PROBE_TIMEOUT", "14")))
    since_ms = time.time() * 1000 - 3000
    try:
        proc = subprocess.Popen(
            ["codex", "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "responde solo: ok"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            start_new_session=True, cwd="/tmp",
        )
    except OSError as exc:
        return {"ok": False, "note": f"no pude lanzar codex: {exc}"}

    # communicate() lee TODO el stdout cuando el proceso sale. Si Codex esta LIMITADO,
    # el backend responde el error y codex SALE rapido -> obtenemos la salida completa
    # (con buffering resuelto). Si NO esta limitado, hace un turno largo -> timeout + kill.
    out = ""
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_proc(proc)
        try:
            out, _ = proc.communicate(timeout=4)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            out = out or ""
    finally:
        kill_proc(proc)

    parsed = parse_output(out or "")
    if parsed:
        return parsed

    # Si no salio del stream (codex escribio rate_limits solo a la sesion, o se mato por
    # timeout durante un turno), leemos la sesion mas nueva.
    rl = newest_session_rate_limits(since_ms)
    if rl:
        return {"ok": True, "limited": False, "rate_limits": rl}
    return {"ok": False, "note": "codex probe sin datos"}


def main():
    try:
        out = run()
    except Exception as exc:  # noqa: BLE001
        out = {"ok": False, "note": f"codex probe failed: {str(exc)[:160]}"}
    out["capturedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(json.dumps(out, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
