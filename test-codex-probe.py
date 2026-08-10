#!/usr/bin/env python3
"""Unit tests for codex-probe.py. No real Codex process is started."""
import importlib.util
import io
import json
import os
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("codex_probe", REPO / "codex-probe.py")
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class FakeStdin:
    def __init__(self):
        self.writes = []

    def write(self, value):
        self.writes.append(value)
        return len(value)

    def flush(self):
        return None

    def close(self):
        return None


class FakeProcess:
    def __init__(self, lines):
        self.stdin = FakeStdin()
        self.stdout = io.StringIO(lines)
        self.stderr = io.StringIO("")


class NormalizationTests(unittest.TestCase):
    def test_normalizes_legacy_single_bucket(self):
        result = PROBE.normalize_app_server_result({
            "rateLimits": {
                "limitId": "codex",
                "limitName": "Codex",
                "planType": "plus",
                "primary": {
                    "usedPercent": 17,
                    "resetsAt": 1700003600,
                    "windowDurationMins": 300,
                },
                "secondary": None,
                "credits": {
                    "hasCredits": True,
                    "unlimited": False,
                    "balance": "12.50",
                },
                "individualLimit": {
                    "limit": "100",
                    "used": "25",
                    "remainingPercent": 75,
                    "resetsAt": 1700007200,
                },
            },
        })

        self.assertTrue(result["ok"])
        self.assertFalse(result["limited"])
        limits = result["rate_limits"]
        self.assertEqual(limits["limit_id"], "codex")
        self.assertEqual(limits["plan_type"], "plus")
        self.assertEqual(limits["primary"]["used_percent"], 17)
        self.assertEqual(limits["primary"]["window_minutes"], 300)
        self.assertEqual(limits["credits"]["has_credits"], True)
        self.assertEqual(limits["individual_limit"]["remaining_percent"], 75)

    def test_prefers_multi_bucket_map_and_normalizes_reset_credits(self):
        result = PROBE.normalize_app_server_result({
            "rateLimits": {"limitId": "legacy", "primary": {"usedPercent": 99}},
            "rateLimitsByLimitId": {
                "premium": {
                    "planType": "pro",
                    "primary": {"usedPercent": 8, "windowDurationMins": 300},
                },
                "codex": {
                    "limitId": "codex",
                    "secondary": {"usedPercent": 22, "windowDurationMins": 10080},
                },
            },
            "rateLimitResetCredits": {
                "availableCount": 1,
                "credits": [{
                    "id": "credit-1",
                    "grantedAt": 1700000000,
                    "expiresAt": 1700100000,
                    "resetType": "codexRateLimits",
                    "status": "available",
                }],
            },
        })

        self.assertEqual([item["limit_id"] for item in result["rate_limits"]], ["codex", "premium"])
        self.assertEqual(result["rate_limits"][1]["primary"]["window_minutes"], 300)
        self.assertEqual(result["rate_limits_by_limit_id"]["premium"]["limit_id"], "premium")
        reset = result["rate_limit_reset_credits"]
        self.assertEqual(reset["available_count"], 1)
        self.assertEqual(reset["credits"][0]["granted_at"], 1700000000)
        self.assertEqual(reset["credits"][0]["reset_type"], "codexRateLimits")

    def test_reached_type_sets_limited_and_retry_fields(self):
        result = PROBE.normalize_app_server_result({
            "rateLimits": {
                "limitId": "codex",
                "rateLimitReachedType": "workspace_member_usage_limit_reached",
                "primary": {"usedPercent": 100, "resetsAt": 1700003600},
                "secondary": {"usedPercent": 40, "resetsAt": 1700100000},
            },
        }, now=1700000000)

        self.assertTrue(result["limited"])
        self.assertEqual(
            result["rate_limit_reached_type"],
            "workspace_member_usage_limit_reached",
        )
        self.assertEqual(result["retry_at"], "2023-11-14T23:13:20Z")
        self.assertEqual(result["retryText"], result["retry_text"])

    def test_explicit_limited_is_supported(self):
        result = PROBE.normalize_app_server_result({
            "limited": True,
            "rateLimits": {"primary": {"usedPercent": 100}},
        }, now=1700000000)
        self.assertTrue(result["limited"])


class RpcParsingTests(unittest.TestCase):
    def test_parse_rpc_message_ignores_non_json(self):
        self.assertIsNone(PROBE.parse_rpc_message(""))
        self.assertIsNone(PROBE.parse_rpc_message("codex app-server starting"))
        self.assertIsNone(PROBE.parse_rpc_message("[]"))

    def test_parse_rpc_message_accepts_json_response(self):
        message = PROBE.parse_rpc_message(b'{"id":2,"result":{"rateLimits":{}}}\r\n')
        self.assertEqual(message["id"], 2)
        self.assertIn("rateLimits", message["result"])

    def test_app_server_handshake_uses_official_sequence(self):
        lines = "\n".join([
            json.dumps({"id": 1, "result": {"serverInfo": {"name": "codex", "version": "1"}}}),
            json.dumps({"method": "account/rateLimits/updated", "params": {}}),
            json.dumps({
                "id": 2,
                "result": {"rateLimits": {"primary": {"usedPercent": 9}}},
            }),
            "",
        ])
        fake = FakeProcess(lines)

        with mock.patch.object(PROBE.subprocess, "Popen", return_value=fake) as popen:
            with mock.patch.object(PROBE, "_stop_process"):
                result = PROBE.run_app_server_probe(timeout=1)

        self.assertTrue(result["ok"])
        self.assertEqual(result["rate_limits"]["primary"]["used_percent"], 9)
        messages = [json.loads(line) for line in fake.stdin.writes]
        self.assertEqual([message["method"] for message in messages], [
            "initialize", "initialized", "account/rateLimits/read",
        ])
        self.assertEqual(messages[0]["params"]["capabilities"], {})
        self.assertEqual(messages[0]["params"]["clientInfo"]["version"], PROBE._app_version())
        self.assertNotIn("id", messages[1])
        self.assertEqual(popen.call_args.args[0], [
            "codex", "app-server", "--listen", "stdio://",
        ])


class FallbackTests(unittest.TestCase):
    def test_exec_fallback_is_disabled_by_default(self):
        failure = {"ok": False, "note": "RPC unavailable"}
        with mock.patch.object(PROBE, "run_app_server_probe", return_value=failure):
            with mock.patch.object(PROBE, "run_exec_probe") as old_probe:
                with mock.patch.dict(os.environ, {}, clear=False):
                    os.environ.pop("CODEX_ALLOW_EXEC_PROBE", None)
                    self.assertIs(PROBE.run(), failure)
        old_probe.assert_not_called()

    def test_exec_fallback_requires_exact_opt_in(self):
        failure = {"ok": False, "note": "RPC unavailable"}
        fallback = {"ok": True, "rate_limits": {"primary": {}}}
        with mock.patch.object(PROBE, "run_app_server_probe", return_value=failure):
            with mock.patch.object(PROBE, "run_exec_probe", return_value=fallback) as old_probe:
                with mock.patch.dict(os.environ, {"CODEX_ALLOW_EXEC_PROBE": "1"}):
                    self.assertIs(PROBE.run(), fallback)
        old_probe.assert_called_once_with()


if __name__ == "__main__":
    unittest.main(verbosity=2)
