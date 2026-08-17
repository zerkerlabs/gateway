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


observer = _load("zerker_claude_observer", _ROOT / "zerker_observer.py")
installer = _load("zerker_claude_installer", _ROOT / "install.py")


class ObserverTest(unittest.TestCase):
    def test_session_event_contains_only_contract_metadata(self) -> None:
        sent = []
        payload = {
            "hook_event_name": "SessionStart",
            "session_id": "secret-session-id",
            "transcript_path": "/private/transcript.jsonl",
            "cwd": "/private/project",
            "prompt": "do not send me",
        }
        with patch.object(observer, "_resolve_agent_id", return_value="agent-1"), patch.object(
            observer, "_request", side_effect=lambda path, **kwargs: sent.append(kwargs["payload"]) or {}
        ):
            observer.handle_hook(payload)
        self.assertEqual(len(sent), 1)
        event = sent[0]
        self.assertEqual(event["type"], "session.started")
        self.assertEqual(event["source"], "claude-code")
        serialized = json.dumps(event)
        for secret in ("secret-session-id", "transcript", "/private", "do not send me"):
            self.assertNotIn(secret, serialized)

    def test_tool_event_omits_input_and_output(self) -> None:
        sent = []
        with tempfile.TemporaryDirectory() as directory, patch.object(
            observer, "_STATE_ROOT", Path(directory)
        ), patch.object(observer, "_resolve_agent_id", return_value="agent-1"), patch.object(
            observer, "_request", side_effect=lambda path, **kwargs: sent.append(kwargs["payload"]) or {}
        ):
            observer.handle_hook(
                {
                    "hook_event_name": "PreToolUse",
                    "session_id": "session-1",
                    "tool_use_id": "tool-1",
                    "tool_name": "Bash",
                    "tool_input": {"command": "cat secret"},
                }
            )
            time.sleep(0.002)
            observer.handle_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": "session-1",
                    "tool_use_id": "tool-1",
                    "tool_name": "Bash",
                    "tool_input": {"command": "cat secret"},
                    "tool_response": "private output",
                }
            )
        self.assertEqual(len(sent), 1)
        event = sent[0]
        self.assertEqual(event["type"], "tool.completed")
        self.assertEqual(event["tool_name"], "Bash")
        self.assertEqual(event["outcome"], "succeeded")
        self.assertGreaterEqual(event["duration_ms"], 0)
        serialized = json.dumps(event)
        self.assertNotIn("cat secret", serialized)
        self.assertNotIn("private output", serialized)

    def test_failure_is_coarse(self) -> None:
        sent = []
        with patch.object(observer, "_resolve_agent_id", return_value="agent-1"), patch.object(
            observer, "_request", side_effect=lambda path, **kwargs: sent.append(kwargs["payload"]) or {}
        ):
            observer.handle_hook(
                {
                    "hook_event_name": "PostToolUseFailure",
                    "session_id": "session-1",
                    "tool_use_id": "tool-2",
                    "tool_name": "Read",
                    "error": "sensitive failure text",
                }
            )
        self.assertEqual(sent[0]["outcome"], "failed")
        self.assertNotIn("sensitive failure text", json.dumps(sent[0]))


class InstallerTest(unittest.TestCase):
    def test_install_is_idempotent_and_preserves_existing_hooks(self) -> None:
        settings = {
            "model": "existing",
            "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "existing-hook"}]}]},
        }
        installer.update_settings(settings)
        installer.update_settings(settings)
        self.assertEqual(settings["model"], "existing")
        self.assertEqual(len(settings["hooks"]["SessionStart"]), 2)
        for event in installer._EVENTS:
            zerker = [
                group for group in settings["hooks"][event] if group.get("_zerker_source") == "zerker-observer"
            ]
            self.assertEqual(len(zerker), 1)
            command_hook = zerker[0]["hooks"][0]
            if event == "PreToolUse":
                self.assertNotIn("async", command_hook)
            else:
                self.assertTrue(command_hook["async"])

    def test_uninstall_removes_only_zerker_hooks(self) -> None:
        settings = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "keep"}]}]}}
        installer.update_settings(settings)
        installer.update_settings(settings, uninstall=True)
        self.assertEqual(settings["hooks"], {"SessionStart": [{"hooks": [{"type": "command", "command": "keep"}]}]})


if __name__ == "__main__":
    unittest.main()
