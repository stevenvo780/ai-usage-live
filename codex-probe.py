#!/usr/bin/env python3
"""Read Codex account rate limits without starting a model turn.

The primary probe speaks the official newline-delimited app-server protocol:
``initialize``, ``initialized``, then ``account/rateLimits/read``. The older
``codex exec`` probe is available only when CODEX_ALLOW_EXEC_PROBE=1.

Output is one JSON object on stdout. CODEX_PROBE_TIMEOUT controls the timeout
in seconds (default: 14).
"""
import datetime
import glob
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time

HOME = os.path.expanduser("~")
# CODEX_HOME manda para que el aislamiento por cuenta tambien cubra el escaneo de
# sesiones: sin esto la cuenta B leeria los rate_limits cacheados de la cuenta A.
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
SESSIONS = os.path.join(CODEX_HOME, "sessions")

_KEY_ALIASES = {
    "rateLimits": "rate_limits",
    "rateLimitsByLimitId": "rate_limits_by_limit_id",
    "rateLimitResetCredits": "rate_limit_reset_credits",
    "rateLimitReachedType": "rate_limit_reached_type",
    "limitId": "limit_id",
    "limitName": "limit_name",
    "planType": "plan_type",
    "usedPercent": "used_percent",
    "resetsAt": "resets_at",
    "windowDurationMins": "window_minutes",
    "windowMinutes": "window_minutes",
    "hasCredits": "has_credits",
    "individualLimit": "individual_limit",
    "remainingPercent": "remaining_percent",
    "availableCount": "available_count",
    "grantedAt": "granted_at",
    "expiresAt": "expires_at",
    "resetType": "reset_type",
}


def _snake_key(key):
    if key in _KEY_ALIASES:
        return _KEY_ALIASES[key]
    first = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", key)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", first).lower()


def normalize_keys(value):
    """Recursively convert app-server camelCase keys to snake_case."""
    if isinstance(value, dict):
        return {_snake_key(str(key)): normalize_keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_keys(item) for item in value]
    return value


def parse_rpc_message(line):
    """Parse one app-server JSONL frame, ignoring log and blank lines."""
    if isinstance(line, bytes):
        line = line.decode("utf-8", errors="replace")
    line = str(line or "").strip()
    if not line:
        return None
    try:
        message = json.loads(line)
    except (TypeError, ValueError):
        return None
    return message if isinstance(message, dict) else None


def _limit_snapshots(rate_limits):
    if isinstance(rate_limits, dict):
        return [rate_limits]
    if isinstance(rate_limits, list):
        return [item for item in rate_limits if isinstance(item, dict)]
    return []


def _reached_types(normalized, snapshots):
    values = []
    top = normalized.get("rate_limit_reached_type")
    if isinstance(top, str) and top:
        values.append(top)
    elif isinstance(top, list):
        values.extend(item for item in top if isinstance(item, str) and item)
    for snapshot in snapshots:
        reached = snapshot.get("rate_limit_reached_type")
        if isinstance(reached, str) and reached:
            values.append(reached)
    return list(dict.fromkeys(values))


def _select_retry_epoch(snapshots, now):
    blocked = [
        item for item in snapshots
        if item.get("limited") is True or item.get("rate_limit_reached_type")
    ]
    candidates = []
    for snapshot in blocked or snapshots:
        for name in ("primary", "secondary"):
            window = snapshot.get(name)
            if not isinstance(window, dict):
                continue
            reset = window.get("resets_at")
            if not isinstance(reset, (int, float)) or isinstance(reset, bool) or reset <= now:
                continue
            used = window.get("used_percent")
            exhausted = (
                isinstance(used, (int, float))
                and not isinstance(used, bool)
                and used >= 100
            )
            candidates.append((not exhausted, float(reset)))
    if not candidates:
        return None
    return min(candidates)[1]


def _retry_text(epoch):
    local = datetime.datetime.fromtimestamp(epoch)
    hour = local.hour % 12 or 12
    suffix = "AM" if local.hour < 12 else "PM"
    return f"{hour}:{local.minute:02d} {suffix}"


def _retry_at(epoch):
    utc = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_app_server_result(payload, now=None):
    """Convert account/rateLimits/read output to the existing probe schema."""
    if not isinstance(payload, dict):
        raise ValueError("account/rateLimits/read returned a non-object result")
    if "result" in payload and isinstance(payload.get("result"), dict):
        payload = payload["result"]

    normalized = normalize_keys(payload)
    by_limit_id = normalized.get("rate_limits_by_limit_id")
    normalized_by_id = {}
    rate_limits = None

    if isinstance(by_limit_id, dict) and by_limit_id:
        keys = sorted(by_limit_id, key=lambda key: (str(key) != "codex", str(key)))
        snapshots = []
        for limit_id in keys:
            snapshot = by_limit_id[limit_id]
            if not isinstance(snapshot, dict):
                continue
            snapshot = dict(snapshot)
            if not snapshot.get("limit_id"):
                snapshot["limit_id"] = str(limit_id)
            normalized_by_id[str(limit_id)] = snapshot
            snapshots.append(snapshot)
        if snapshots:
            rate_limits = snapshots

    if rate_limits is None:
        legacy = normalized.get("rate_limits")
        if isinstance(legacy, (dict, list)):
            rate_limits = legacy

    snapshots = _limit_snapshots(rate_limits)
    reached_types = _reached_types(normalized, snapshots)
    limited = normalized.get("limited") is True or bool(reached_types)
    limited = limited or any(item.get("limited") is True for item in snapshots)

    output = {
        "ok": True,
        "source": "codex-app-server",
        "limited": limited,
    }
    if rate_limits is not None:
        output["rate_limits"] = rate_limits
    if normalized_by_id:
        output["rate_limits_by_limit_id"] = normalized_by_id
    if "rate_limit_reset_credits" in normalized:
        output["rate_limit_reset_credits"] = normalized["rate_limit_reset_credits"]
    if reached_types:
        output["rate_limit_reached_type"] = reached_types[0]
        if len(reached_types) > 1:
            output["rate_limit_reached_types"] = reached_types

    if limited:
        epoch = _select_retry_epoch(snapshots, time.time() if now is None else now)
        if epoch is not None:
            output["retry_at"] = _retry_at(epoch)
            output["retry_text"] = _retry_text(epoch)
            output["retryText"] = output["retry_text"]
    return output


def _probe_timeout():
    try:
        value = float(os.environ.get("CODEX_PROBE_TIMEOUT", "14"))
    except ValueError:
        value = 14.0
    return max(2.0, value)


def _app_version():
    configured = os.environ.get("AI_USAGE_LIVE_VERSION")
    if configured:
        return configured
    try:
        package_path = os.path.join(os.path.dirname(__file__), "package.json")
        with open(package_path, encoding="utf-8") as handle:
            return str(json.load(handle)["version"])
    except (OSError, KeyError, TypeError, ValueError):
        return "unknown"


def _read_process_lines(stream, target):
    if stream is None:
        target.put(None)
        return
    try:
        for line in iter(stream.readline, ""):
            target.put(line)
    finally:
        target.put(None)


def _read_diagnostics(stream, target):
    if stream is None:
        return
    for line in iter(stream.readline, ""):
        text = line.strip()
        if text:
            target.append(text[:240])
            del target[:-5]


def _send_message(proc, message):
    if proc.stdin is None:
        raise RuntimeError("codex app-server stdin is unavailable")
    proc.stdin.write(json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n")
    proc.stdin.flush()


def _rpc_error_text(error):
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return message
        return json.dumps(error, ensure_ascii=True)
    return str(error)


def _wait_for_response(messages, request_id, deadline, diagnostics):
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"RPC request {request_id} timed out")
        try:
            line = messages.get(timeout=remaining)
        except queue.Empty as exc:
            raise TimeoutError(f"RPC request {request_id} timed out") from exc
        if line is None:
            detail = diagnostics[-1] if diagnostics else "process exited"
            raise RuntimeError(f"codex app-server closed before response: {detail}")
        message = parse_rpc_message(line)
        if message is None:
            text = str(line).strip()
            if text:
                diagnostics.append(text[:240])
                del diagnostics[:-5]
            continue
        if message.get("id") != request_id:
            continue
        if message.get("error") is not None:
            raise RuntimeError(_rpc_error_text(message["error"]))
        if "result" not in message:
            raise RuntimeError(f"RPC response {request_id} has no result")
        return message["result"]


def kill_proc(proc):
    try:
        if proc.poll() is not None:
            return
    except (AttributeError, OSError):
        pass
    if os.name != "nt":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return
        except (AttributeError, OSError):
            pass
    try:
        proc.kill()
    except (AttributeError, OSError):
        pass


def _stop_process(proc):
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except (AttributeError, OSError):
        pass
    try:
        proc.wait(timeout=0.5)
        return
    except (AttributeError, OSError, subprocess.TimeoutExpired):
        pass
    kill_proc(proc)
    try:
        proc.wait(timeout=0.5)
    except (AttributeError, OSError, subprocess.TimeoutExpired):
        pass


def run_app_server_probe(timeout=None):
    timeout = _probe_timeout() if timeout is None else max(0.1, float(timeout))
    try:
        proc = subprocess.Popen(
            ["codex", "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
            cwd="/tmp",
        )
    except OSError as exc:
        return {"ok": False, "source": "codex-app-server", "note": f"no pude lanzar codex app-server: {exc}"}

    messages = queue.Queue()
    diagnostics = []
    reader = threading.Thread(
        target=_read_process_lines,
        args=(proc.stdout, messages),
        daemon=True,
    )
    stderr_reader = threading.Thread(
        target=_read_diagnostics,
        args=(proc.stderr, diagnostics),
        daemon=True,
    )
    reader.start()
    stderr_reader.start()
    deadline = time.monotonic() + timeout
    try:
        _send_message(proc, {
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "ai-usage-live",
                    "title": "AI Usage Live",
                    "version": _app_version(),
                },
                "capabilities": {},
            },
        })
        _wait_for_response(messages, 1, deadline, diagnostics)
        _send_message(proc, {"method": "initialized"})
        _send_message(proc, {"id": 2, "method": "account/rateLimits/read"})
        result = _wait_for_response(messages, 2, deadline, diagnostics)
        return normalize_app_server_result(result)
    except (BrokenPipeError, OSError, RuntimeError, TimeoutError, ValueError) as exc:
        return {
            "ok": False,
            "source": "codex-app-server",
            "note": f"codex app-server probe failed: {str(exc)[:200]}",
        }
    finally:
        _stop_process(proc)
        reader.join(timeout=0.2)
        stderr_reader.join(timeout=0.2)


# Legacy token-consuming probe. This path is opt-in via CODEX_ALLOW_EXEC_PROBE=1.
def find_rate_limits(obj):
    if isinstance(obj, dict):
        value = obj.get("rate_limits") or obj.get("rateLimits")
        if isinstance(value, dict):
            return normalize_keys(value)
        for item in obj.values():
            found = find_rate_limits(item)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_rate_limits(item)
            if found:
                return found
    return None


def newest_session_rate_limits(since_ms):
    files = glob.glob(os.path.join(SESSIONS, "**", "*.jsonl"), recursive=True)
    files.sort(key=lambda path: os.path.getmtime(path), reverse=True)
    for path in files[:6]:
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue
            limits = item.get("payload", {}).get("rate_limits") or item.get("rate_limits")
            if not (isinstance(limits, dict) and isinstance(limits.get("primary"), dict)):
                continue
            timestamp = item.get("timestamp", "")
            try:
                observed_ms = (
                    datetime.datetime.strptime(timestamp[:19], "%Y-%m-%dT%H:%M:%S").timestamp()
                    * 1000
                )
            except ValueError:
                observed_ms = 0
            if observed_ms >= since_ms:
                return limits
    return None


def _event_message(item, fallback):
    message = item.get("message")
    if isinstance(message, str):
        return message
    error = item.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    if isinstance(error, str):
        return error
    return fallback


def parse_output(text):
    """Parse legacy ``codex exec --json`` output."""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        blob = json.dumps(item, ensure_ascii=True)
        low = blob.lower()
        if "usage limit" in low or "rate limit" in low or "rate_limit_reached" in low:
            message = _event_message(item, blob)
            match = re.search(r"try again at\s+([0-9]{1,2}:[0-9]{2}\s*[AP]M)", message, re.I)
            return {
                "ok": True,
                "source": "codex-exec",
                "limited": True,
                "retryText": match.group(1).strip() if match else "",
                "message": message[:180],
            }
        limits = find_rate_limits(item)
        if limits:
            return {
                "ok": True,
                "source": "codex-exec",
                "limited": False,
                "rate_limits": limits,
            }
    return None


def run_exec_probe(timeout=None):
    timeout = _probe_timeout() if timeout is None else max(0.1, float(timeout))
    since_ms = time.time() * 1000 - 3000
    try:
        proc = subprocess.Popen(
            [
                "codex", "exec", "--json", "--sandbox", "read-only",
                "--skip-git-repo-check", "responde solo: ok",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
            cwd="/tmp",
        )
    except OSError as exc:
        return {"ok": False, "source": "codex-exec", "note": f"no pude lanzar codex exec: {exc}"}

    output = ""
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_proc(proc)
        try:
            output, _ = proc.communicate(timeout=4)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            output = output or ""
    finally:
        kill_proc(proc)

    parsed = parse_output(output or "")
    if parsed:
        return parsed
    limits = newest_session_rate_limits(since_ms)
    if limits:
        return {
            "ok": True,
            "source": "codex-exec",
            "limited": False,
            "rate_limits": limits,
        }
    return {"ok": False, "source": "codex-exec", "note": "codex exec probe sin datos"}


def run():
    app_server = run_app_server_probe()
    if app_server.get("ok") or os.environ.get("CODEX_ALLOW_EXEC_PROBE") != "1":
        return app_server

    fallback = run_exec_probe()
    if not fallback.get("ok"):
        app_note = app_server.get("note", "app-server sin datos")
        old_note = fallback.get("note", "exec sin datos")
        fallback["note"] = f"{old_note}; app-server: {app_note}"
    return fallback


def main():
    try:
        output = run()
    except Exception as exc:  # noqa: BLE001
        output = {"ok": False, "note": f"codex probe failed: {str(exc)[:160]}"}
    output["capturedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(json.dumps(output, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
