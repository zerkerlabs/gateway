#!/usr/bin/env python3
"""Install or remove the Zerker observer in Gemini CLI user hooks."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import tempfile
from pathlib import Path
from typing import Any

_NAME = "zerker-observer"
_EVENTS = ("SessionStart", "BeforeTool", "AfterTool", "SessionEnd")


def _observer_command() -> str:
    observer = Path(__file__).with_name("zerker_observer.py").resolve()
    return f"python3 {shlex.quote(str(observer))}"


def _is_zerker_group(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    hooks = group.get("hooks")
    return isinstance(hooks, list) and any(
        isinstance(hook, dict)
        and (hook.get("name") == _NAME or hook.get("command") == _observer_command())
        for hook in hooks
    )


def update_settings(settings: dict[str, Any], *, uninstall: bool = False) -> dict[str, Any]:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Gemini CLI settings 'hooks' must be an object")
    for event in _EVENTS:
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError(f"Gemini CLI hook event {event!r} must be an array")
        groups[:] = [group for group in groups if not _is_zerker_group(group)]
        if not uninstall:
            group: dict[str, Any] = {
                "sequential": False,
                "hooks": [
                    {
                        "name": _NAME,
                        "type": "command",
                        "command": _observer_command(),
                        "timeout": 5000,
                        "description": "Send privacy-safe agent activity metadata to Zerker Gateway",
                    }
                ],
            }
            if event in {"BeforeTool", "AfterTool"}:
                group["matcher"] = ".*"
            groups.append(group)
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
    parser.add_argument("--settings", type=Path, default=Path.home() / ".gemini" / "settings.json")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    try:
        settings = json.loads(args.settings.read_text(encoding="utf-8")) if args.settings.exists() else {}
        if not isinstance(settings, dict):
            raise ValueError("Gemini CLI settings must be a JSON object")
        update_settings(settings, uninstall=args.uninstall)
        write_settings(args.settings, settings)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print("Zerker Gemini CLI observer removed." if args.uninstall else "Zerker Gemini CLI observer installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
