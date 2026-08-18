from __future__ import annotations

import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = _load("zerker_gemini_observer", _ROOT / "zerker_observer.py")
installer = _load("zerker_gemini_installer", _ROOT / "install.py")


class ObserverTest(unittest.TestCase):
    def test_session_event_is_sanitized_before_background_emission(self) -> None:
        sent = []
        with patch.object(observer, "_spawn_emit", side_effect=sent.append):
            observer.handle_hook(
                {
                    "hook_event_name": "SessionStart",
                    "session_id": "secret-session-id",
                    "transcript_path": "/private/transcript.jsonl",
                    "cwd": "/private/project",
                    "prompt": "do not send me",
                }
            )
        self.assertEqual(len(sent), 1)
        event = sent[0]
        self.assertEqual(event["type"], "session.started")
        serialized = json.dumps(event)
        for secret in ("secret-session-id", "transcript", "/private", "do not send me"):
            self.assertNotIn(secret, serialized)

    def test_tool_event_omits_input_and_output(self) -> None:
        sent = []
        with tempfile.TemporaryDirectory() as directory, patch.object(
            observer, "_STATE_ROOT", Path(directory)
        ), patch.object(observer, "_spawn_emit", side_effect=sent.append):
            observer.handle_hook(
                {
                    "hook_event_name": "BeforeTool",
                    "session_id": "session-1",
                    "tool_name": "run_shell_command",
                    "tool_input": {"command": "cat secret"},
                }
            )
            time.sleep(0.002)
            observer.handle_hook(
                {
                    "hook_event_name": "AfterTool",
                    "session_id": "session-1",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "tool_name": "run_shell_command",
                    "tool_input": {"command": "cat secret"},
                    "tool_response": {"llmContent": "private output"},
                }
            )
        self.assertEqual(len(sent), 1)
        event = sent[0]
        self.assertEqual(event["type"], "tool.completed")
        self.assertEqual(event["tool_name"], "run_shell_command")
        self.assertEqual(event["outcome"], "succeeded")
        self.assertGreaterEqual(event["duration_ms"], 0)
        serialized = json.dumps(event)
        self.assertNotIn("cat secret", serialized)
        self.assertNotIn("private output", serialized)

    def test_tool_error_is_reduced_to_failed_outcome(self) -> None:
        sent = []
        with patch.object(observer, "_spawn_emit", side_effect=sent.append):
            observer.handle_hook(
                {
                    "hook_event_name": "AfterTool",
                    "session_id": "session-1",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "tool_name": "read_file",
                    "tool_response": {"error": "sensitive failure text"},
                }
            )
        self.assertEqual(sent[0]["outcome"], "failed")
        self.assertNotIn("sensitive failure text", json.dumps(sent[0]))


class InstallerTest(unittest.TestCase):
    def test_install_is_idempotent_and_preserves_existing_hooks(self) -> None:
        settings = {
            "security": {"auth": "existing"},
            "hooks": {"SessionStart": [{"hooks": [{"name": "keep", "type": "command", "command": "keep"}]}]},
        }
        installer.update_settings(settings)
        installer.update_settings(settings)
        self.assertEqual(settings["security"], {"auth": "existing"})
        self.assertEqual(len(settings["hooks"]["SessionStart"]), 2)
        for event in installer._EVENTS:
            zerker = [group for group in settings["hooks"][event] if installer._is_zerker_group(group)]
            self.assertEqual(len(zerker), 1)
            self.assertEqual(zerker[0]["hooks"][0]["name"], "zerker-observer")

    def test_uninstall_removes_only_zerker_hooks(self) -> None:
        keep = {"hooks": [{"name": "keep", "type": "command", "command": "keep"}]}
        settings = {"hooks": {"SessionStart": [keep]}}
        installer.update_settings(settings)
        installer.update_settings(settings, uninstall=True)
        self.assertEqual(settings["hooks"], {"SessionStart": [keep]})


if __name__ == "__main__":
    unittest.main()
