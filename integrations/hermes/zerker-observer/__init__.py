"""Privacy-safe Hermes activity adapter for Zerker Gateway."""
from __future__ import annotations

import hashlib
import json
import os
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

_SCHEMA = "zerker.agent-event.v1"
_SOURCE_VERSION = "0.1.0"
_DEFAULT_GATEWAY = "http://127.0.0.1:8080"
_DEFAULT_TOKEN_FILE = "/tmp/zerker-dev-token"
_EVENTS: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1000)
_STARTED = False
_START_LOCK = threading.Lock()
_AGENT_ID: Optional[str] = None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_OPENER = build_opener(_NoRedirect())


def _gateway_url() -> Optional[str]:
    raw = os.getenv("ZERKER_GATEWAY_URL", _DEFAULT_GATEWAY).strip()
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    numeric_loopback = parsed.hostname in {"127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and numeric_loopback):
        return None
    if not parsed.netloc:
        return None
    return raw.rstrip("/")


def _token() -> Optional[str]:
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


def _session_ref(session_id: str) -> str:
    return "sha256:" + hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def _event_id(session_ref: str, suffix: str) -> str:
    material = f"{session_ref}:{suffix}".encode("utf-8")
    return "hermes:" + hashlib.sha256(material).hexdigest()


def _request(path: str, *, method: str = "GET", payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    gateway = _gateway_url()
    bearer = _token()
    if not gateway or not bearer:
        raise RuntimeError("Zerker is not configured")

    def send(current_token: str):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
        request = Request(
            gateway + path,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {current_token}",
                "Content-Type": "application/json",
            },
        )
        return _OPENER.open(request, timeout=2)

    try:
        response = send(bearer)
    except HTTPError as exc:
        if exc.code != 401:
            raise
        refreshed = _token()
        if not refreshed or refreshed == bearer:
            raise
        response = send(refreshed)
    with response:
        data = response.read(1 << 20)
    return json.loads(data) if data else {}


def _resolve_agent_id() -> str:
    global _AGENT_ID
    if _AGENT_ID:
        return _AGENT_ID
    payload = _request("/v1/agents?per_page=100")
    for agent in payload.get("agents", []):
        metadata = agent.get("metadata") or {}
        if metadata.get("zerker_discovery_key") == "hermes":
            _AGENT_ID = str(agent["id"])
            return _AGENT_ID
    raise RuntimeError("Hermes is not enrolled in Zerker")


def _build_event(
    event_type: str,
    session_id: str,
    *,
    event_id: Optional[str] = None,
    **fields: Any,
) -> Dict[str, Any]:
    session_ref = _session_ref(session_id)
    event = {
        "schema": _SCHEMA,
        "event_id": event_id or str(uuid.uuid4()),
        "agent_id": "",
        "type": event_type,
        "session_ref": session_ref,
        "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "hermes",
        "source_version": _SOURCE_VERSION,
    }
    event.update(fields)
    return event


def _enqueue(event: Dict[str, Any]) -> None:
    _ensure_worker()
    try:
        _EVENTS.put_nowait(event)
    except queue.Full:
        # Measurement is fail-open. Agent execution always wins over telemetry.
        pass


def _worker() -> None:
    while True:
        event = _EVENTS.get()
        try:
            event["agent_id"] = _resolve_agent_id()
            _request("/v1/agent-events", method="POST", payload=event)
        except Exception:
            pass
        finally:
            _EVENTS.task_done()


def _ensure_worker() -> None:
    global _STARTED
    with _START_LOCK:
        if _STARTED:
            return
        threading.Thread(target=_worker, name="zerker-hermes-observer", daemon=True).start()
        _STARTED = True


def on_session_start(*, session_id: str = "", **_: Any) -> None:
    if not session_id:
        return
    ref = _session_ref(session_id)
    _enqueue(_build_event(
        "session.started",
        session_id,
        event_id=_event_id(ref, "session.started"),
    ))


def on_session_finalize(*, session_id: str = "", **_: Any) -> None:
    if not session_id:
        return
    ref = _session_ref(session_id)
    _enqueue(_build_event(
        "session.ended",
        session_id,
        event_id=_event_id(ref, "session.ended"),
    ))


def on_post_tool_call(
    *,
    session_id: str = "",
    tool_call_id: str = "",
    tool_name: str = "",
    status: str = "",
    duration_ms: Any = 0,
    **_: Any,
) -> None:
    if not session_id or not tool_name:
        return
    outcome = "succeeded" if status == "ok" else "cancelled" if status == "cancelled" else "failed"
    ref = _session_ref(session_id)
    suffix = f"tool:{tool_call_id}" if tool_call_id else f"tool:{uuid.uuid4()}"
    _enqueue(_build_event(
        "tool.completed",
        session_id,
        event_id=_event_id(ref, suffix),
        tool_name=tool_name[:128],
        outcome=outcome,
        duration_ms=max(0, int(duration_ms or 0)),
    ))


def on_post_api_request(
    *,
    session_id: str = "",
    api_request_id: str = "",
    provider: str = "",
    model: str = "",
    usage: Any = None,
    **_: Any,
) -> None:
    if not session_id or not provider or not model:
        return
    values = usage if isinstance(usage, dict) else {}
    ref = _session_ref(session_id)
    suffix = f"usage:{api_request_id}" if api_request_id else f"usage:{uuid.uuid4()}"
    _enqueue(_build_event(
        "model.usage",
        session_id,
        event_id=_event_id(ref, suffix),
        provider=provider[:128],
        model=model[:256],
        input_tokens=max(0, int(values.get("input_tokens", 0) or 0)),
        output_tokens=max(0, int(values.get("output_tokens", 0) or 0)),
        cache_read_tokens=max(0, int(values.get("cache_read_tokens", 0) or 0)),
        cache_write_tokens=max(0, int(values.get("cache_write_tokens", 0) or 0)),
    ))


def register(ctx) -> None:
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("post_api_request", on_post_api_request)
