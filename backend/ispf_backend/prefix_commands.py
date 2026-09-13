"""ISPF-style line prefix-command semantics.

Pure, stdlib-only, no VS Code / IPC awareness — this module takes the
current document as a list of lines plus a batch of prefix-gutter entries
typed by the user, and either rejects the whole batch with structured
errors or returns the resulting document as a LinePlan. Processing is
all-or-nothing: any error in the batch means nothing is applied, matching
ISPF's behavior of refusing to act on a line-command set it can't resolve.

Supported commands (case-insensitive):
  d[n]   delete n lines starting here (default n=1)
  r[n]   repeat this line n times (default n=1)
  rr..rr repeat the block between two `rr` lines once; a count on EITHER
         marker (`rr3`) repeats it that many times instead — if both
         markers carry an explicit count, the closing one wins
  i[n]   insert n blank lines after this line (default n=1)
  c[n]   mark n lines starting here as a copy source. If paired with an
         a/b destination elsewhere in the same batch, copies within the
         document as always (unchanged, immediate, in-file). If left
         WITHOUT a destination by the end of the batch, it instead
         becomes a PENDING MARK — persistent caller-owned state (see the
         `pending_mark` parameter/return value on `process()`), not an
         error and not an immediate clipboard write — that a later CUT
         *primary* command (not a prefix command; this module never
         triggers it on its own) resolves into a clipboard COPY, exactly
         as if `c` meant "copy" and CUT meant "now actually do it".
  m[n]   mark n lines starting here as a move source. Same in-file
         behavior as `c[n]` when paired with a/b; left unpaired, it
         becomes the same kind of pending mark, but CUT resolves it into
         a clipboard MOVE (removes the lines) instead of a copy.
  dd..dd delete the block between two `dd` lines (inclusive)
  cc..cc mark the block between two `cc` lines as a copy source — the
         block must still be closed by a second `cc` (unmatched is an
         error, same as `dd`/`mm`/`xx`); see `c[n]` above for what
         happens once it's a valid source with no a/b destination
  mm..mm mark the block between two `mm` lines as a move source (see
         `m[n]` above for the unpaired-mark behavior)
  a      destination marker: "after this line" — pairs with a pending
         c/cc/m/mm source for an immediate in-file copy/move, exactly as
         always. A lone `a` with no pending source is still an error
         (unchanged) — PASTE (a *primary* command, not this one) is the
         only way to insert the clipboard, and it doesn't use a/b at all.
  b      destination marker: "before this line" — same as `a` above.
  )      SHIFT the line's text right by the default shift width (2 columns)
  ))     SHIFT right by 2x the default width per extra repeated `)`
         (`)))` = 3x, etc.) — or use `>`, `>>`, `>>>`, ... instead, an
         alternate spelling ISPF treats as identical to `)`/`))`/`)))`
  )n     SHIFT right by exactly n columns (an explicit override, not a
         multiple of the default width) — `>n` is again the same thing
  (      SHIFT the line's text left by the default shift width (2 columns);
         `((`, `(((`, ... and `<`, `<<`, `<<<`, ... all work the same way
         as their `)`/`>` counterparts above, including `(n`/`<n` for an
         explicit column count. Shifting left is a blind truncation, same
         as real ISPF: it drops the leftmost n characters whether or not
         they're blank, so shifting left too far can discard real text.
  x[n]   EXCLUDE: hide n lines starting here from view (default n=1)
  xx..xx EXCLUDE the block between two `xx` lines (inclusive) from view
         Like a label, EXCLUDE doesn't edit the document — it's
         persistent caller-owned state (see the `excluded_lines`
         parameter/return value on `process()`) that follows its lines
         through restructuring the same way a label does, and it only
         ever grows (more lines hidden) from this module's point of view:
         nothing in the prefix-command grammar un-hides a line once
         excluded here — that's the caller's job (ISPF's own RESET
         primary command, and this project's equivalent).
  .name  LABEL: assign the name (1-8 chars, must start with a letter) to
         this line. Unlike the commands above, a label doesn't restructure
         the document — it's persistent caller-owned state (see the
         `labels` parameter/return value on `process()`) that follows its
         line across restructuring: it moves with a moved line, survives
         on a copy/repeat/insert's *source* line untouched, and is dropped
         if its line is deleted. Names are folded to uppercase and names
         starting with 'Z' are reserved for system labels (ZFIRST/ZLAST),
         matching ISPF; the caller (not this module) is expected to
         resolve those two to the first/last line on demand rather than
         storing them here.
  .      clear whatever label is on this line (no-op if none)
  uc     UPPERCASE this line's text
  lc     lowercase this line's text
  uc..uc / lc..lc  UPPERCASE/lowercase the block between two markers,
         inclusive — like the block delete/copy/move/exclude codes
         above, one `uc` alone would be an error there, but here it
         doesn't need doubling to a 4-letter form: appearing on exactly
         ONE line converts just that line, appearing on exactly TWO
         lines converts the range between them (matching real ISPF),
         and appearing on more than two is rejected as ambiguous.
Neither CUT nor PASTE is a prefix command at all — both are *primary*
commands (`extension/media/primaryCommand.ts`), forwarded to this module
as `execute_cut`/`execute_paste` flags on `process()` rather than typed
in the gutter:

  execute_cut=True    Resolves whatever `pending_mark` was passed in (see
                       c/cc/m/mm above): a "copy" mark COPIES those lines
                       into the shared clipboard (document unchanged); a
                       "move" mark CUTS them (removes them, same as a
                       move always has). Clears `pending_mark` to None
                       either way. An error ("nothing marked for cut") if
                       there's no pending mark to resolve.
  execute_paste={"line": int, "before": bool}
                       Inserts the clipboard's current lines after/before
                       `line` (like `i[n]`, but with the clipboard's
                       actual content instead of n blank lines). Doesn't
                       consume/clear the clipboard, so pasting the same
                       content again later — or in a different open
                       document's batch — is fine. An empty clipboard
                       makes this an error rather than a silent no-op.

The clipboard itself (see `_clipboard`) is genuine mutable module state,
not threaded through `process()`'s parameters/return value the way
`pending_mark`/labels/excluded_lines are — it's deliberately shared
across EVERY call to `process()` for the lifetime of the backend
process, including calls for other open documents, so a PASTE in a
different file can retrieve what a CUT in this one just stored.
"""
from __future__ import annotations

import re

from .models import Command, CommandError, LinePlan, ProcessResult

_SINGLE_RE = re.compile(r"^([drcmix])(\d*)$")
_LABEL_RE = re.compile(r"^\.([A-Za-z][A-Za-z0-9]{0,7})$")
# Group 2 is EITHER more copies of the same character as group 1 (shift by
# a multiple of the default width) OR digits (shift by that exact column
# count) OR empty (a single bare `)`/`(`/`>`/`<`) — never a mix of both,
# so something like "()" or ")3)" falls through to the generic
# "unknown line command" error instead of matching here.
_SHIFT_RE = re.compile(r"^([()<>])(\1*|\d*)$")
_SHIFT_DEFAULT_WIDTH = 2
_BLOCK_REPEAT_RE = re.compile(r"^rr(\d*)$")
_BLOCK_CODES = ("dd", "cc", "mm", "xx")
_DEST_CODES = ("a", "b")
_CASE_CODES = ("uc", "lc")

# The one piece of genuine mutable module state in this otherwise-pure
# module — see the CUT/PASTE entry in the docstring above for why: it
# must survive across `process()` calls for DIFFERENT documents in the
# same backend process, which rules out threading it through the
# request/response protocol the way pending_mark/labels/excluded_lines
# are (those are explicitly per-document, caller-owned). Tests must
# reset this between cases (see test_prefix_commands.py's autouse
# fixture).
_clipboard: list[str] = []


class _ParseError(Exception):
    def __init__(self, line: int, message: str):
        super().__init__(message)
        self.line = line
        self.message = message


def _parse_one(cmd: Command) -> tuple[str, int]:
    """Returns (category, count). category is one of 'd','r','i','c','m','x',
    'dd','cc','mm','xx','a','b'. count is 1 for codes that don't take one."""
    code = cmd.code.strip().lower()
    if code in _BLOCK_CODES or code in _DEST_CODES:
        return code, 1
    m = _SINGLE_RE.match(code)
    if not m:
        raise _ParseError(cmd.line, f"unknown line command '{cmd.code}'")
    category, digits = m.group(1), m.group(2)
    if not digits:
        return category, 1
    count = int(digits)
    if count < 1:
        raise _ParseError(cmd.line, f"repeat count must be at least 1 in '{cmd.code}'")
    return category, count


def _pair_or_single(occurrences: list[int], code_name: str, errors: list[CommandError]) -> tuple[int, int, set[int]] | None:
    """UC/LC share this: the code appearing on exactly one line means
    'just this line', on exactly two means 'the range between them'
    (matching real ISPF), and on more than two is rejected as ambiguous
    rather than guessed at. Returns (start, end, defining) or None (either
    nothing to do, or an error was appended)."""
    if not occurrences:
        return None
    if len(occurrences) == 1:
        line = occurrences[0]
        return line, line, {line}
    if len(occurrences) == 2:
        start, end = sorted(occurrences)
        return start, end, {start, end}
    errors.append(CommandError(
        occurrences[0],
        f"'{code_name}' can mark at most one line or a two-line range; found {len(occurrences)} in this batch",
    ))
    return None


def process(
    lines: list[str],
    commands: list[Command],
    labels: dict[str, int] | None = None,
    excluded_lines: list[int] | None = None,
    pending_mark: dict | None = None,
    execute_cut: bool = False,
    execute_paste: dict | None = None,
) -> ProcessResult:
    global _clipboard
    labels = dict(labels or {})
    excluded_lines = set(excluded_lines or ())
    result_pending_mark = dict(pending_mark) if pending_mark else None
    # Snapshot once, up front: an `execute_paste` here always sees the
    # clipboard as it stood before an `execute_cut` in this SAME call (see
    # the CUT/PASTE docstring entry for why that's simpler and more
    # predictable than trying to make them chain in one call — in
    # practice the caller never actually requests both at once anyway).
    clipboard_snapshot = list(_clipboard)
    commands = [c for c in commands if c.code.strip()]
    if not commands and not execute_cut and execute_paste is None:
        return ProcessResult(
            errors=[],
            plan=LinePlan(lines=list(lines), consumed_lines=[]),
            labels=labels,
            excluded_lines=sorted(excluded_lines),
            pending_mark=result_pending_mark,
        )

    n = len(lines)
    errors: list[CommandError] = []

    seen_lines: dict[int, Command] = {}
    for cmd in commands:
        if cmd.line in seen_lines:
            errors.append(CommandError(cmd.line, f"line {cmd.line} specified more than once in this batch"))
            continue
        if cmd.line < 1 or cmd.line > n:
            errors.append(CommandError(cmd.line, f"line {cmd.line} is out of range (document has {n} lines)"))
            continue
        seen_lines[cmd.line] = cmd
    if errors:
        return ProcessResult(errors=errors, plan=None)

    parsed: list[tuple[int, str, int]] = []  # (line, category, count)
    label_ops: list[tuple[int, str | None]] = []  # (line, new name, or None to clear)
    case_lines: dict[str, list[int]] = {"uc": [], "lc": []}
    pending_rr_count = 1
    for cmd in sorted(commands, key=lambda c: c.line):
        code = cmd.code.strip()
        code_lower = code.lower()
        if code == ".":
            label_ops.append((cmd.line, None))
            continue
        label_match = _LABEL_RE.match(code)
        if label_match:
            name = label_match.group(1).upper()
            if name.startswith("Z"):
                errors.append(CommandError(
                    cmd.line,
                    f"label '.{name}' is reserved (names starting with 'Z' are reserved for "
                    "system labels like .ZFIRST/.ZLAST)",
                ))
                continue
            label_ops.append((cmd.line, name))
            continue
        shift_match = _SHIFT_RE.match(code)
        if shift_match:
            shift_char, rest = shift_match.group(1), shift_match.group(2)
            direction = -1 if shift_char in "(<" else 1
            if rest and rest[0].isdigit():
                amount = int(rest)
                if amount < 1:
                    errors.append(CommandError(cmd.line, f"shift amount must be at least 1 in '{cmd.code}'"))
                    continue
            else:
                # rest is empty or more copies of shift_char: 1 + len(rest)
                # total occurrences of the character, each worth one
                # default-width shift.
                amount = (1 + len(rest)) * _SHIFT_DEFAULT_WIDTH
            parsed.append((cmd.line, "shift", direction * amount))
            continue
        if code_lower in _CASE_CODES:
            case_lines[code_lower].append(cmd.line)
            continue
        rr_match = _BLOCK_REPEAT_RE.match(code_lower)
        if rr_match:
            digits = rr_match.group(1)
            count = int(digits) if digits else 1
            if count < 1:
                errors.append(CommandError(cmd.line, f"repeat count must be at least 1 in '{cmd.code}'"))
                continue
            parsed.append((cmd.line, "rr", count))
            continue
        try:
            category, count = _parse_one(cmd)
        except _ParseError as e:
            errors.append(CommandError(e.line, e.message))
            continue
        parsed.append((cmd.line, category, count))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    operations: list[tuple] = []
    for code_name, direction in (("uc", "upper"), ("lc", "lower")):
        resolved = _pair_or_single(case_lines[code_name], code_name, errors)
        if resolved:
            start, end, defining = resolved
            operations.append(("case", start, end, direction, defining))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    seen_names: dict[str, int] = {}
    for line, name in label_ops:
        if name is None:
            continue
        if name in seen_names:
            errors.append(CommandError(line, f"label '.{name}' assigned to more than one line in this batch"))
            continue
        seen_names[name] = line
    if errors:
        return ProcessResult(errors=errors, plan=None)

    # operations (appended to the `operations` list built above from
    # UC/LC) also include:
    #   ("delete", start, end, defining_lines)
    #   ("repeat", line, count, defining_lines)
    #   ("repeat_block", start, end, count, defining_lines)
    #   ("insert", line, count, defining_lines)
    #   ("copy"/"move", start, end, dest, before, defining_lines)
    pending_block: dict[str, int | None] = {"dd": None, "cc": None, "mm": None, "xx": None, "rr": None}
    # Copy/move sources and their a/b destination markers don't have to
    # appear in a fixed relative order (moving a line UP means the
    # destination marker's line number is smaller than the source's), so
    # they're collected here in scan order and paired up afterward rather
    # than resolved inline.
    src_dest_events: list[tuple[str, dict]] = []

    for line, category, count in parsed:
        if category in _BLOCK_CODES or category == "rr":
            if pending_block[category] is None:
                pending_block[category] = line
                if category == "rr":
                    pending_rr_count = count
                continue
            start, end = pending_block[category], line
            pending_block[category] = None
            if category == "dd":
                operations.append(("delete", start, end, {start, end}))
            elif category == "xx":
                operations.append(("exclude", start, end, {start, end}))
            elif category == "rr":
                # Whichever marker gave an explicit (>1) count wins; the
                # closing one is checked first since it's more likely to
                # be the one someone actually meant if both happen to
                # specify one (a rare, unrecommended thing to do anyway).
                final_count = count if count > 1 else (pending_rr_count if pending_rr_count > 1 else 1)
                operations.append(("repeat_block", start, end, final_count, {start, end}))
            else:
                kind = "copy" if category == "cc" else "move"
                src_dest_events.append(("source", {"kind": kind, "start": start, "end": end,
                                                     "anchor": start, "defining": {start, end}}))
        elif category in ("d", "r", "i", "x"):
            if category == "d":
                operations.append(("delete", line, line + count - 1, {line}))
            elif category == "r":
                operations.append(("repeat", line, count, {line}))
            elif category == "i":
                operations.append(("insert", line, count, {line}))
            else:  # x
                operations.append(("exclude", line, line + count - 1, {line}))
        elif category in ("c", "m"):
            kind = "copy" if category == "c" else "move"
            end = line + count - 1
            src_dest_events.append(("source", {"kind": kind, "start": line, "end": end,
                                                 "anchor": line, "defining": {line}}))
        elif category == "shift":
            operations.append(("shift", line, count, {line}))  # count here is the signed column delta
        else:  # 'a' / 'b'
            src_dest_events.append(("dest", {"line": line, "before": category == "b"}))

    for code, open_line in pending_block.items():
        if open_line is not None:
            errors.append(CommandError(open_line, f"unmatched '{code}' starting at line {open_line}"))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    pending: tuple[str, dict] | None = None
    for event_type, info in src_dest_events:
        if pending is None:
            pending = (event_type, info)
            continue
        if pending[0] == event_type:
            if event_type == "source":
                errors.append(CommandError(
                    info["anchor"],
                    f"line {info['anchor']}: a new {info['kind']} source cannot start until the "
                    f"pending {pending[1]['kind']} from line {pending[1]['anchor']} gets a "
                    f"destination marker (a/b)",
                ))
            else:
                errors.append(CommandError(
                    info["line"],
                    f"destination marker on line {info['line']} has no pending copy or move command",
                ))
            break
        source_info, dest_info = (pending[1], info) if pending[0] == "source" else (info, pending[1])
        operations.append((source_info["kind"], source_info["start"], source_info["end"],
                            dest_info["line"], dest_info["before"],
                            source_info["defining"] | {dest_info["line"]}))
        pending = None
    if pending is not None and not errors:
        event_type, info = pending
        if event_type == "source":
            # A single leftover, unpaired c/cc/m/mm source: this is where
            # it becomes a pending mark (see the c/cc/m/mm docstring
            # entries above) rather than an error — but not if the caller
            # already had one pending (from an earlier batch) that hasn't
            # been resolved with CUT yet; stacking a second one silently
            # would just lose track of the first.
            if result_pending_mark is not None:
                errors.append(CommandError(
                    info["anchor"],
                    f"a {result_pending_mark['kind']} mark from line(s) "
                    f"{result_pending_mark['start']}-{result_pending_mark['end']} is already pending "
                    "— use CUT first",
                ))
            else:
                result_pending_mark = {"kind": info["kind"], "start": info["start"], "end": info["end"]}
        else:
            # A lone a/b with no pending source: still an error, same as
            # always — PASTE (a primary command) is the only route to the
            # clipboard's destination side, and it doesn't use a/b.
            errors.append(CommandError(
                info["line"],
                f"destination marker on line {info['line']} has no pending copy or move command",
            ))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    if execute_cut:
        if result_pending_mark is None:
            errors.append(CommandError(0, "nothing marked for cut — use c/cc or m/mm first"))
        else:
            clip_kind = "clip_copy" if result_pending_mark["kind"] == "copy" else "cut"
            operations.append((clip_kind, result_pending_mark["start"], result_pending_mark["end"],
                                {result_pending_mark["start"], result_pending_mark["end"]}))
            result_pending_mark = None
    if errors:
        return ProcessResult(errors=errors, plan=None)

    if execute_paste is not None:
        if not clipboard_snapshot:
            errors.append(CommandError(execute_paste["line"], "clipboard is empty, nothing to paste"))
        else:
            operations.append(("paste", execute_paste["line"], len(clipboard_snapshot),
                                execute_paste["before"], {execute_paste["line"]}))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    # Range/overlap validation. SHIFT is deliberately exempt: it only ever
    # touches the single line it's typed on (no implicit range the way
    # delete/repeat/insert/exclude's counts do), and that line's own
    # in-range/not-duplicated status is already checked above via
    # `seen_lines` — its second tuple field is a signed column delta, not
    # an end-line, so it must never reach the generic start/end unpacking
    # below.
    for op in operations:
        kind = op[0]
        if kind == "shift":
            continue
        if kind in ("case", "repeat_block", "paste"):
            _, start, end, _extra, defining = op
        elif kind in ("delete", "repeat", "insert", "exclude", "cut", "clip_copy"):
            _, start, end, defining = op
        else:
            _, start, end, dest, _before, defining = op
            if dest > n or dest < 1:
                errors.append(CommandError(dest, f"destination on line {dest} is out of range (document has {n} lines)"))
                continue
            if start <= dest <= end:
                errors.append(CommandError(dest, f"destination on line {dest} falls inside its own source range {start}-{end}"))
                continue
        if end > n:
            errors.append(CommandError(start, f"line command starting at line {start} extends past the end of the file ({n} lines)"))
            continue
        for implicit_line in range(start, end + 1):
            if implicit_line in defining:
                continue
            if implicit_line in seen_lines:
                errors.append(CommandError(
                    implicit_line,
                    f"line {implicit_line} has its own line command and cannot also fall inside "
                    f"the range of the command starting at line {start}",
                ))
    if errors:
        return ProcessResult(errors=errors, plan=None)

    # Build the new document via ordered (major, minor) keys: major = an
    # anchor original line number, minor orders content inserted at that
    # anchor (negative = before the anchor's own line, positive = after).
    entries: dict[tuple[int, int], str] = {(i + 1, 0): text for i, text in enumerate(lines)}
    delete_set: set[int] = set()
    # Tracks, for each original line number, which entries-key its content
    # ends up under — (line, 0) unless a move relocates it. Used below to
    # carry labels through the restructuring: a label follows its line's
    # content, not a fixed line number. copy/repeat/insert don't touch
    # this map, since the ORIGINAL line's content stays at (line, 0)
    # (copies/repeats/inserted blanks are new lines that never held a
    # label, and only take on one of their own via a fresh `.name` op).
    line_new_key: dict[int, tuple[int, int]] = {i + 1: (i + 1, 0) for i in range(n)}
    # Set if this batch has a `cut` — committed to the real `_clipboard`
    # global only once we know the whole batch succeeds (see the return at
    # the bottom); `lines` (the ORIGINAL, unmutated input) is still exactly
    # what was on-screen when `cut` was typed, so it's safe to read here.
    pending_clipboard_update: list[str] | None = None

    for op in operations:
        kind = op[0]
        if kind == "delete":
            _, start, end, _defining = op
            delete_set.update(range(start, end + 1))
        elif kind == "repeat":
            _, line, count, _defining = op
            for k in range(1, count + 1):
                entries[(line, k)] = lines[line - 1]
        elif kind == "repeat_block":
            _, start, end, count, _defining = op
            block = [lines[i - 1] for i in range(start, end + 1)]
            minor = 1
            for _rep in range(count):
                for text in block:
                    entries[(end, minor)] = text
                    minor += 1
        elif kind == "insert":
            _, line, count, _defining = op
            for k in range(1, count + 1):
                entries[(line, k)] = ""
        elif kind == "paste":
            _, line, _count, before, _defining = op
            if before:
                base = -len(clipboard_snapshot)
                for idx, text in enumerate(clipboard_snapshot):
                    entries[(line, base + idx)] = text
            else:
                for idx, text in enumerate(clipboard_snapshot, start=1):
                    entries[(line, idx)] = text
        elif kind == "exclude":
            continue  # doesn't touch the document at all; folded in below
        elif kind == "cut":
            _, start, end, _defining = op
            pending_clipboard_update = [lines[i - 1] for i in range(start, end + 1)]
            delete_set.update(range(start, end + 1))
        elif kind == "clip_copy":
            _, start, end, _defining = op
            # Non-destructive: unlike `cut`, no delete_set update — the
            # source lines are left exactly as they are.
            pending_clipboard_update = [lines[i - 1] for i in range(start, end + 1)]
        elif kind == "case":
            _, start, end, direction, _defining = op
            for ln in range(start, end + 1):
                text = lines[ln - 1]
                entries[(ln, 0)] = text.upper() if direction == "upper" else text.lower()
        elif kind == "shift":
            _, line, delta, _defining = op
            text = lines[line - 1]
            # Right: prepend `delta` blanks. Left: blindly drop the
            # leftmost `-delta` characters (Python slicing already clamps
            # to "" if that's more than the line's length) — matching real
            # ISPF, shifting left past the line's content discards it
            # rather than stopping at the first non-blank character.
            entries[(line, 0)] = (" " * delta + text) if delta > 0 else text[-delta:]
        else:  # copy / move
            _, start, end, dest, before, _defining = op
            block = [lines[i - 1] for i in range(start, end + 1)]
            if before:
                base = -len(block)
                for idx, text in enumerate(block):
                    key = (dest, base + idx)
                    entries[key] = text
                    if kind == "move":
                        line_new_key[start + idx] = key
            else:
                for idx, text in enumerate(block):
                    key = (dest, idx + 1)
                    entries[key] = text
                    if kind == "move":
                        line_new_key[start + idx] = key
            if kind == "move":
                delete_set.update(range(start, end + 1))

    for line in delete_set:
        # Always vacate the old (line, 0) anchor slot — for a plain delete
        # it's the only copy of that content, and for a move the content
        # has already been re-homed under a new key above, so this slot
        # would otherwise be a stale duplicate.
        entries.pop((line, 0), None)
        if line_new_key.get(line) == (line, 0):
            # A plain delete (not a move): the mapping still points at the
            # now-vacated anchor, so drop it — any label here is gone.
            # A move already repointed this entry elsewhere above, so it's
            # left alone here.
            del line_new_key[line]

    sorted_keys = sorted(entries.keys())
    key_to_new_line = {key: idx + 1 for idx, key in enumerate(sorted_keys)}
    result_lines = [entries[key] for key in sorted_keys]
    consumed_lines = sorted(seen_lines.keys())

    new_labels: dict[str, int] = {}
    for name, old_line in labels.items():
        key = line_new_key.get(old_line)
        if key is None:
            continue  # that line was deleted by this batch; label drops
        new_labels[name] = key_to_new_line[key]
    for line, name in label_ops:
        resolved_line = key_to_new_line[line_new_key[line]]
        for existing in [n for n, l in new_labels.items() if l == resolved_line]:
            del new_labels[existing]
        if name is not None:
            new_labels[name] = resolved_line

    # Same remap as labels, but for a bare set of hidden lines rather than
    # a name->line map: carry forward whatever was already excluded (drop
    # anything whose line got deleted, follow anything that moved), then
    # add every line newly excluded by this batch's x/xx ops.
    new_excluded: set[int] = set()
    for old_line in excluded_lines:
        key = line_new_key.get(old_line)
        if key is None:
            continue
        new_excluded.add(key_to_new_line[key])
    for op in operations:
        if op[0] != "exclude":
            continue
        _, start, end, _defining = op
        for original_line in range(start, end + 1):
            new_excluded.add(key_to_new_line[line_new_key[original_line]])

    if pending_clipboard_update is not None:
        # Only commit the shared clipboard once the whole batch is known to
        # succeed — every earlier error-return above happens before this
        # point, so an invalid batch containing a `cut` never touches it.
        _clipboard = pending_clipboard_update

    # Same drop-on-delete/follow-on-move remap as labels/excluded_lines,
    # for the pending copy/move mark (if any — None if there never was one,
    # or if `execute_cut` just resolved and cleared it above).
    if result_pending_mark is not None:
        key_start = line_new_key.get(result_pending_mark["start"])
        key_end = line_new_key.get(result_pending_mark["end"])
        if key_start is None or key_end is None:
            result_pending_mark = None
        else:
            result_pending_mark = {
                "kind": result_pending_mark["kind"],
                "start": key_to_new_line[key_start],
                "end": key_to_new_line[key_end],
            }

    return ProcessResult(
        errors=[],
        plan=LinePlan(lines=result_lines, consumed_lines=consumed_lines),
        labels=new_labels,
        excluded_lines=sorted(new_excluded),
        pending_mark=result_pending_mark,
    )
