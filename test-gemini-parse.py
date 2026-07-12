#!/usr/bin/env python3
"""Unit tests for Gemini CLI quota parsing."""
import importlib.util
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "gemini_quota_capture", REPO / "gemini-quota-capture.py"
)
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


class GeminiQuotaParseTests(unittest.TestCase):
    def test_parses_normal_usage_and_model_reset(self):
        before = int(time.time() * 1000)
        parsed = CAPTURE.parse_stats(
            "42% used (Limit resets in 3h 12m)\n"
            "Usage limit: 1,500\n"
            "Model usage Pro 42% Resets: 8:00 PM (3h 12m)"
        )
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["usedPercent"], 42)
        self.assertEqual(parsed["remainingRequests"], 870)
        self.assertEqual(parsed["modelQuotas"][0]["model"], "Pro")
        reset_at = parsed["modelQuotas"][0]["resetAt"]
        self.assertGreaterEqual(reset_at, before + (3 * 60 + 11) * 60 * 1000)

    def test_limit_reached_is_zero_remaining(self):
        parsed = CAPTURE.parse_stats(
            "Limit reached, resets in 1 hour 30 minutes\nUsage limit: 1,000"
        )
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["usedPercent"], 100)
        self.assertEqual(parsed["remainingPercent"], 0)
        self.assertEqual(parsed["remainingRequests"], 0)
        self.assertEqual(parsed["resetText"], "1 hour 30 minutes")

    def test_limit_reached_without_reset_is_still_exhausted(self):
        parsed = CAPTURE.parse_stats("Limit reached")
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["usedPercent"], 100)
        self.assertEqual(parsed["remainingPercent"], 0)
        self.assertIsNone(parsed["resetAt"])

    def test_model_only_quota_is_valid_without_a_global_counter(self):
        parsed = CAPTURE.parse_stats(
            "No API calls have been made in this session\n"
            "Model usage Pro 100% Flash 25% Resets: 4:00 PM (2h)"
        )
        self.assertTrue(parsed["ok"])
        self.assertIsNone(parsed["usedPercent"])
        self.assertEqual(
            [(quota["model"], quota["remainingPercent"]) for quota in parsed["modelQuotas"]],
            [("Pro", 0.0), ("Flash", 75.0)],
        )

    def test_auth_prompt_is_needs_auth_not_revoked(self):
        self.assertEqual(
            CAPTURE.detect_auth_state("Please visit the following URL to authorize"),
            "needs_auth",
        )
        self.assertEqual(CAPTURE.detect_auth_state("invalid_grant"), "error")
        self.assertIsNone(CAPTURE.detect_auth_state("Type your message"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
