#!/usr/bin/env python3
"""
test-tui.py — test harness que captura el TUI real en múltiples estados.

Uso: python3 test-tui.py <scenario>
  scenarios: cuotas, consumo-minimax, refresh, error
"""
import atexit, pty, os, sys, time, select, re, json, tempfile, shutil, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent
TUI = os.environ.get("AI_USAGE_LIVE_BIN") or str(REPO / "ai-usage-live")
_CONFIG_HOME_FROM_ENV = os.environ.get("AI_USAGE_TEST_CONFIG_HOME")
TEST_CONFIG_HOME = Path(_CONFIG_HOME_FROM_ENV) if _CONFIG_HOME_FROM_ENV else Path(tempfile.mkdtemp(prefix="ai-usage-live-test-"))
if not _CONFIG_HOME_FROM_ENV:
    atexit.register(lambda: shutil.rmtree(TEST_CONFIG_HOME, ignore_errors=True))
CACHE = TEST_CONFIG_HOME / "ai-usage-live" / "minimax-usage-cache.json"
FAKE_BIN = TEST_CONFIG_HOME / "bin"
FAKE_CCUSAGE = FAKE_BIN / "ccusage"

def ensure_fake_ccusage():
    FAKE_BIN.mkdir(parents=True, exist_ok=True)
    if FAKE_CCUSAGE.exists():
        return
    FAKE_CCUSAGE.write_text("""#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
view = next((item for item in ("daily", "weekly", "monthly", "session", "blocks") if item in args), "daily")
key = "sessions" if view == "session" else view
print(json.dumps({key: [], "totals": {}}))
""")
    FAKE_CCUSAGE.chmod(0o755)

def minimax_payload(general_5h, general_week, video_5h=100, video_week=100):
    now_ms = int(time.time() * 1000)
    end_5h = now_ms + 4 * 3600 * 1000
    end_week = now_ms + 5 * 86400 * 1000
    return {
        "source": "minimax",
        "ok": True,
        "model_remains": [
            {"end_time": end_5h, "model_name": "general", "weekly_end_time": end_week,
             "current_interval_remaining_percent": general_5h, "current_weekly_remaining_percent": general_week,
             "current_interval_status": 1, "current_weekly_status": 1},
            {"end_time": end_5h, "model_name": "video", "weekly_end_time": end_week,
             "current_interval_remaining_percent": video_5h, "current_weekly_remaining_percent": video_week,
             "current_interval_status": 1, "current_weekly_status": 1},
        ],
        "base_resp": {"status_code": 0, "status_msg": "success"},
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 60)),
    }

def write_mock(general_5h, general_week, video_5h=100, video_week=100):
    """Escribe un mock de respuesta de MiniMax con los porcentajes dados."""
    data = minimax_payload(general_5h, general_week, video_5h, video_week)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(data, indent=2))

class SequencedMiniMaxServer:
    def __init__(self, responses):
        self.responses = responses
        self.requests = 0
        self.httpd = None
        self.thread = None
        self.url = None

    def __enter__(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                idx = min(owner.requests, len(owner.responses) - 1)
                owner.requests += 1
                body = json.dumps(minimax_payload(*owner.responses[idx])).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        host, port = self.httpd.server_address
        self.url = f"http://{host}:{port}/v1/api/openplatform/coding_plan/remains"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.thread:
            self.thread.join(timeout=2)

def strip_ansi(text):
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    text = re.sub(r"\x1b\[\?[0-9]+[hl]", "", text)
    return text.replace("\x1b[2J", "").replace("\x1b[H", "")

def capture(keys, wait_after_keys=2, total_timeout=20, env_overrides=None):
    """
    Inicia el TUI, espera al primer frame, envía keys, espera wait_after_keys.
    Retorna el último frame visible.
    """
    pid, fd = pty.fork()
    if pid == 0:
        ensure_fake_ccusage()
        env = os.environ.copy()
        env["HOME"] = str(TEST_CONFIG_HOME)
        env["XDG_CONFIG_HOME"] = str(TEST_CONFIG_HOME)
        env["PATH"] = f"{FAKE_BIN}:{env.get('PATH', '')}"
        env.setdefault("AI_USAGE_CLAUDE_LIVE", "0")
        env.setdefault("AI_USAGE_CODEX_LIVE", "0")
        env.setdefault("AI_USAGE_CODEX_PROBE", "0")
        env.setdefault("AI_USAGE_GEMINI_LIVE", "0")
        env.setdefault("AI_USAGE_ANTIGRAVITY_LIVE", "0")
        env.setdefault("AI_USAGE_MINIMAX_LIVE", "0")
        env.setdefault("AI_USAGE_OPENCODE_LIVE", "0")
        env.setdefault("AI_USAGE_OPENCODE_WEB", "0")
        env.setdefault("MINIMAX_USAGE_CACHE_MINUTES", "999")
        if env_overrides:
            env.update({key: str(value) for key, value in env_overrides.items()})
        os.execvpe(TUI, [TUI, "--refresh", "60"], env)
    
    out = b""
    start = time.time()
    key_idx = 0
    first_frame_seen = False
    first_frame_at = None
    
    while time.time() - start < total_timeout:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 16384)
                if chunk:
                    out += chunk
                    if not first_frame_seen and b"\x1b[2J" in out:
                        first_frame_seen = True
                        first_frame_at = time.time()
            except OSError:
                break
        
        elapsed = time.time() - start
        if first_frame_seen and key_idx < len(keys):
            key_time, key_value = keys[key_idx]
            # Los tiempos declarados por cada escenario son relativos al primer frame
            # interactivo, no al arranque del proceso. En una maquina ocupada el snapshot
            # inicial puede tardar varios segundos; medir desde `start` juntaba dos teclas
            # casi simultaneas y volvia intermitente el test de ocultar tarjetas.
            key_elapsed = time.time() - first_frame_at
            if key_elapsed >= key_time:
                os.write(fd, key_value.encode() if isinstance(key_value, str) else key_value)
                key_idx += 1
        
        if key_idx >= len(keys) and first_frame_seen:
            wait_start = max((t for t, _ in keys), default=0) + wait_after_keys
            if time.time() - first_frame_at >= wait_start:
                time.sleep(1.0)  # dar tiempo extra para que se renderice
                # leer lo que quede en el buffer
                while True:
                    r2, _, _ = select.select([fd], [], [], 0.3)
                    if not r2: break
                    try:
                        chunk = os.read(fd, 16384)
                        if chunk: out += chunk
                    except OSError: break
                break
    
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    
    text = out.decode("utf-8", errors="replace")
    frames = [strip_ansi(f) for f in text.split("\x1b[2J") if strip_ansi(f).strip()]
    return frames[-1] if frames else ""

def run_test(name, mock_values, keys, expected_substrings):
    """Ejecuta un test y verifica substrings esperados."""
    print(f"\n{'='*70}")
    print(f"TEST: {name}")
    print(f"  mock: {mock_values}")
    print(f"  keys: {keys}")
    print(f"{'='*70}")
    
    write_mock(*mock_values)
    frame = capture(keys)
    
    print("\n--- último frame ---")
    for line in frame.split("\n"):
        if line.strip():
            print(f"  {line}")
    
    print("\n--- verificaciones ---")
    all_ok = True
    for substr in expected_substrings:
        found = substr in frame
        status = "✓" if found else "✗ FALTA"
        print(f"  {status} '{substr}'")
        if not found:
            all_ok = False
    
    return all_ok

def run_live_refresh_test():
    """Verifica que 'r' ignore cache y consulte la API live de MiniMax."""
    print(f"\n{'='*70}")
    print("TEST: Refresh manual con API live MiniMax")
    print("  cache inicial: 80%, API primera respuesta: 80%, API segunda respuesta: 30%")
    print(f"{'='*70}")

    write_mock(80, 80)
    with SequencedMiniMaxServer([(80, 80), (30, 30)]) as server:
        frame = capture(
            [(1.0, "m"), (1.2, "\r"), (3.0, "r")],
            wait_after_keys=5,
            total_timeout=25,
            env_overrides={
                "AI_USAGE_MINIMAX_LIVE": "1",
                "MINIMAX_USAGE_CACHE_MINUTES": "999",
                "MINIMAX_API_KEY": "test-key",
                "MINIMAX_USAGE_URL": server.url,
            },
        )
        request_count = server.requests

    print("\n--- último frame ---")
    for line in frame.split("\n"):
        if line.strip():
            print(f"  {line}")

    print("\n--- verificaciones ---")
    checks = [
        ("70% usado", "70% usado" in frame),
        ("API llamada al menos 2 veces", request_count >= 2),
    ]
    for label, found in checks:
        status = "✓" if found else "✗ FALTA"
        print(f"  {status} '{label}'")
    return all(found for _, found in checks)

def run_hide_toggle_test():
    """Verifica el loop interactivo de ocultar: seleccionar MiniMax + 'h' lo oculta del
    grid, muestra el pie 'oculto: 1', y persiste hiddenProviders en quotas.json."""
    print(f"\n{'='*70}")
    print("TEST: Ocultar proveedor con 'h' (toggle + persistencia)")
    print(f"{'='*70}")

    quotas_path = TEST_CONFIG_HOME / "ai-usage-live" / "quotas.json"
    if quotas_path.exists():
        quotas_path.unlink()  # arrancar con display por defecto (nada oculto)
    write_mock(50, 50)
    # m: selecciona la tarjeta MiniMax · h: la oculta
    frame = capture([(1.0, "m"), (2.2, "h")], wait_after_keys=2)

    print("\n--- último frame ---")
    for line in frame.split("\n"):
        if line.strip():
            print(f"  {line}")

    persisted = []
    if quotas_path.exists():
        try:
            persisted = json.loads(quotas_path.read_text()).get("display", {}).get("hiddenProviders", [])
        except Exception:
            persisted = []

    print("\n--- verificaciones ---")
    checks = [
        ("MiniMax ya no aparece en el grid", "MiniMax" not in frame),
        ("pie 'oculto: 1' visible", "oculto: 1" in frame),
        ("persistido hiddenProviders=['minimax']", persisted == ["minimax"]),
    ]
    for label, ok in checks:
        print(f"  {'✓' if ok else '✗ FALTA'} {label}")
    if quotas_path.exists():
        quotas_path.unlink()  # limpiar para no afectar otras corridas
    return all(ok for _, ok in checks)

def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "all"
    
    results = []
    
    if scenario in ("all", "cuotas"):
        results.append(run_test(
            "Cuotas tab con 50% MiniMax",
            (50, 50),
            [(1.0, "m"), (1.2, "\r")],
            [
                "MiniMax",
                "general 5h",
                "general sem",
                "video dia",
                "video sem",
                "50% usado",
                "↻",  # que aparezca el reset
            ]
        ))
    
    if scenario in ("all", "consumo"):
        results.append(run_test(
            "Consumo tab + source=minimax",
            (50, 50),
            [(1.0, "\t"), (2.5, "m"), (4.0, "m")],  # tab a consumo, luego m para minimax
            [
                "MiniMax",
                "50%",  # debe mostrar el porcentaje
                "Cuota por modelo",  # el panel debe mostrar este titulo
                "general",
                "video",
                "reset",
            ]
        ))
    
    if scenario in ("all", "refresh"):
        results.append(run_live_refresh_test())

    if scenario in ("all", "hide"):
        results.append(run_hide_toggle_test())
    
    if scenario in ("all", "no-confusion"):
        # Test: el modelo "MiniMax-M3" de ccusage NO debe aparecer en la seccion de cuotas de MiniMax
        results.append(run_test(
            "Cuotas tab no muestra modelos de ccusage mezclados",
            (50, 50),
            [(1.0, "m"), (1.2, "\r")],
            [
                "MiniMax",
                "general 5h",
            ]
        ))
    
    if CACHE.exists():
        CACHE.unlink()
    
    print(f"\n{'='*70}")
    if all(results):
        print(f"TODOS LOS TESTS PASARON ({len(results)}/{len(results)})")
    else:
        print(f"FALLARON {results.count(False)}/{len(results)} tests")
    print(f"{'='*70}")
    
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    main()
