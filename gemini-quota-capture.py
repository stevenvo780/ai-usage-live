#!/usr/bin/env python3
import json
import os
import pty
import re
import select
import shlex
import signal
import subprocess
import sys
import tempfile
import time


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
OSC_RE = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)")


def clean_text(value):
    text = value.decode("utf-8", "ignore") if isinstance(value, (bytes, bytearray)) else str(value)
    text = OSC_RE.sub("", text)
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    text = "".join(ch if ch == "\n" or 32 <= ord(ch) < 127 else " " for ch in text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def sanitize_account(value):
    value = re.sub(r"\([^)]*@[^)]*\)", "(account)", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.\w+", "account", value)
    return value.strip()


def redact_sensitive(value):
    return re.sub(r"[\w.+-]+@[\w.-]+\.\w+", "account", str(value))


def parse_duration_ms(value):
    total = 0
    for number, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([dhms])", value.lower()):
        amount = float(number)
        if unit == "d":
            total += amount * 24 * 60 * 60 * 1000
        elif unit == "h":
            total += amount * 60 * 60 * 1000
        elif unit == "m":
            total += amount * 60 * 1000
        elif unit == "s":
            total += amount * 1000
    return int(total) if total else None


def prettify_compact_plan(value):
    value = value.strip()
    known = {
        "GeminiCodeAssistinGoogleOneAIPro": "Gemini Code Assist in Google One AI Pro",
        "GeminiCodeAssistinGoogleOneAIUltra": "Gemini Code Assist in Google One AI Ultra",
        "GeminiCodeAssist": "Gemini Code Assist",
    }
    if value in known:
        return known[value]
    return re.sub(r"(?<!^)([A-Z])", r" \1", value).replace("  ", " ").strip()


def prettify_model_name(value):
    known = {
        "FlashLite": "Flash Lite",
        "Flash": "Flash",
        "Pro": "Pro",
    }
    return known.get(value, value)


def parse_model_quotas(compact):
    if "Modelusage" not in compact:
        return []
    section = compact.split("Modelusage", 1)[1]
    section = re.split(r"\(PressEsc|\?forshortcuts|Shift\+Tab", section, 1)[0]
    pattern = re.compile(
        r"(gemini-[A-Za-z0-9.\-]+|FlashLite|Flash|Pro).*?(\d+(?:\.\d+)?)%Resets:([^%]+?)(?=gemini-[A-Za-z0-9.\-]+|FlashLite|Flash|Pro|$)",
        re.IGNORECASE,
    )
    by_name = {}
    for match in pattern.finditer(section):
        raw_name = match.group(1)
        used = float(match.group(2))
        reset = match.group(3).strip()
        reset = re.sub(r"([AP]M)\(", r" \1 (", reset)
        reset = re.sub(r"\)(?!$)", ") ", reset)
        name = prettify_model_name(raw_name)
        by_name[name.lower()] = {
            "model": name,
            "usedPercent": used,
            "remainingPercent": max(0.0, 100.0 - used),
            "resetText": reset,
        }
    return list(by_name.values())


def parse_stats(text):
    lines = [line.strip(" |") for line in clean_text(text).splitlines()]
    lines = [line for line in lines if line]
    joined = " ".join(lines)
    compact = re.sub(r"\s+", "", joined)

    percent_match = re.search(
        r"(\d+(?:\.\d+)?)\s*%\s*used\s*\(\s*Limit resets in\s*([^)]+?)\s*\)",
        joined,
        re.IGNORECASE,
    )
    limit_match = re.search(r"Usage limit:\s*([0-9,]+)", joined, re.IGNORECASE)
    if not percent_match:
        percent_match = re.search(
            r"(\d+(?:\.\d+)?)%used\(Limitresetsin([^)]+?)\)",
            compact,
            re.IGNORECASE,
        )
    if not limit_match:
        limit_match = re.search(r"Usagelimit:([0-9,]+)", compact, re.IGNORECASE)

    auth_method = ""
    tier = ""
    for line in lines:
        if not auth_method:
            match = re.search(r"Auth Method:\s*(.+)", line, re.IGNORECASE)
            if match:
                auth_method = sanitize_account(match.group(1))
        if not tier:
            match = re.search(r"Tier:\s*(.+)", line, re.IGNORECASE)
            if match:
                tier = sanitize_account(match.group(1))

    if not tier:
        compact_plan = re.search(r"Plan:([^/]+?)/upgrade", compact, re.IGNORECASE)
        if compact_plan:
            tier = prettify_compact_plan(compact_plan.group(1))

    model_quotas = parse_model_quotas(compact)

    if not percent_match:
        status_match = re.search(r"quota\s+(\d+(?:\.\d+)?)\s*%\s*used", joined, re.IGNORECASE)
        if not status_match:
            status_match = re.search(r"quota(\d+(?:\.\d+)?)%used", compact, re.IGNORECASE)
        if status_match:
            percent_match = status_match

    used_percent = float(percent_match.group(1)) if percent_match else None
    reset_text = percent_match.group(2).strip() if percent_match and percent_match.lastindex and percent_match.lastindex >= 2 else ""
    usage_limit = int(limit_match.group(1).replace(",", "")) if limit_match else None
    remaining_percent = max(0.0, 100.0 - used_percent) if used_percent is not None else None
    remaining_requests = (
        max(0, round(usage_limit * remaining_percent / 100.0))
        if usage_limit is not None and remaining_percent is not None
        else None
    )
    reset_ms = parse_duration_ms(reset_text) if reset_text else None

    return {
        "ok": used_percent is not None,
        "usedPercent": used_percent,
        "remainingPercent": remaining_percent,
        "usageLimit": usage_limit,
        "remainingRequests": remaining_requests,
        "resetText": reset_text,
        "resetAt": int(time.time() * 1000 + reset_ms) if reset_ms else None,
        "tier": tier,
        "authMethod": auth_method,
        "modelQuotas": model_quotas,
        "lineCount": len(lines),
        "note": (
            "Gemini /stats model detectado."
            if used_percent is not None and usage_limit is not None
            else "Gemini status quota detectado."
            if used_percent is not None
            else "No pude parsear /stats model."
        ),
    }


def run_capture():
    timeout = max(10.0, float(os.environ.get("AI_USAGE_GEMINI_TIMEOUT", "45")))
    command = shlex.split(os.environ.get("AI_USAGE_GEMINI_COMMAND", "gemini --screen-reader"))
    args = command + ["--skip-trust"]
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("NO_COLOR", "1")
    temp_settings_path = None
    if not env.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH"):
        fd, temp_settings_path = tempfile.mkstemp(prefix="ai-usage-gemini-settings-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "general": {
                        "enableAutoUpdate": False,
                        "enableAutoUpdateNotification": False,
                        "enableNotifications": False,
                    }
                },
                handle,
            )
        env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = temp_settings_path

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        args,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=env,
    )
    os.close(slave_fd)

    start = time.monotonic()
    deadline = start + timeout
    sent_stats = False
    auth_dead = False
    sent_extra_enter = False
    sent_model = False
    sent_model_extra_enter = False
    sent_quit = False
    buffer = bytearray()

    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master_fd], [], [], 0.25)
            if ready:
                try:
                    chunk = os.read(master_fd, 8192)
                except OSError:
                    break
                if not chunk:
                    break
                buffer.extend(chunk)

            text = clean_text(buffer)
            elapsed = time.monotonic() - start
            prompt_ready = "Type your message" in text
            fallback_ready = elapsed > 25.0 and "Waiting for authentication" not in text

            # Google revoco el OAuth del gemini-cli: bail rapido en vez de colgar el timeout.
            if (
                "Failed to authenticate" in text
                or "invalid_grant" in text
                or "FatalAuthenticationError" in text
                or "Please visit the following URL to authorize" in text
            ):
                auth_dead = True
                break

            if not sent_stats and (prompt_ready or fallback_ready):
                os.write(master_fd, b"/stats model\r")
                sent_stats = True
                stats_sent_at = time.monotonic()

            if sent_stats and not sent_extra_enter and time.monotonic() - stats_sent_at > 1.0:
                os.write(master_fd, b"\r")
                sent_extra_enter = True

            if sent_stats and not sent_model and "No API calls have been made in this session" in text:
                os.write(master_fd, b"/model\r")
                sent_model = True
                model_sent_at = time.monotonic()

            if sent_model and not sent_model_extra_enter and time.monotonic() - model_sent_at > 1.0:
                os.write(master_fd, b"\r")
                sent_model_extra_enter = True

            if sent_stats and ("Usage limit:" in text or "Limit resets in" in text or "Usage limits span" in text):
                if "Usage limits span" in text or time.monotonic() - stats_sent_at > 5.0:
                    if not sent_quit:
                        os.write(master_fd, b"/quit\r")
                        sent_quit = True
                    break

            if sent_model and "Model usage" in text and "Resets:" in text and time.monotonic() - model_sent_at > 2.0:
                break

            if proc.poll() is not None:
                break

        if sent_quit:
            end_wait = time.monotonic() + 2.0
            while time.monotonic() < end_wait and proc.poll() is None:
                ready, _, _ = select.select([master_fd], [], [], 0.2)
                if ready:
                    try:
                        buffer.extend(os.read(master_fd, 8192))
                    except OSError:
                        break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
            except OSError:
                pass
        if temp_settings_path:
            try:
                os.unlink(temp_settings_path)
            except OSError:
                pass

    parsed = parse_stats(buffer)
    if auth_dead:
        parsed["ok"] = False
        parsed["authDead"] = True
        parsed["note"] = (
            "Gemini CLI deautenticado: Google revoco el OAuth del gemini-cli. "
            "Reautentica con `gemini` (/auth) o usa Antigravity."
        )
    debug_file = os.environ.get("AI_USAGE_GEMINI_DEBUG_FILE")
    if debug_file:
        with open(debug_file, "w", encoding="utf-8") as handle:
            handle.write(redact_sensitive(clean_text(buffer)))
    parsed["capturedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    parsed["command"] = command[0] if command else "gemini"
    return parsed


def main():
    try:
        print(json.dumps(run_capture(), ensure_ascii=True))
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "note": f"Gemini capture failed: {str(exc)[:160]}",
                },
                ensure_ascii=True,
            )
        )
        return 0


if __name__ == "__main__":
    main()
