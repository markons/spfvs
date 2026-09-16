"""Newline-delimited JSON stdio server.

Two request shapes, distinguished by an optional `"type"` field — the
original prefix-command shape (no `type`, or any value other than
`"runMacro"`) and the macro shape (`"type": "runMacro"`, see
`_handle_macro()`/macros.py). One JSON object per line in both
directions.

Prefix-command request:
  {"id": <any>, "lines": [str, ...], "commands": [{"line": int, "code": str}, ...],
   "labels": {name: line, ...}, "excludedLines": [int, ...],
   "pendingMark": {"kind": "copy"|"move", "start": int, "end": int} | null,
   "executeCut": bool, "executePaste": {"line": int, "before": bool} | null}
Prefix-command response:
  {"id": <same>, "errors": [{"line": int, "message": str}, ...],
   "plan": {"lines": [str, ...], "consumedLines": [int, ...]} | null,
   "labels": {name: line, ...} | null, "excludedLines": [int, ...] | null,
   "pendingMark": {"kind": "copy"|"move", "start": int, "end": int} | null}

`labels`/`excludedLines`/`pendingMark` are caller-owned state (see
prefix_commands.py's module docstring for LABEL/EXCLUDE/CUT-PASTE
semantics): the caller sends its current value for each in every request
and gets each back updated for that batch's restructuring plus whatever
`.name`/`.`/`x`/`xx`/unpaired-c-cc-m-mm ops were in it. On a rejected
batch (`plan` is null) all three are also null — the caller's values are
unaffected and it should keep what it already had. `executeCut` and
`executePaste` are one-shot triggers (not caller-owned state to round-trip
back) sent by the extension host in response to the CUT/PASTE *primary*
commands — see prefix_commands.py's docstring for what each does; a
request with neither set (and no `commands`) is just "give me the
document back unchanged, but still report current labels/excludedLines/
pendingMark", which the extension host doesn't currently have a reason to
send but which falls out naturally from every field being optional.

Macro request:
  {"id": <any>, "type": "runMacro", "lines": [str, ...], "cursorLine": int,
   "macroPath": str, "args": [str, ...], "labels": {name: line, ...}}
Macro response:
  {"id": <same>, "ok": bool, "lines": [str, ...] | null,
   "cursorLine": int | null, "labels": {name: line, ...} | null,
   "message": str, "error": str | null}

`macroPath` is an absolute filesystem path the extension host already
resolved (see extension/src/macros.ts) — the backend just reads and
execs it (see macros.py's `run_macro()`); no macro source is ever sent
inline over the wire. `labels` is optional on the request (the macro's
current name->line map, for `EditContext.resolve_label()`/`set_label()`/
`clear_label()`) and, unlike Phase 1's original read-only version, IS
echoed back updated on the response — same "caller persists whatever
comes back" contract a prefix-command response's `labels` already has.
`lines`/`cursorLine`/`labels` on a *response* are only present when `ok`
is true; a failed macro (bad file, exception, etc.) reports `error`
instead and leaves the caller's document untouched, same "reject the
whole thing, change nothing" spirit as a rejected prefix-command batch.
"""
from __future__ import annotations

import json
import sys

from .macros import run_macro
from .models import Command
from .prefix_commands import process


def _handle_macro(request: dict) -> dict:
    req_id = request.get("id")
    try:
        lines = request["lines"]
        cursor_line = int(request.get("cursorLine", 1))
        macro_path = request["macroPath"]
        args = request.get("args") or []
        labels = request.get("labels") or {}
    except (KeyError, TypeError, ValueError) as e:
        return {
            "id": req_id, "ok": False, "lines": None, "cursorLine": None,
            "message": "", "error": f"malformed macro request: {e}",
        }
    result = run_macro(macro_path, lines, cursor_line, args, labels)
    return {
        "id": req_id,
        "ok": result.ok,
        "lines": result.lines,
        "cursorLine": result.cursor_line,
        "labels": result.labels,
        "message": result.message,
        "error": result.error,
    }


def _handle(request: dict) -> dict:
    if request.get("type") == "runMacro":
        return _handle_macro(request)
    req_id = request.get("id")
    try:
        lines = request["lines"]
        commands = [Command(line=c["line"], code=c["code"]) for c in request.get("commands", [])]
        labels = request.get("labels") or {}
        excluded_lines = request.get("excludedLines") or []
        pending_mark = request.get("pendingMark")
        execute_cut = bool(request.get("executeCut"))
        execute_paste = request.get("executePaste")
    except (KeyError, TypeError) as e:
        return {
            "id": req_id,
            "errors": [{"line": 0, "message": f"malformed request: {e}"}],
            "plan": None,
            "labels": None,
            "excludedLines": None,
            "pendingMark": None,
        }

    result = process(lines, commands, labels, excluded_lines, pending_mark, execute_cut, execute_paste)
    if result.errors:
        return {
            "id": req_id,
            "errors": [{"line": e.line, "message": e.message} for e in result.errors],
            "plan": None,
            "labels": None,
            "excludedLines": None,
            "pendingMark": None,
        }
    plan = result.plan
    return {
        "id": req_id,
        "errors": [],
        "plan": {"lines": plan.lines, "consumedLines": plan.consumed_lines},
        "labels": result.labels,
        "excludedLines": result.excluded_lines,
        "pendingMark": result.pending_mark,
    }


def main() -> None:
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({"id": None, "errors": [{"line": 0, "message": f"invalid JSON: {e}"}], "plan": None}) + "\n")
            sys.stdout.flush()
            continue
        response = _handle(request)
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
