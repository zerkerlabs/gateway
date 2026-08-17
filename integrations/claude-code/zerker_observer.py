#!/usr/bin/env python3
"""Privacy-safe Claude Code hook adapter for Zerker Gateway.

Claude Code sends hook payloads on stdin. This adapter extracts only lifecycle,
tool name, coarse outcome, and duration metadata. It never sends prompts, tool
inputs or outputs, commands, paths, transcripts, or credentials.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

_SCHEMA = "zerker.agent-event.v1"
_SOURCE_VERSION = "0.1.0"
_DEFAULT_GATEWAY = "http://127.0.0.1:8080"
_DEFAULT_TOKEN_FILE = "/tmp/zerker-dev-token"
_MAX_HOOK_BYTES = 4 << 20
_STATE_ROOT = Path(tempfile.gettempdir()) / f"zerker-claude-observer-{os.getuid()}"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_OPENER = build_opener(_NoRedirect())


def _gateway_url() -> str | None:
    raw = os.getenv("ZERKER_GATEWAY_URL", _DEFAULT_GATEWAY).strip()
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    numeric_loopback = parsed.hostname in {"127.0.0.1", "::1"}
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and numeric_loopback):
        return None
    if not parsed.netloc:
        return None
    return raw.rstrip("/")


def _token() -> str | None:
    configured = os.getenv("ZERKER_TOKEN", "").strip()
    if configured:
        return configured
    try:
        value = Path(os.getenv("ZERKER_TOKEN_FILE", _DEFAULT_TOKEN_FILE)).read_text(
            encoding="utf-8"
        ).strip()
        return value or None
    except OSError:
        return None


def _request(path: str, *, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    gateway = _gateway_url()
    bearer = _token()
    if not gateway or not bearer:
        raise RuntimeError("Zerker is not configured")
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
    request = Request(
        gateway + path,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
    )
    try:
        response = _OPENER.open(request, timeout=2)
    except HTTPError as exc:
        if exc.code != 401:
            raise
        refreshed = _token()
        if not refreshed or refreshed == bearer:
            raise
        request.headers["Authorization"] = f"Bearer {refreshed}"
        response = _OPENER.open(request, timeout=2)
    with response:
        data = response.read(1 << 20)
    return json.loads(data) if data else {}


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _session_ref(session_id: str) -> str:
    return "sha256:" + _digest(session_id)


def _event_id(session_ref: str, suffix: str) -> str:
    return "claude-code:" + _digest(f"{session_ref}:{suffix}")


def _resolve_agent_id() -> str:
    payload = _request("/v1/agents?per_page=100")
    for agent in payload.get("agents", []):
        metadata = agent.get("metadata") or {}
        if metadata.get("zerker_discovery_key") == "claude-code":
            return str(agent["id"])
    raise RuntimeError("Claude Code is not enrolled in Zerker")


def _occurred_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _emit_sanitized(event: dict[str, Any]) -> None:
    payload = {
        "schema": _SCHEMA,
        "event_id": event.pop("event_id", str(uuid.uuid4())),
        "agent_id": _resolve_agent_id(),
        "session_ref": event.pop("session_ref"),
        "occurred_at": _occurred_at(),
        "source": "claude-code",
        "source_version": _SOURCE_VERSION,
        **event,
    }
    _request("/v1/agent-events", method="POST", payload=payload)


def _spawn_emit(event: dict[str, Any]) -> None:
    read_fd, write_fd = os.pipe()
    try:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--emit"],
            stdin=read_fd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(read_fd)
    try:
        os.write(write_fd, json.dumps(event, separators=(",", ":")).encode("utf-8"))
    finally:
        os.close(write_fd)


def _start_path(session_id: str, tool_use_id: str) -> Path:
    return _STATE_ROOT / _digest(session_id) / _digest(tool_use_id)


def _record_tool_start(session_id: str, tool_use_id: str) -> None:
    path = _start_path(session_id, tool_use_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(str(time.time_ns()), encoding="ascii")
    path.chmod(0o600)


def _tool_duration_ms(session_id: str, tool_use_id: str) -> int:
    path = _start_path(session_id, tool_use_id)
    try:
        started_ns = int(path.read_text(encoding="ascii"))
    except (OSError, ValueError):
        return 0
    finally:
        try:
            path.unlink()
        except OSError:
            pass
    return max(0, (time.time_ns() - started_ns) // 1_000_000)


def handle_hook(payload: dict[str, Any]) -> None:
    event_name = payload.get("hook_event_name")
    session_id = payload.get("session_id")
    if not isinstance(event_name, str) or not isinstance(session_id, str) or not session_id:
        return
    session_ref = _session_ref(session_id)

    if event_name == "SessionStart":
        _spawn_emit({
            "session_ref": session_ref,
            "event_id": _event_id(session_ref, "session.started"),
            "type": "session.started",
        })
        return
    if event_name == "SessionEnd":
        _spawn_emit({
            "session_ref": session_ref,
            "event_id": _event_id(session_ref, "session.ended"),
            "type": "session.ended",
        })
        return

    tool_use_id = payload.get("tool_use_id")
    tool_name = payload.get("tool_name")
    if not isinstance(tool_use_id, str) or not tool_use_id:
        return
    if event_name == "PreToolUse":
        _record_tool_start(session_id, tool_use_id)
        return
    if event_name not in {"PostToolUse", "PostToolUseFailure"}:
        return
    if not isinstance(tool_name, str) or not tool_name.strip():
        return
    _spawn_emit({
        "session_ref": session_ref,
        "event_id": _event_id(session_ref, f"tool:{tool_use_id}"),
        "type": "tool.completed",
        "tool_name": tool_name.strip()[:128],
        "outcome": "succeeded" if event_name == "PostToolUse" else "failed",
        "duration_ms": _tool_duration_ms(session_id, tool_use_id),
    })


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(_MAX_HOOK_BYTES + 1)
        if len(raw) > _MAX_HOOK_BYTES:
            if not (len(sys.argv) > 1 and sys.argv[1] == "--emit"):
                print("{}")
            return 0
        payload = json.loads(raw)
        if isinstance(payload, dict):
            if len(sys.argv) > 1 and sys.argv[1] == "--emit":
                _emit_sanitized(payload)
                return 0
            handle_hook(payload)
    except Exception:
        # Measurement is fail-open. Claude Code must never wait on telemetry.
        pass
    if not (len(sys.argv) > 1 and sys.argv[1] == "--emit"):
        print("{}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
