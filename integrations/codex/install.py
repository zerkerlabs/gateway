#!/usr/bin/env python3
"""Install or remove the Zerker observer in Codex user hooks."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import tempfile
from pathlib import Path
from typing import Any

_SOURCE = "zerker-observer"
_EVENTS = ("SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd")


def _observer_command() -> str:
    observer = Path(__file__).with_name("zerker_observer.py").resolve()
    return f"python3 {shlex.quote(str(observer))}"


def _hook(_event: str) -> dict[str, Any]:
    return {"type": "command", "command": _observer_command(), "timeout": 3}


def _is_zerker_group(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    if group.get("_zerker_source") == _SOURCE:
        return True
    command = _observer_command()
    hooks = group.get("hooks")
    return isinstance(hooks, list) and any(
        isinstance(hook, dict) and hook.get("command") == command for hook in hooks
    )


def update_settings(settings: dict[str, Any], *, uninstall: bool = False) -> dict[str, Any]:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Codex hooks file 'hooks' must be an object")
    for event in _EVENTS:
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError(f"Codex hook event {event!r} must be an array")
        groups[:] = [group for group in groups if not _is_zerker_group(group)]
        if not uninstall:
            groups.append(
                {
                    "_zerker_source": _SOURCE,
                    "hooks": [_hook(event)],
                }
            )
        if not groups:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    return settings


def write_settings(path: Path, settings: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".settings.", delete=False
    ) as temporary:
        json.dump(settings, temporary, indent=2)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    temporary_path.chmod(mode)
    os.replace(temporary_path, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, default=Path.home() / ".codex" / "hooks.json")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    try:
        settings = json.loads(args.settings.read_text(encoding="utf-8")) if args.settings.exists() else {}
        if not isinstance(settings, dict):
            raise ValueError("Codex hooks file must be a JSON object")
        update_settings(settings, uninstall=args.uninstall)
        write_settings(args.settings, settings)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print("Zerker Codex observer removed." if args.uninstall else "Zerker Codex observer installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
