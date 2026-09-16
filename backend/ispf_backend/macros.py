"""SPFVS edit macros — Phase 1 of the macro-support plan (see CLAUDE.md's
"macro-support planning" entries for the full design discussion).

A macro is a plain Python file that defines a module-level
`run(ctx, args)` function. `ctx` is an `EditContext` bound to a SNAPSHOT
of the document as it stood when the macro was invoked; `args` is the
list of tokens typed after the macro's name in `COMMAND ===>`. Real
ISPF's own edit macros are REXX scripts driving the document through
`ISREDIT` subcommands (FIND FIRST/NEXT + RC checks, DO WHILE loops,
etc.) — this module's `EditContext` covers the same *capability* with
plain Python idioms (iterators instead of FIND/NEXT + RC-driven loops,
real return values/exceptions instead of a numeric RC) rather than
attempting REXX syntax compatibility. See the repo's `.spfvs/macros/
todocomment.py` for a worked translation of a sample REXX macro.

Deliberately kept separate from `prefix_commands.py`'s engine and its
request/response protocol shape (see `server.py`'s `type: "runMacro"`
dispatch) — a bug in macro execution can never touch the well-tested
prefix-command path, and vice versa.

Phase 1 is intentionally non-interactive and snapshot-based: a macro
receives the whole document, cursor line, and its arguments in ONE
call, and returns a (possibly modified) document, cursor line, and a
message string — there's no way for a macro to prompt the user mid-run
or see live typing, unlike real ISPF's `LMSG`/panel-display macros.

Deliberately NOT built yet (future phases, not forgotten):
  - a global (not just workspace-local) macro search path
  - interactive/multi-round macros (prompts, panels)
  - reading/writing excluded-lines or the CUT-PASTE clipboard from
    inside a macro (labels can now be both read AND set/cleared — see
    EditContext.resolve_label/set_label/clear_label — added 2026-09-16)
  - issuing a full prefix-command batch (e.g. a `d3`-equivalent) from
    inside a macro
  - dedicated copy/move helpers — `insert_before`/`insert_after`/
    `delete_line`/`delete_lines` (added 2026-09-16) make Copy/Move
    achievable by composition (read a line's text, insert it elsewhere,
    optionally delete the original), but there's no single call that
    does it in one step yet
"""
from __future__ import annotations

import contextlib
import io
import re
from dataclasses import dataclass

# Must match prefix_commands.py's own _LABEL_RE exactly (1-8 alphanumeric
# characters, starting with a letter) -- restated here rather than
# imported, since that name is that module's own private implementation
# detail and this module is deliberately kept independent of it (see the
# module docstring). Keep the two in sync by hand if either ever changes.
_LABEL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,7}$")


class MacroError(Exception):
    """Raised by EditContext methods for macro-caused errors (e.g. an
    out-of-range line number) — caught by `run_macro()` and reported the
    same way an uncaught exception from the macro's own code is, so a
    macro author sees one consistent kind of failure regardless of
    whether it came from their code or from misusing the API."""


@dataclass
class Match:
    """One `find_all()` hit."""
    line: int
    text: str


class EditContext:
    """The API surface passed into a macro's `run(ctx, args)`. Kept
    deliberately small for Phase 1 — see the module docstring for what's
    still missing. All mutations apply to an in-memory copy; nothing
    touches the real document until `run_macro()` reads the result back
    out via `result_lines()`."""

    def __init__(self, lines: list[str], cursor_line: int, labels: dict[str, int] | None = None):
        self._lines = list(lines)
        # Defensively clamped rather than trusting the caller — a macro
        # should never start with an already-invalid cursor position,
        # even if the caller's own value were somehow stale/wrong.
        self._cursor_line = max(1, min(cursor_line, len(self._lines))) if self._lines else 1
        # Already-uppercase name -> line, exactly as prefix_commands.py's
        # own LABEL handling stores them (`.name` is folded to uppercase
        # when set). Mutable — see set_label/clear_label — and remapped
        # through insert/delete the same way prefix_commands.py's own
        # `process()` remaps its caller-owned labels dict.
        self._labels = dict(labels or {})
        self.messages: list[str] = []

    @property
    def line_count(self) -> int:
        return len(self._lines)

    @property
    def first_line(self) -> int:
        return 1

    @property
    def last_line(self) -> int:
        return len(self._lines)

    @property
    def cursor_line(self) -> int:
        return self._cursor_line

    @cursor_line.setter
    def cursor_line(self, value: int) -> None:
        if not (1 <= value <= len(self._lines)):
            raise MacroError(f"cursor_line {value} is out of range (document has {len(self._lines)} lines)")
        self._cursor_line = value

    def get_line(self, line: int) -> str:
        self._check_range(line)
        return self._lines[line - 1]

    def set_line(self, line: int, text: str) -> None:
        self._check_range(line)
        self._lines[line - 1] = text

    # change_line is a plain alias — REXX-flavored macros tend to think
    # in terms of "change this line's text", others in terms of a
    # straight assignment; both spellings do the exact same thing.
    change_line = set_line

    def insert_after(self, line: int, text: str) -> None:
        """Inserts a new line containing `text` immediately after
        `line` — `insert_after(ctx.last_line, text)` appends to the end
        of the document. `line` must be a real, existing line number
        (this can't insert into a genuinely empty, zero-line document —
        not a real-world case, since VS Code documents always have at
        least one line, even an empty one). Changes `line_count`; a
        `cursor_line` that pointed past the new end is clamped (see
        `_clamp_cursor`) — it is NOT otherwise shifted to "follow" the
        content around it the way copy/move remapping does for gutter
        commands, so a macro that cares about the cursor's position
        relative to what it just inserted should set `ctx.cursor_line`
        explicitly afterward rather than assume it moved."""
        self._check_range(line)
        self._lines.insert(line, text)
        self._remap_labels_for_insert(line + 1)
        self._clamp_cursor()

    def insert_before(self, line: int, text: str) -> None:
        """Inserts a new line containing `text` immediately before
        `line` — `insert_before(ctx.first_line, text)` prepends to the
        start of the document. Same range requirement and cursor
        behavior as `insert_after`."""
        self._check_range(line)
        self._lines.insert(line - 1, text)
        self._remap_labels_for_insert(line)
        self._clamp_cursor()

    def delete_line(self, line: int) -> None:
        """Removes `line` entirely, shifting every later line up by
        one. Changes `line_count`; see `insert_after`'s note on
        `cursor_line` not being auto-tracked, only clamped back into
        range if it now points past the new end."""
        self._check_range(line)
        del self._lines[line - 1]
        self._remap_labels_for_delete(line, line)
        self._clamp_cursor()

    def delete_lines(self, start: int, end: int) -> None:
        """Removes the inclusive range `start`..`end` in one operation
        — safer than a loop of `delete_line()` calls, which would shift
        every later line's number out from under you after each one."""
        self._check_range(start)
        self._check_range(end)
        if end < start:
            raise MacroError(f"delete_lines: end ({end}) is before start ({start})")
        del self._lines[start - 1 : end]
        self._remap_labels_for_delete(start, end)
        self._clamp_cursor()

    def find_all(self, text: str) -> list[Match]:
        """Every line currently containing `text` (a plain substring
        search, not a regex), in document order.

        This is a SNAPSHOT taken at call time, not a live re-scan: the
        whole match list is computed once, up front, from the document
        as it stood at the moment `find_all()` was called. If your
        macro mutates a matched line and then keeps iterating the SAME
        result list, later entries still describe their pre-mutation
        content — call `find_all()` again afterward if you need
        up-to-date results. This is simpler to reason about than a live
        re-scan (real ISPF's own FIND NEXT re-searches live, cursor-
        relative) and avoids resumption bugs when a mutation changes a
        line's length; worth revisiting if a real macro needs live
        re-scanning instead. The same snapshot caution applies even more
        so once `insert_after`/`insert_before`/`delete_line`/
        `delete_lines` are involved: a match's `.line` number can be
        entirely wrong (pointing at a different line, or past the new
        end of the document) after ANY restructuring elsewhere in the
        document, not just a same-line text edit — call `find_all()`
        again after restructuring rather than reusing an old result.
        """
        return [Match(line=i + 1, text=t) for i, t in enumerate(self._lines) if text in t]

    def resolve_label(self, name: str) -> int | None:
        """The line number for an ISPF-style label — `.name`, `.ZFIRST`,
        `.ZLAST`, or `.ZCSR` (leading `.` optional either way; folded to
        uppercase, matching how labels are stored). Returns `None` if
        `name` isn't a reserved name and isn't currently set — mirrors
        `find_all()` returning an empty list rather than raising for "no
        match", since "this label doesn't exist" is an ordinary outcome
        a macro should be able to branch on, not necessarily an error.

        `.ZFIRST`/`.ZLAST`/`.ZCSR` are computed here exactly like real
        ISPF's own reserved labels (and this project's primary commands'
        `resolveLabel` in gutter.ts) — first line, last line, and the
        cursor's CURRENT line respectively — never looked up in the
        `labels` map, since they're not stored state.
        """
        key = name[1:] if name.startswith(".") else name
        key = key.upper()
        if key == "ZFIRST":
            return self.first_line
        if key == "ZLAST":
            return self.last_line
        if key == "ZCSR":
            return self.cursor_line
        return self._labels.get(key)

    def set_label(self, name: str, line: int) -> None:
        """Assigns `name` (1-8 alphanumeric characters, must start with a
        letter — exactly `prefix_commands.py`'s own LABEL validation, see
        `_LABEL_NAME_RE`) to `line`. The leading `.` is optional either
        way and the name is folded to uppercase, matching a gutter
        `.name` commit. Names starting with `Z` are rejected — reserved
        for `.ZFIRST`/`.ZLAST`/`.ZCSR` — same as the gutter's own LABEL
        command. Only one label per line: if another name already points
        at `line`, it's removed first (so re-labeling a line always
        leaves exactly one name on it, never two)."""
        self._check_range(line)
        key = name[1:] if name.startswith(".") else name
        key = key.upper()
        if not _LABEL_NAME_RE.match(key):
            raise MacroError(
                f"'{name}' isn't a valid label name (1-8 letters/digits, must start with a letter)"
            )
        if key.startswith("Z"):
            raise MacroError(
                f"label '.{key}' is reserved (names starting with 'Z' are reserved for "
                "system labels like .ZFIRST/.ZLAST)"
            )
        for existing in [n for n, l in self._labels.items() if l == line]:
            del self._labels[existing]
        self._labels[key] = line

    def clear_label(self, name: str) -> None:
        """Removes `name` if it's currently set — a no-op (not an error)
        if it isn't, same as real ISPF's own `.` clear behaves whether or
        not a label was actually there."""
        key = name[1:] if name.startswith(".") else name
        self._labels.pop(key.upper(), None)

    def result_labels(self) -> dict[str, int]:
        """The label map as it stands after everything the macro did —
        read by `run_macro()` once `run()` returns; not meant to be
        called by the macro itself."""
        return dict(self._labels)

    def message(self, text: str) -> None:
        """Appends a line to the macro's message log — real ISPF's SAY
        equivalent. Every `message()` call, plus anything the macro
        printed via a plain `print()`, is combined (see `run_macro()`)
        and shown to the user once the macro finishes."""
        self.messages.append(str(text))

    def result_lines(self) -> list[str]:
        """The document as it stands after everything the macro did —
        read by `run_macro()` once `run()` returns; not meant to be
        called by the macro itself."""
        return list(self._lines)

    def _check_range(self, line: int) -> None:
        if not (1 <= line <= len(self._lines)):
            raise MacroError(f"line {line} is out of range (document has {len(self._lines)} lines)")

    def _clamp_cursor(self) -> None:
        """Called after every insert/delete — keeps `cursor_line` a
        valid line number if the document shrank out from under it
        (e.g. the cursor was on line 10 and a macro just deleted lines
        8-12). Deliberately just a clamp, not an attempt to track WHERE
        the cursor's original line went — see insert_after's docstring."""
        if not self._lines:
            self._cursor_line = 1
            return
        if self._cursor_line > len(self._lines):
            self._cursor_line = len(self._lines)

    def _remap_labels_for_insert(self, at_line: int) -> None:
        """Called after a new line has been spliced in at `at_line`
        (1-based, the new line's own position) — every existing label on
        `at_line` or later shifts down by one to keep pointing at the
        same CONTENT it did before, same as prefix_commands.py's own
        `line_new_key`/`key_to_new_line` remapping does for an insert."""
        for name, line in list(self._labels.items()):
            if line >= at_line:
                self._labels[name] = line + 1

    def _remap_labels_for_delete(self, start: int, end: int) -> None:
        """Called after the inclusive range `start`..`end` (1-based, the
        line numbers as they stood BEFORE the delete) has been removed —
        a label inside that range is dropped (its line no longer exists,
        same as a gutter `d`/`dd` drops a label on a deleted line); a
        label after it shifts up by the number of lines removed."""
        removed = end - start + 1
        for name, line in list(self._labels.items()):
            if start <= line <= end:
                del self._labels[name]
            elif line > end:
                self._labels[name] = line - removed


@dataclass
class MacroResult:
    ok: bool
    lines: list[str] | None = None
    cursor_line: int | None = None
    labels: dict[str, int] | None = None
    message: str = ""
    error: str | None = None


def run_macro(
    source_path: str,
    lines: list[str],
    cursor_line: int,
    args: list[str],
    labels: dict[str, int] | None = None,
) -> MacroResult:
    """Loads the Python file at `source_path`, expects a module-level
    `run(ctx, args)`, and calls it. Every failure mode — the file can't
    be read, it doesn't parse, it has no `run` function, or `run()`
    itself raises — is caught here and turned into a `MacroResult` with
    `error` set, never propagated: a broken macro must never crash the
    shared backend process every other open document's tab depends on.

    `labels` is the caller's current name->line map (see
    prefix_commands.py's LABEL docstring), handed to `EditContext` for
    `resolve_label()`/`set_label()`/`clear_label()`; the (possibly
    changed) map is read back via `result_labels()` and returned as
    `MacroResult.labels` for the caller to persist, same as `lines`.
    """
    try:
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
    except OSError as e:
        return MacroResult(ok=False, error=f"could not read macro file '{source_path}': {e}")

    # A fresh namespace per run — never the module's own globals — so
    # one macro can't see or clobber another's state, and re-running the
    # same macro always starts clean.
    namespace: dict = {"__name__": "__spfvs_macro__", "__file__": source_path}
    try:
        code = compile(source, source_path, "exec")
        exec(code, namespace)
    except Exception as e:
        return MacroResult(ok=False, error=f"macro '{source_path}' failed to load: {e}")

    run_fn = namespace.get("run")
    if not callable(run_fn):
        return MacroResult(ok=False, error=f"macro '{source_path}' has no run(ctx, args) function")

    ctx = EditContext(lines, cursor_line, labels)
    stdout_capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout_capture):
            run_fn(ctx, args)
    except MacroError as e:
        return MacroResult(ok=False, error=str(e))
    except Exception as e:
        return MacroResult(ok=False, error=f"macro '{source_path}' raised an error: {e}")

    parts = list(ctx.messages)
    captured = stdout_capture.getvalue()
    if captured.strip():
        parts.append(captured.rstrip("\n"))
    return MacroResult(
        ok=True,
        lines=ctx.result_lines(),
        cursor_line=ctx.cursor_line,
        labels=ctx.result_labels(),
        message="\n".join(parts),
    )
