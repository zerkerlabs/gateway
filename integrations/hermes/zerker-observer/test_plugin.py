import importlib.util
import pathlib
import unittest
from datetime import datetime, timezone
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("zerker_hermes_observer", MODULE_PATH)
PLUGIN = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(PLUGIN)


class ZerkerHermesObserverTests(unittest.TestCase):
    def test_event_contract_contains_no_content_fields(self):
        event = PLUGIN._build_event("session.started", "private-session")
        self.assertEqual(event["source"], "hermes")
        self.assertTrue(event["session_ref"].startswith("sha256:"))
        serialized_keys = set(event)
        forbidden = {
            "prompt", "messages", "args", "result", "command", "path",
            "conversation", "user_message", "assistant_response",
        }
        self.assertFalse(serialized_keys & forbidden)
        self.assertNotIn("private-session", str(event))

    def test_tool_hook_exports_only_name_outcome_and_duration(self):
        captured = []
        with mock.patch.object(PLUGIN, "_enqueue", captured.append):
            PLUGIN.on_post_tool_call(
                session_id="session-1",
                tool_call_id="call-1",
                tool_name="terminal",
                status="blocked",
                duration_ms=12,
                args={"command": "never export this"},
                result="never export this either",
            )
        self.assertEqual(len(captured), 1)
        event = captured[0]
        self.assertEqual(event["tool_name"], "terminal")
        self.assertEqual(event["outcome"], "failed")
        self.assertEqual(event["duration_ms"], 12)
        self.assertNotIn("args", event)
        self.assertNotIn("result", event)
        self.assertNotIn("never export", str(event))

    def test_usage_hook_exports_token_buckets_without_response_content(self):
        captured = []
        with mock.patch.object(PLUGIN, "_enqueue", captured.append):
            PLUGIN.on_post_api_request(
                session_id="session-1",
                api_request_id="api-1",
                provider="openrouter",
                model="model-1",
                usage={"input_tokens": 100, "output_tokens": 20},
                response={"content": "never export this"},
            )
        event = captured[0]
        self.assertEqual(event["input_tokens"], 100)
        self.assertEqual(event["output_tokens"], 20)
        self.assertNotIn("response", event)
        self.assertNotIn("content", event)

    def test_status_reports_zerker_without_confusing_messaging_gateway(self):
        now = datetime.now(timezone.utc)
        with mock.patch.object(PLUGIN, "_resolve_agent_id", return_value="agt_hermes"), mock.patch.object(
            PLUGIN,
            "_request",
            return_value={"summary": {"last_event_at": now.isoformat()}},
        ):
            output = PLUGIN._zerker_status()
        self.assertIn("Zerker Gateway: connected", output)
        self.assertIn("Hermes · enrolled · reporting", output)
        self.assertIn("Never collected: prompts", output)
        self.assertIn("messaging platforms", output)
        self.assertNotIn("agt_hermes", output)

    def test_status_accepts_postgres_fractional_rfc3339(self):
        parsed = PLUGIN._parse_rfc3339("2026-08-18T00:48:13.6923+02:00")
        self.assertEqual(parsed.microsecond, 692300)

    def test_status_fails_open_without_internal_error_details(self):
        with mock.patch.object(PLUGIN, "_resolve_agent_id", side_effect=RuntimeError("private token detail")):
            output = PLUGIN._zerker_status()
        self.assertIn("status unavailable", output)
        self.assertNotIn("private token detail", output)

    def test_plain_http_is_limited_to_numeric_loopback(self):
        with mock.patch.dict(PLUGIN.os.environ, {"ZERKER_GATEWAY_URL": "http://gateway.example.com"}):
            self.assertIsNone(PLUGIN._gateway_url())
        with mock.patch.dict(PLUGIN.os.environ, {"ZERKER_GATEWAY_URL": "http://127.0.0.1:8080"}):
            self.assertEqual(PLUGIN._gateway_url(), "http://127.0.0.1:8080")


if __name__ == "__main__":
    unittest.main()
