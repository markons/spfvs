# CLAUDE.md — project notes for spfvs

A VS Code custom editor recreating the ISPF full-screen editing experience:
Monaco embedded in a webview, with a real editable prefix-command gutter
(not just decorative line numbers) and an ISPF-style primary command line
(`COMMAND ===>`). Owner: markons (Gabor Markon). Product/extension name is
"SPFVS" (renamed from "ISPF Editor" on 2026-09-13 — see the status entry
below); "ISPF"/"ispf" still appears throughout as internal identifiers
(Python package `ispf_backend`, the `ispfEditorProvider.ts` source file
and its `IspfEditorProvider` class, the `ispfEditor.editor` viewType) and
as a plain descriptive term for the mainframe editing paradigm this
project recreates — that's deliberate, not a leftover, see the rename's
status entry for what was and wasn't touched. Folder is
`C:\Users\maga1\Documents\GitHub\spfvs\` (renamed from `...\ispf-editor\`
same day; don't confuse either with the unrelated repo git finds by
walking up to `C:\Users\maga1`).

## Status as of 2026-09-14 (latest): FIND/CHANGE column-range restriction

Added ISPF's `FIND string c1 c2` / `CHANGE old new c1 c2` form
(`extension/media/primaryCommand.ts`, webview-only, no backend change):
appending two integers right after the search text (and, for `CHANGE`,
the replacement text too) restricts matches to ones lying **entirely**
within columns `c1`-`c2` (1-indexed, inclusive) — `find 'xxx' 8 10` only
matches `xxx` where it fits inside columns 8-10. Owner explicitly flagged
this as missing ("in find and change, the ispf-like column specification
is not implemented"), after an earlier back-and-forth in this same
session where they said CHANGE itself was already fine (a false alarm —
CHANGE (find/replace with FIRST/LAST/NEXT/PREV/ALL scopes) already
existed and was already installed; column restriction was the actual,
real gap).

New `extractColumnRange(args, minRemaining)` mirrors the existing
`extractTrailingScope` disambiguation pattern: it only claims a trailing
`c1 c2` pair as columns if at least `minRemaining` tokens are left over
afterward (1 for FIND's needle, 2 for CHANGE's old+new) — otherwise e.g.
`find 100 200` (exactly two tokens, no room for both a needle AND
columns) is read as a literal two-word search, matching a real ambiguity
ISPF itself has (quote a numeric-looking search string to force it to be
read as text: `find '100' 8 10`). Column filtering
(`withinColumnRange`) checks a match's `startColumn`/`endColumn` fall
inside the range — Monaco's `endColumn` is one PAST the last matched
character, so the check is `startColumn >= c1 && endColumn - 1 <= c2`.

Architecturally, column restriction bypasses Monaco's native
`findNextMatch`/`findPreviousMatch` (which have no notion of column
limits) only when a range is actually given: it instead pulls every raw
match via `findMatches` and picks one manually via a new `pickMatch()`
helper that replicates NEXT/PREV wrap-around by comparing match start
positions against the cursor with a plain `comparePositions()`. With no
column range, the original per-scope Monaco-native calls are used
completely unchanged — deliberately keeping the (far more common)
unrestricted path exactly as tested/shipped before, rather than
funneling everything through the new manual-picking code and risking a
subtle wrap-around behavior difference from Monaco's own. A bare
`FIND`/`RFIND` repeat now also remembers and reuses the last explicit
FIND's column range (new module-level `lastFindColumnRange`), alongside
the existing `lastFindNeedle`/`lastFindDirection`.

`npm run typecheck` and `npm run compile` both pass. No backend
involvement, so no new pytest cases (94 still the total, unchanged) —
this is pure webview command-parsing, same category as FIND FIRST/LAST/
RFIND. Packaged and installed as **v0.0.18**. **Not yet tested by the
owner.**

## Status as of 2026-09-14: CUT/PASTE primary commands + pending mark, + HOME key

Two features. The CUT/PASTE design below is a **correction of a prior
same-day attempt** — worth understanding both what changed and why, in
case a future session finds references to the old shape (e.g. in git
history or a stale mental model): the owner's first request ("realize
the c/cc line command to copy the selected line(s) to the clipboard by
the cut command, as well its counterpart paste used with a/b as target")
was genuinely ambiguous, and the first implementation guessed wrong — it
made an unpaired `c`/`cc`/`m`/`mm` write the clipboard *immediately*, and
a lone `a`/`b` auto-paste. The owner then corrected this explicitly:
"c/cc m/mm functions only paired with the cut promary command. workflow:
type c/cc m/mm by typing it on a line/line area. the use the cut promary
command to copy/move it to the clipboard. then one can use the paste
promary command to cy the clipboard a(fter) b(efore) the selected lin.
and yes, cc mm without pair is an error." The corrected design below is
what's actually implemented now; the immediate-write/auto-paste shape
was fully reverted, not layered on top of.

**1. CUT/PASTE primary commands + a persistent "pending mark"**

`c[n]`/`cc`...`cc` and `m[n]`/`mm`...`mm` paired with `a`/`b` in the same
gutter batch are **completely unchanged** — immediate in-file copy/move,
exactly as before this whole feature existed. What's new is what happens
when one is left **unpaired** at the end of a batch: instead of erroring
("has no destination marker"), it becomes a **pending mark** — one
`{kind: "copy"|"move", start, end}` slot, per-document state that
behaves exactly like a LABEL for remapping purposes (follows a move,
drops if its line is deleted, remapped through `line_new_key`/
`key_to_new_line` same as labels/excluded_lines — see `process()`'s new
`pending_mark` parameter/return value in `prefix_commands.py`). Setting
a new mark while one is already pending is an error ("use CUT first") —
there's only ever one slot. A lone `a`/`b` with no pending source to pair
with is, again, an ordinary **error** ("has no pending copy or move
command") — there is no auto-paste. An unmatched `cc`/`mm` block (opened,
never closed) is also still an error, confirmed explicitly by the owner
("cc mm without pair is an error").

The pending mark is resolved by the new **`CUT`** primary command
(`extension/media/primaryCommand.ts`, forwarded to the extension host as
`{kind:"forward", action:"cut"}`, same mechanism as `resetLabels`): a
`copy`-kind mark copies those lines into the shared clipboard
non-destructively (reuses the `clip_copy` operation kind from the
reverted attempt — no `delete_set` update); a `move`-kind mark cuts them
(the `cut` operation kind, destructive). `CUT` with no pending mark is an
error ("nothing marked for cut — use c/cc or m/mm first"). The new
**`PASTE`** primary command (`paste`/`paste a`/`paste b`, defaulting to
`a`) inserts the clipboard's current contents at the cursor's line,
after or before per that argument — this is the *only* route to a paste,
and it does not use `a`/`b` prefix codes at all (those are gutter/pairing
concepts only). `PASTE` does not consume the clipboard (repeatable).
Backend flags driving this: `process()` gained `execute_cut: bool` and
`execute_paste: {"line": int, "before": bool} | None` — both are
resolved *after* normal command pairing/errors, in that order (cut mark
resolves into an operation, then paste reads whatever's now in the
clipboard). `CUT`/`PASTE` themselves never appear as gutter/prefix
commands; `prefix_commands.py`'s module docstring spells out this split.

The module-level `_clipboard` global in `prefix_commands.py` is
deliberately the ONE exception to the caller-owned-state pattern
everything else here follows — it's real mutable process state, not
threaded through parameters, because it must survive across `process()`
calls for **different documents** (CUT in file A, PASTE in file B),
which the per-document `pending_mark`/labels/excluded_lines pattern
can't do (those are owned by `ispfEditorProvider.ts`'s per-tab closure
and round-trip every call). `pending_mark`, by contrast, IS per-document
closure state in `ispfEditorProvider.ts` (a new `pendingMark` variable
alongside `labels`/`excludedLines`, same reset-on-non-batch-edit rules —
no webview-visible display, since unlike labels there's nothing to show
in the gutter for it). A new `handleClipboardAction()` method there
handles both `CUT` and `PASTE` (routed from `primaryAction` when
`message.action` is `"cut"`/`"paste"`, otherwise the existing
`handlePrimaryAction` path is used); it explicitly skips
`vscode.workspace.applyEdit` when a non-destructive copy's resulting
text is identical to the document's current text, to avoid a
no-op dirty-flag flip / undo-stack entry for an operation that shouldn't
touch the document at all.

Backend: rewrote the clipboard test block (~18 tests) covering pending-
mark creation (single/block, copy/move), setting-while-pending is an
error, remapping through other same-batch operations and later unrelated
batches, dropping when the marked line is deleted, `execute_cut`
resolving both mark kinds (and erroring with no mark), `execute_paste`
after/before/empty-clipboard/non-consuming, and cut-in-one-batch-then-
paste-in-a-different-document's-batch (the key cross-document check,
since the clipboard is a process global but `pending_mark` isn't).
**94 total tests, all passing.**

**Not yet tested by the owner** — see the manual test checklist below
for the specific workflow to try (mark, CUT, move cursor, PASTE a/b).

**2. HOME jumps to the COMMAND ===> bar** — the 3270/ISPF convention of
Home moving to the first input field on the screen.
`extension/media/main.ts`'s `editor.onKeyDown` intercepts plain
(no-modifier) Home ONLY when the cursor is already at `{1,1}` (i.e.
Monaco's own Home would be a no-op anyway) — everywhere else in the main
editor, Home keeps doing its normal, heavily-relied-on job (line start /
smart home). `gutter.ts`'s per-cell `keydown` handler intercepts Home
unconditionally instead, since a gutter cell's own "move caret to
position 0 within this 1-9 character input" has negligible value.  Both
funnel into a new shared `jumpToCommandBar()` in main.ts (focus +
select, so typing immediately replaces whatever was there). No backend
involvement, no new pytest cases.

`npm run typecheck` and `npm run compile` both pass for both features.
**Neither has been packaged/installed or tested by the owner yet.**

## Status as of 2026-09-13 (even later): HX line command

Added the `hx`/`hx[n]` prefix command: shows a line's hex representation
as two rows underneath it (high nibble, low nibble — one hex digit per
row per character, directly under that character, not two digits
squeezed under one monospace column). New module
`extension/media/hexView.ts`'s `HexView` class, driving Monaco's
`changeViewZones`/`addZone`/`removeZone` API directly.

**Architecturally this is a different animal from every other prefix
command so far**, worth internalizing before extending it: it NEVER
reaches the Python backend at all. Every other prefix command (even the
purely-view ones like `x`/`xx`) goes through `gutter.ts`'s `commit()` ->
`onCommit` -> `processPrefixCommands` -> `prefix_commands.py`. `hx` is
intercepted INSIDE `commit()` itself (new `HEX_CODE_RE` regex check,
before anything is pushed into the `commands` array that would otherwise
go to the backend) and routed to a new `onHexToggle` callback instead —
because `hx` has no batch-validation needs (can't conflict with another
command on the same line — impossible anyway, one code per cell; can't
go out of range — the line obviously already exists since it has a
gutter cell) and no restructuring-remap needs (it's explicitly NOT kept
in sync across edits — see below), routing it through the backend would
have been pure overhead for zero benefit. A bare `hx` toggles (matches
real ISPF); the counted form `hx3` only ever shows (never hides) each of
the n lines, to avoid a confusing mixed on/off result if some already
had hex shown and others didn't — asymmetric on purpose, not an
oversight.

Deliberately NOT done, to keep this simple and safe: no remapping
through prefix-command batches the way LABEL/EXCLUDE get (`HexView`
just clears every zone on ANY `onDidChangeModelContent`, full stop,
rather than trying to track which lines moved where — see its class doc
comment); no block form (`hxhx`...`hxhx`) pairing like `dd`/`cc`/`mm`/
`xx`/`xx` get, since the ask was specifically about one selected line at
a time (the counted form `hx3` covers "several consecutive lines"
well enough without needing a second block-marker mechanism); no
byte-accurate UTF-8 (each char is masked to its low byte via `& 0xFF`,
an ISPF-flavored approximation, not a real multi-byte decode).

No backend changes, no new pytest cases (pure webview view-state
feature, same category as the earlier view-position-preservation fix).
`npm run typecheck` and `npm run compile` both pass. **Not yet tested by
the owner.**

## Status as of 2026-09-13 (latest): 6 ISPF-parity features (RR/UC/LC/CUT-PASTE/LOCATE-by-line/PREV/SORT)

Owner asked "which important ISPF editor functions are missing from
spfvs" and got back a ranked list of ~12; asked to "realize all points,
out of 7 and 8 (leave them for a later release)" — i.e. implement
everything except plain-line-number EXCLUDE/DELETE ranges (#7) and the
MASK-line/NUMBER-RENUM/CAPS-ON/HEX-ON/column-ruler/BOUNDS cluster (#8),
both deliberately deferred, not forgotten. **All six done, none tested
by the owner yet.**

1. **`LOCATE` by plain line number** (`extension/media/primaryCommand.ts`):
   `LOCATE 50`/`LOC 50`/`L 50` now works alongside the existing
   `.label` form — `doLocate` gained a `model` param to validate the
   number against `getLineCount()` and branches on `isLabelToken()`.
2. **`UC`/`LC` case conversion** (`prefix_commands.py`): new prefix
   commands, single-line or a two-marker range (see point 3 for why they
   don't double to a 4-letter block form like `dd`/`cc`/`mm`/`xx` do).
   Pure text mutation like SHIFT — doesn't touch `line_new_key`, so
   labels/exclusion on a converted line are unaffected for free.
3. **`RR`...`RR` block repeat** (`prefix_commands.py`): repeats a whole
   *block* (unlike single-line `r[n]`), once by default or a caller-given
   count on either marker (closing wins if both specify one — see the
   `pending_rr_count` comment in `process()`). New `_BLOCK_REPEAT_RE`
   checked before `_parse_one` gets a chance, alongside `dd`/`cc`/`mm`/`xx`
   in the same `pending_block` pairing state machine (added an `"rr"` key).
4. **`CUT`/`PASTE`** (`prefix_commands.py`): the big architectural one —
   see the dedicated design-point paragraph below. **Superseded
   2026-09-14 — see that status entry.** As originally shipped here,
   `cut`/`paste` were themselves prefix/gutter word-commands (typed in a
   gutter cell like any other prefix code) that read/wrote the clipboard
   directly; the owner's next request repurposed `CUT`/`PASTE` into
   **primary** commands (`COMMAND ===>`) that resolve a persistent
   "pending mark" left by an unpaired `c`/`cc`/`m`/`mm` instead. The
   clipboard mechanics described just below (module-global `_clipboard`,
   cross-document persistence, snapshot-at-top-of-`process()`, the
   `global` declaration ordering gotcha, the autouse reset fixture) are
   all still accurate and reused as-is by the new design — only *what
   triggers* a clipboard read/write changed, not the clipboard itself.
5. **`FIND`/`CHANGE` `PREV`** + **`CHANGE` FIRST/LAST** scopes
   (`primaryCommand.ts`): `extractFindScope` was renamed
   `extractTrailingScope` and generalized to return `{rest, scope}`
   instead of a pre-joined needle, so both `doFind` (joins `rest` itself)
   and the rewritten `doChange` (needs `rest` as separate old/new tokens)
   share it. `RFIND`/bare-`FIND` now repeat in the **same direction** as
   the last explicit NEXT/PREV search (new `lastFindDirection` module
   state) — FIRST/LAST/ALL don't update it, since they're one-shot jumps,
   not a direction to continue in.
6. **`SORT`** (`primaryCommand.ts`, new `doSort`): whole-file only (not
   exclusion-aware like real ISPF's — see the design-point paragraph and
   README's "Known limitations"), via a plain `editor.executeEdits` full
   -document replace, same mechanism `CHANGE` already uses. No backend
   involvement at all.

**Design point for future sessions — the CUT/PASTE clipboard is
deliberately NOT per-document caller-owned state like labels/
excluded_lines.** It has to survive `process()` calls for *different*
documents (cut in file A, paste in file B), and each open document's
labels/excludedLines already live in a closure-local variable scoped to
that ONE `resolveCustomTextEditor` call — there's no existing channel for
one document's provider to hand state to another's. Solution: a genuine
Python-process-global `_clipboard: list[str]` in `prefix_commands.py`,
read/written directly by `process()` rather than threaded through its
parameters/return value. This is the ONE deliberate exception to that
module's "pure, no side effects" docstring claim (the claim itself was
left as-is rather than rewritten, since it's still true of everything
else in the file). Consequences worth knowing before touching this code:
  - Tests MUST reset `prefix_commands._clipboard` between cases (added an
    autouse `_reset_clipboard` pytest fixture in
    `test_prefix_commands.py`) — pytest doesn't isolate module globals
    for you.
  - A `paste` op always reads a `clipboard_snapshot` taken at the very
    top of `process()`, BEFORE that same batch's own operations run — a
    `cut` and `paste` in one batch deliberately don't chain (see the
    docstring). The real `_clipboard` global is only written at the very
    end, after every possible error-return, so a batch that fails for an
    unrelated reason never corrupts it (see `test_a_rejected_batch_does_
    not_commit_a_cut_to_the_clipboard`).
  - Unlike labels/excludedLines, nothing in `ispfEditorProvider.ts` ever
    resets the clipboard — it's not per-document state, so there's no
    "this document's edit invalidated it" moment to reset it on. It only
    changes when something is next `cut`, and it's lost if the backend
    process itself restarts (extension host reload).
  - First attempt at `global _clipboard` placed the statement right
    before the assignment near the bottom of `process()` and hit
    `SyntaxError: name '_clipboard' is used prior to global declaration`
    — Python requires `global` to appear before ANY use of the name
    anywhere in the function (including the earlier read-only
    `clipboard_snapshot = list(_clipboard)`), not just before the
    assignment. Fixed by moving it to the top of `process()`.

Backend: 21 new pytest cases (RR/UC/LC/CUT/PASTE), 86 total, all passing.
`npm run typecheck` and `npm run compile` both pass on the extension
side. **Nothing in this entry has been packaged/installed or tested by
the owner** — see the manual test checklist below, and the standing
package+install+relaunch gotcha in the Build section (compiling alone
never touches the installed `.vsix`).

## Status as of 2026-09-13 (latest): renamed to SPFVS, published to GitHub

Renamed the product from "ISPF Editor" to "SPFVS" and published it to a
**private** GitHub repo, `https://github.com/markons/spfvs` (owner chose
private explicitly when asked — no LICENSE yet, no Marketplace listing,
hasn't had a full owner test pass). First commit (`a1c65b5`, "Initial
commit: SPFVS (renamed from ISPF Editor)") pushed to `master`, tracking
`origin/master`.

**Directory situation future sessions need to know**: the folder is now
`C:\Users\maga1\Documents\GitHub\spfvs\`, copied from (not `git mv`'d/
renamed from) `...\ispf-editor\`. A plain directory rename was attempted
first and failed with "Device or resource busy" — root cause turned out
to be this coding session's OWN sandbox, which pins/anchors shell working
directories back to the session's original primary-working-directory
path (`...\ispf-editor\`) after every command; it wasn't a VS Code
window or any other real lock (the owner closed VS Code entirely and it
still failed). Fell back to copying everything except regenerable
artifacts (`node_modules/`, `dist/`, old `.vsix` files, `__pycache__/`,
`*.egg-info/`, `.pytest_cache/`) into a fresh `spfvs/` folder, then did
all renaming/git/publish work there. **The old `...\ispf-editor\` folder
was deliberately left in place on disk** — the owner said they'd delete
it themselves once nothing has it open; don't assume it's gone, and
don't confuse it with the new `spfvs/` folder if a future session's
primary working directory somehow still points at the old path.

What was renamed vs. deliberately left alone (don't "fix" the left-alone
parts later without a reason — this was a scoping decision, not an
oversight): user-facing strings changed — `extension/package.json`'s
`name` (`spfvs`), `displayName` (`SPFVS`), the `customEditors` entry's
`displayName`, `configuration.title`, and the settings key itself
(`ispfEditor.pythonPath` -> `spfvs.pythonPath`, updated everywhere it's
read: `ispfEditorProvider.ts`, and everywhere it's shown: the error
message in `backendClient.ts`), the `.vscode/launch.json` debug config
name, and both README.md/CLAUDE.md's titles and prose. Deliberately
**left as `ispf`-branded internal identifiers** (no user ever sees
these): the Python package name and import path `ispf_backend` (backend/
pyproject.toml, all `python -m ispf_backend` invocations), the
`ispfEditorProvider.ts` source filename and its `IspfEditorProvider`
class name, and the `contributes.customEditors[0].viewType` string
`"ispfEditor.editor"` in package.json (must stay in sync with
`IspfEditorProvider.viewType` in source if either ever changes — they're
not currently linked by anything but manual consistency).

Also caught and fixed while repackaging: the manual copy missed
`extension/.vscodeignore` entirely (it's a dotfile, not everyone's first
`cp` includes those) — the first `spfvs-0.0.13.vsix` built without it
came out at 2.35MB with full source/sourcemaps bundled in, versus the
correct ~645KB. Repackaged after copying `.vscodeignore` (and
`extension/.vscode/launch.json`+`tasks.json`, also missed) over from the
old folder; verify vsix size looks right (compare against a prior
build) any time packaging is touched, since `vsce` silently includes
whatever isn't excluded rather than erroring.

The old `markons.ispf-editor` VS Code extension was uninstalled and
`markons.spfvs@0.0.13` installed in its place (this IS a different
extension ID from VS Code's point of view, not an in-place update, since
`name` changed — both would otherwise coexist harmlessly, but leaving
the dead one installed seemed pointless). `npm run typecheck`, `npm run
compile`, and `pytest` (65 tests) all re-verified passing from the new
location before packaging/publishing. **Not yet retested by the owner
after the rename** — the extension should behave identically to
v0.0.13 pre-rename; this was a naming/location change only, no
functional code changed.

## Status as of 2026-09-13 (later): prefix-command commits kept the view pinned to top

Owner reported: after `)`/`>` (shift right), the view jumped to the top
of the file instead of staying on the changed line. Root cause was NOT
specific to shift — **every** prefix-command batch commit was affected,
just less noticeably for most other commands: `ispfEditorProvider.ts`
always applies a batch as a full-document replace (see its own comment
on why — restructuring can touch discontiguous lines), which arrives at
the webview as a `setContent` message, and `media/main.ts`'s handler
called `model.setValue(message.text)` with no view-state handling at
all — Monaco's `setValue()` resets the cursor to `{1,1}` and scrolls to
the top as an inherent side effect of replacing the whole buffer.

Fixed by wrapping that `setValue()` call with
`editor.saveViewState()`/`restoreViewState()` in `main.ts` — cursor and
scroll are line/column-based in that saved state, so they land back in
the right place after the replace (Monaco clamps automatically if a line
they pointed at no longer exists, e.g. after a delete). This is a general
fix for the whole `setContent` path, not shift-specific — it also
improves every other prefix command's commit (delete/repeat/insert/copy/
move/label/exclude), plus genuine external changes (undo/redo elsewhere,
git), which went through the exact same code path and had the exact same
bug, just less visibly. No backend change, no new pytest cases (pure
webview view-state handling). `npm run typecheck` passes. **Not yet
tested by the owner.**

## Status as of 2026-09-13: FIND FIRST/LAST/RFIND + SHIFT line commands

Two independent additions, both untested by the owner yet:

**FIND FIRST/LAST + RFIND** (`extension/media/primaryCommand.ts`,
webview-only, no backend change): `find <text> first`/`last` search from
the top/bottom of the file regardless of cursor position (via Monaco's
`findNextMatch`/`findPreviousMatch` from position `{1,1}`/end-of-file);
a bare `find`/`f` with no text, or the new `rfind`/`rf`, repeat the last
search forward from the cursor — this project's answer to ISPF's PF5
"repeat find" (no PF5 key exists in a text command bar). Module-level
`lastFindNeedle` in primaryCommand.ts holds the repeat state (same
per-webview-module-instance pattern as `excludeFolding.ts`'s
`currentRanges`). All FIND scopes reuse the existing `revealAndUnexclude`
reveal-hidden-hits fix from the previous status entry.

**SHIFT line commands** (`backend/ispf_backend/prefix_commands.py`):
`)`/`>` shift a line's text right, `(`/`<` shift left, each by 2 columns
times the number of repeated characters (`))` = 4, `<<<` = 6); `)n`/`(n`/
`>n`/`<n` shift by an exact column count instead. `<`/`>` are pure
aliases for `(`/`)` — this mirrors the real ISPF convention where both
spellings are accepted (the exact **default width** of 2 is this
project's own choice, not independently verified against IBM's
profile-configurable default — flagged in README). Shift LEFT blindly
drops the leftmost n characters (blank or not, can truncate real text) —
deliberately matching ISPF's actual (somewhat dangerous) behavior rather
than being "smart" about only eating whitespace. Implementation notes for
future sessions: SHIFT is parsed via a new `_SHIFT_RE` BEFORE
`_parse_one` gets a chance (same pattern as the `.`/label check above
it), and is explicitly exempted from the shared range/overlap-validation
loop (`if kind == "shift": continue`) — its second operation-tuple field
is a signed column delta, not an end-line, so letting it fall through to
the generic `delete/repeat/insert/exclude` unpacking would silently
misinterpret that delta as an end-line and could raise a bogus
"extends past end of file" error for an ordinary large rightward shift.
SHIFT never touches `line_new_key` (it changes a line's TEXT, not its
identity/position), so any label or excluded-state on a shifted line is
correctly left alone — reuses the existing remap machinery for free.

Backend: 11 new pytest cases for SHIFT (default/double/explicit-count
right, blank-removal/truncation/past-length left, angle-bracket aliases,
zero-amount rejection, label survives a shift, malformed code falls back
to "unknown line command"), 65 total, all passing. `npm run typecheck`
passes. **Neither of these two features has been packaged/installed or
tested by the owner yet** — see the manual test checklist below, and
remember the standing gotcha from the LABEL entry: compiling isn't
enough, the `.vsix` must actually be rebuilt and reinstalled (bump
`extension/package.json`'s version, `vsce package`,
`code --install-extension --force`, then a full quit+relaunch of VS
Code) before any of this is reachable in the real UI.

## Status as of 2026-09-12 (latest): FIND/LOCATE reveal hidden hits, v0.0.11

Owner reported: after `X ALL`, `FIND text`/`FIND text ALL` found nothing
visible — `revealRangeAtTop`/`revealRangeAtTop` scrolled to the match but
the line stayed folded/collapsed, so there was nothing on screen to see.
Root cause: FIND/LOCATE only moved the cursor/viewport, never touched
folding state at all.

Fix, in `extension/media/primaryCommand.ts`: a new `revealAndUnexclude`
helper removes a target line from the CURRENT excluded set (via
`excludeFolding.ts`'s new `getExcludedLines()`) whenever FIND/LOCATE land
on one, then re-applies folding and notifies the extension host via the
existing `ExcludedLinesNotifier` — same "keep the host's remapped copy in
sync" pattern used everywhere else this session, not a one-off. This is a
**permanent** un-exclude (the line stays visible until re-excluded or
`RESET`), not a transient scroll-to-a-hidden-line peek. Also added `FIND
<text> ALL` (was previously only on `CHANGE`/`EXCLUDE`): finds every
match, un-hides all of them at once, reports the count, and reveals the
first — the intended "peek at everything matching after X ALL" workflow.
`LOCATE` got the identical fix for consistency (a labeled line inside a
hidden region was the same bug, just via a different command) even though
the owner only reported it for FIND.

No backend changes — this is entirely a webview-side view-state fix, no
new pytest cases. `npm run typecheck` passes. **Not yet tested by the
owner** — verify: `X ALL` then `FIND <text>` shows the found line;
`FIND <text> ALL` shows all matches and leaves non-matches hidden;
`LOCATE .label` where the label's line is hidden also reveals it.

## Status as of 2026-09-12 (later): x/xx EXCLUDE line command + RESET LAB

Added on top of the LABEL work below, same session: the `x[n]`/`xx`...`xx`
prefix-gutter EXCLUDE line command (hides lines from view, no document
edit — see prefix_commands.py's docstring), and a `RESET LAB`/`RES LAB`
primary command that clears labels specifically, now that plain
`RESET`/`RES` needed a precise scope: it clears whatever's currently
hidden (from primary `EXCLUDE` **or** gutter `x`/`xx`) but must NOT touch
labels — that split was the owner's explicit ask.

Design point for future sessions: `x`/`xx` reuses the exact same
caller-owned/backend-remapped state pattern as LABEL (see below) —
`prefix_commands.py`'s `process()` gained an `excluded_lines`
parameter/return value (a flat set of hidden line numbers, remapped
through restructuring via the same `line_new_key`/`key_to_new_line`
machinery labels use), and `ispfEditorProvider.ts` holds it in a second
closure-local variable (`excludedLines`) alongside `labels`, reset
together on any non-batch edit. The one new wrinkle: primary `EXCLUDE`/
`RESET` in `primaryCommand.ts` are resolved **entirely client-side**
(no backend round trip, unlike gutter commands) but still need to keep
the extension host's `excludedLines` copy in sync — otherwise a stale
copy would resurrect old exclusions (or fail to reflect new ones) on the
next gutter batch. Solved with a fire-and-forget `excludedLinesChanged`
message the webview sends after every client-side fold/unfold (see
`notifyExcludedLinesChanged` threaded into `executePrimaryCommand`), and
a matching `resetLabels` forward-action for `RESET LAB` (labels are
extension-host state, so clearing them can't be purely client-side the
way plain `RESET`'s fold/unfold is). `x`/`xx` **accumulate** across
separate gutter commits (by design, per the owner's request) — this is
deliberately different from primary `EXCLUDE`'s existing MVP
"replace, don't accumulate" behavior, which was left unchanged.

Backend: 11 new pytest cases for x/xx (single/count/block/unmatched/
accumulate-with-existing/remap-through-move-and-delete/range-past-EOF/
independence-from-labels), 54 total, all passing. `npm run typecheck`
and `npm run compile` both pass. **Not yet exercised in the real
installed VS Code UI** — add to the owner's manual test checklist below.

## Status as of 2026-09-12: LABEL construct implemented, confirmed working

Implemented the ISPF LABEL construct end to end. First test round failed
for a mundane reason worth flagging for future sessions: the code was
compiled but never packaged/installed as a `.vsix`, so the owner's
"Reload Window" just reloaded the still-installed old v0.0.7 build with
none of this in it (`code --list-extensions --show-versions` confirmed
it) — a repeat of the exact "Build / package / install" gotcha already
documented below. Fixed by actually running the bump-version -> `vsce
package` -> `code --install-extension --force` cycle (v0.0.8), after
which the owner confirmed `.x` set + `LOCATE .x`/`L .X` all work. Also
added in the same session, per owner follow-up and confirmed working:
`FIND`/`LOCATE` now scroll the hit/target line to the exact top of the
screen (`revealRangeAtTop`, not center/near-top) — shipped as v0.0.9.
**Takeaway: always actually run the package+install cycle (see Build
section) before telling the owner a change is ready to test — compiling
extension/dist alone does not touch the installed extension at all.**

Original LABEL implementation notes: `.name` in the prefix gutter assigns a persistent line label (1-8
chars, must start with a letter, folded to uppercase); `.` clears one;
`.ZFIRST`/`.ZLAST`/`.ZCSR` are reserved, always-available system labels
(first/last line, current cursor line) rather than stored state. Labels
are usable from the `COMMAND ===>` bar via the new `LOCATE`/`LOC`/`L`
command and a two-label form of `EXCLUDE`/`X` (`x .a .b`).

Key design point future sessions should know before touching this:
**labels are backend-computed, extension-host-owned, per-document-session
state — not stored in the document text and not tracked in the Python
backend process across calls** (that process is stateless and shared
across every open ISPF tab, so per-document state can't live there; see
`backend/ispf_backend/server.py`'s protocol doc). Each
`processPrefixCommands` request now carries the caller's current
name->line map, and `prefix_commands.py`'s `process()` returns the map
remapped through that batch's restructuring (a label follows a moved
line, stays on a copy/repeat/insert's *source* line, and drops if its
line is deleted — see the `line_new_key`/`key_to_new_line` machinery
added to `process()`, and the docstring on `LABEL` in that file). The
extension host (`ispfEditorProvider.ts`) holds the authoritative map in a
closure-local `labels` variable per `resolveCustomTextEditor` call (per
open document/tab), pushes it to the webview alongside every
`setContent`/`setLabels`/`prefixResult` message, and the webview
(`gutter.ts`'s `lineToLabel`/`labelToLine` maps, `resolveLabel()`) is
purely a display/lookup cache with no state of its own.

Because labels are tracked by line number, any edit that doesn't go
through the prefix-command batch (typing directly into Monaco, undo/redo,
another editor, git, `UNDO ALL`/`CANCEL`) can't be remapped and **drops
all labels for that document session** rather than risk one silently
pointing at the wrong line after the fact — this was a real bug caught
and fixed during this session (the `appliedByUs`-tracked "ordinary Monaco
edit" path originally returned early without touching labels at all,
leaving them stale instead of dropped; see the `onDidChangeTextDocument`
handler in `ispfEditorProvider.ts`). This is a known, documented MVP
limitation (see README's "Known limitations"), not an oversight — a full
fix would mean diffing Monaco's own edit ranges to shift labels
line-for-line, which wasn't attempted.

Backend: 13 new pytest cases for LABEL semantics (set/clear/reassign/
reserved-name rejection/case-folding/duplicate-in-batch, and remapping
through move/delete/insert/copy), all passing alongside the existing 30.
`npm run typecheck` and `npm run compile` both pass on the extension side.
**None of this has been exercised in the real installed VS Code UI yet**
— add it to the owner's manual test checklist below before assuming the
webview/gutter wiring for it actually works end-to-end (same caveat as
everything else on that list).

## Status as of 2026-09-11 (v0.0.7, installed locally, not on Marketplace)

Confirmed working by the owner: prefix gutter click/type (`c`, `d` line
commands tested), `exclude`/`x` and `reset`/`res` primary commands. NOT
yet tested by the owner: counts (`d3`/`r2`/`i2`), copy/move with a
destination marker (`c`+`a`/`b`, `m`+`a`/`b`, including move-UP where the
destination line is above the source), block forms (`dd`/`cc`/`mm`), and
error handling (unmatched block, orphan destination, out-of-range).
Owner is continuing manual testing next session — see the checklist at
the bottom of this file before assuming anything beyond the confirmed
list actually works end-to-end in the real VS Code UI (the automated
pytest suite covers the backend logic already, but not the webview/gutter
wiring).

**Standing convention (carried over from the owner's other repos, e.g.
pli-pygen): do NOT commit/push until the owner has personally tested and
approved.** As of 2026-09-13 this repo DOES have git history — one
initial commit, pushed to a private GitHub repo at
`https://github.com/markons/spfvs` (see that status entry for how/why) —
made because the owner explicitly asked for the rename+publish in that
same request, which is the standing convention's own carve-out ("without
being asked"). The convention itself is unchanged going forward: don't
commit/push again on your own initiative, only when asked.

## Architecture

- `extension/` — VS Code extension, TypeScript. `CustomTextEditorProvider`
  (not a bespoke `CustomDocument`) so the real `vscode.TextDocument` stays
  the single source of truth — undo/redo/save/dirty-state work for free.
  - `src/extension.ts` — activation, registers the provider.
  - `src/ispfEditorProvider.ts` — webview lifecycle, document↔webview sync
    (`appliedByUs` version-tracking so our own edits don't echo back into
    Monaco; `pendingBatchEditVersions` is the equivalent tracking for the
    LABEL map and EXCLUDE line set, added 2026-09-12 — see Status above),
    prefix-command round trip to the Python backend, primary actions that
    need the real document or extension-host state
    (`undo`/`undoAll`/`save`/`cancel`/`end`/`resetLabels`/`cut`/`paste`
    via `handleClipboardAction` — see below), a `pendingMark` closure
    variable (added 2026-09-14, same per-document/reset-on-non-batch-
    edit treatment as `labels`/`excludedLines`, but never itself pushed
    to the webview since there's nothing to display), cache-busting
    query param on the webview asset URLs
    (`?v=<extension version>`, added after a debugging round where a
    stale bundle was briefly suspected).
  - `src/backendClient.ts` — spawns one persistent `python -m
    ispf_backend` process per extension host, newline-delimited JSON over
    stdin/stdout, request-id keyed.
  - `media/main.ts` — webview entry: boots Monaco, wires the gutter and
    command bar, message bridge to the extension host.
  - `media/gutter.ts` — the editable prefix-command gutter. **Read the
    class doc comment before touching this file** — it explains why it's
    a plain DOM overlay (pooled/recycled `<input>` elements, windowed to
    the visible-line range + buffer) rather than any Monaco widget type.
    Also owns the LABEL display/lookup cache (`lineToLabel`/`labelToLine`,
    `setLabels()`, `resolveLabel()`) — it holds no authoritative label
    state itself, just mirrors whatever the extension host last pushed.
    `commit()` intercepts `hx`/`hx[n]` codes (via `HEX_CODE_RE`) BEFORE
    they'd otherwise be sent to the backend as a batch — see
    `hexView.ts`'s class doc comment for why HX never touches the
    backend at all, unlike every other prefix command including the
    other view-only ones (`x`/`xx`).
  - `media/hexView.ts` — the `HX` line command's real implementation:
    Monaco's view-zone API (`changeViewZones`/`addZone`/`removeZone`),
    the same "reserve space in the render, not the model" category of
    trick `excludeFolding.ts` uses for EXCLUDE, but simpler here since HX
    doesn't need a `FoldingRangeProvider` — just a DOM node per shown
    line. Deliberately NOT remapped through restructuring the way LABEL/
    EXCLUDE are (any `onDidChangeModelContent` just clears every zone).
  - `media/primaryCommand.ts` — `COMMAND ===>` bar command parsing/
    execution. `find`/`f`/`rfind`/`rf`, `change`/`c`, `sort`, `top`/`t`,
    `bottom`/`bot`, `locate`/`loc`/`l`, `exclude`/`x`, `reset`/`res`
    resolve entirely client-side against Monaco's model APIs (`locate`
    with a `.label` and the two-label form of `exclude` go through
    `gutter.ts`'s `resolveLabel` via the `LabelResolver` param — `locate`
    with a plain number instead validates against `model.getLineCount()`
    directly; `exclude`/`res` report what they changed back to the
    extension host via the `ExcludedLinesNotifier` param, so its
    `excludedLines` copy stays correct for the next gutter x/xx batch —
    see Status above; `find`/`change` share scope-keyword parsing via
    `extractTrailingScope`, and `find`/`rfind` share direction-repeat
    state via module-level `lastFindNeedle`/`lastFindDirection`/
    `lastFindColumnRange` — the last added 2026-09-14 alongside ISPF's
    `FIND`/`CHANGE` column-range restriction, `extractColumnRange`/
    `withinColumnRange`/`pickMatch`, see Status above). `undo`,
    `cancel`/`can`, `save`, `end`/`pf3`, `reset lab`/`res lab` (-> action
    `resetLabels`), and (added 2026-09-14) `cut` and `paste`/`paste a`/
    `paste b` return `{kind:"forward", action}` for the provider to
    execute against the real document or extension-host state (see
    ispfEditorProvider.ts's `handlePrimaryAction` for the first group and
    `handleClipboardAction` for cut/paste). `PASTE`'s forwarded outcome
    is the one `CommandOutcome` variant that carries extra payload
    (`line`/`before`) alongside `action` — `main.ts`'s forwarding handler
    spreads everything but `kind` into the posted message rather than
    just `{action}`.
  - `media/excludeFolding.ts` — EXCLUDE/RESET/x/xx's real implementation:
    Monaco's public folding API (`registerFoldingRangeProvider` +
    `editor.fold`/`editor.unfoldAll` triggers), NOT the lower-level
    `setHiddenAreas` an earlier version called directly (see Debugging
    journey below for why that didn't work).
  - `media/pliLanguage.ts` — Monarch syntax-coloring tokenizer for PL/I,
    seeded from `pli-pygen/pli/lexer.py`'s keyword table (re-read that
    file directly if extending — don't re-derive the keyword list from
    memory).
  - `media/commandBar.css`, `media/gutter.css` — gutter cells are
    currently **hardcoded high-contrast colors** (black background,
    yellow border/text), not theme variables — this was a deliberate
    diagnostic choice during the gutter-visibility debugging round (see
    below) and turned out the owner actually likes/accepts the look
    (mistook it for decorative background at first, which is itself a
    sign it may be worth restyling to look more obviously *interactive*
    — e.g. an input-like border or cursor affordance — next session,
    without losing the high-contrast legibility).
- `backend/` — Python package `ispf_backend`, no VS Code awareness, and
  pure/side-effect-free EXCEPT for the CUT/PASTE clipboard (see the
  2026-09-13 status entry for why that one had to be genuine module
  state). `prefix_commands.py`'s module docstring documents the full
  supported command grammar and validation rules, including LABEL
  (`.name`/`.`), EXCLUDE (`x[n]`/`xx`...`xx`), SHIFT (`)`/`((`/`>`/`<<`/
  etc.), `RR`...`RR` block repeat, `UC`/`LC` case conversion, and the
  2026-09-14 `pending_mark`/`execute_cut`/`execute_paste` design: an
  unpaired `c[n]`/`cc`/`m[n]`/`mm` becomes a pending copy/move mark
  (paired ones are unaffected, unchanged in-file copy/move), resolved by
  the `CUT`/`PASTE` **primary** commands via `process()`'s
  `execute_cut`/`execute_paste` flags — `prefix_commands.py` itself never
  parses the words `cut`/`paste`, those only exist in
  `primaryCommand.ts` now. `pytest backend/tests/` — **94 tests, all
  passing**, covers single and block delete/repeat/insert/copy/move
  including move-up (destination line above the source), every
  documented error case, LABEL set/clear/reassign/reserved-name/case-
  folding/duplicate-in-batch, EXCLUDE set/count/block/unmatched/
  accumulate, SHIFT right/left/explicit-count/angle-bracket-aliases/
  truncation, RR default/opening-count/closing-count/unmatched, UC/LC
  single/range/too-many-markers/case-insensitivity, and the
  pending-mark/CUT/PASTE design (mark creation single/block/copy/move,
  setting-while-pending is an error, remapping through same-batch and
  later-batch restructuring, dropped when its line is deleted,
  execute_cut both mark kinds and its no-mark error, execute_paste
  after/before/empty-clipboard-error/non-consuming, and
  cut-in-one-document-then-paste-in-another), all plus remapping through
  every restructuring op where applicable. This is the trustworthy,
  already-verified layer; the webview/gutter wiring is the layer still
  under manual test.

## Build / package / install (what "run it" actually means right now)

There is no Marketplace listing — the owner tests via a real `.vsix`
installed into their everyday VS Code, not just the F5 Extension
Development Host (though that still works too — see repo root
`README.md`).

```
cd extension
npm install                  # first time only
npm run compile              # or: node esbuild.js --production
npx vsce package             # writes spfvs-<version>.vsix
code --install-extension spfvs-<version>.vsix --force
```

Bump the `version` field in `extension/package.json` before each
package/install round — VS Code's webview asset caching plus the
extension's own install-folder-per-version behavior make it genuinely
ambiguous whether a same-version reinstall took effect; a version bump
plus a full **quit-and-relaunch** of VS Code (not just "Developer: Reload
Window", though that has been sufficient in practice once the version
bumped) removes that ambiguity entirely. This was a real source of
wasted debugging cycles this session (see below) before the cache-busting
query param existed.

`extension/resources/icon.png` was generated programmatically with
Pillow (`PIL.ImageDraw`, no external asset), a dark terminal-style panel
motif (green outlined gutter cells + code lines) — not a Marketplace
listing, so no icon guideline scrutiny yet, but flag it for the owner's
opinion before ever actually publishing.

**Publishing to the Marketplace is explicitly on hold** — needs the
owner's own publisher ID (`markons`, already set in package.json) and a
PAT from Azure DevOps, which is the owner's action to take, not something
to do proactively. See the "How do you want to handle Marketplace
publishing?" exchange in session history if resuming that thread.

## Debugging journey (why the gutter/exclude bugs took this many rounds)

Kept here because the root causes are non-obvious and a future session
(or future bug in the same area) should check these first before
re-deriving them:

1. **`.ispf-gutter`'s children are all `position: absolute`**, so none
   of them contribute to the parent's intrinsic height — `height: auto`
   collapsed to 0, and `overflow: hidden` then clipped everything to that
   zero-height box. First real bug found; fixed by giving `.ispf-gutter`
   an explicit height (later superseded by the absolute-positioning
   rewrite in point 3).
2. **An extra `gutterHost` wrapper div meant `.ispf-gutter`'s
   `flex-shrink: 0` rule applied to the wrong element** (the wrapper was
   the actual flex item, not `.ispf-gutter` itself) — silently a no-op.
   Removed the wrapper.
3. **The real layout-timing bug**: `editorHost` (Monaco's container) and
   the gutter were flex siblings, but the gutter is inserted into the DOM
   *after* `monaco.editor.create()` already ran — so Monaco's first
   layout pass measured `editorHost` at the *full* row width (gutter
   didn't exist yet to shrink it), and `automaticLayout`'s
   `ResizeObserver` doesn't necessarily re-fire in time / reliably in
   this environment. Fixed by abandoning flexbox content-sizing for this
   pair entirely: `editorRow` is `position: relative`, and both the
   gutter and `editorHost` are `position: absolute` with explicit
   `left`/`right`/`top`/`bottom` pixel values — correct from the very
   first layout pass regardless of DOM insertion order or timing. An
   explicit `editor.layout()` call right after gutter construction was
   tried first as a narrower fix and kept as a harmless defensive
   extra, but the absolute-positioning rewrite is what actually mattered
   — confirmed via `getBoundingClientRect()` diagnostic logging
   (`[ISPF gutter]`-prefixed `console.log` calls still in `gutter.ts` as
   of v0.0.7 — consider removing/quieting once the owner's remaining
   test checklist is confirmed green, or gating them behind a debug flag).
4. **EXCLUDE/RESET didn't work at all — "command 'editor.fold' not
   found"**, found via the *webview's own* DevTools console (Command
   Palette → "Developer: Open Webview Developer Tools" — **not** the
   main window's "Toggle Developer Tools", which shows extension-host
   and workbench logs from a completely separate JS realm and will never
   show a webview's own `console.log`/errors; this distinction cost a
   full debugging round). Root cause: the webview imports Monaco's
   minimal `monaco-editor/esm/vs/editor/editor.api` core specifically to
   avoid pulling in worker-dependent rich language services (per the
   `claude-api` skill's Monaco guidance) — but that core skips *all*
   default contributions, including folding, which has no worker
   dependency at all and was excluded as unintended collateral damage.
   Fixed with an explicit `import
   "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js"` in
   `media/main.ts`. Caught a units bug in the same fix: `editor.fold`'s
   `selectionLines` argument is 0-based; `FoldingRange.start` is 1-based.
   An even-earlier attempt called the lower-level, undocumented
   `editor.setHiddenAreas` directly (present at runtime on
   `CodeEditorWidget` per its own source, but not in the public
   `.d.ts`) — this updated internal state without the folding
   controller's coordinated bookkeeping and produced no visible effect;
   abandoned in favor of the real public folding API once folding.js was
   actually bundled.
5. **The gutter numbers were working the whole time** (since roughly the
   point fix #3 shipped) — the owner mistook the hardcoded black/yellow
   gutter cells for decorative background rather than an interactive
   control, because nothing about the (deliberately loud, diagnostic)
   styling signaled "this is a text input." Not a code bug at all, but
   worth remembering: a future styling pass should make the gutter read
   as *interactive* (e.g. a text-cursor affordance, a subtler focus
   state) even before it's clicked, not just legible.

## Owner's manual test checklist for next session

Backend semantics are already covered by `pytest` — this list is about
the webview/gutter/primary-command wiring specifically, run against a
real file in the installed extension:

- Prefix gutter: `d3` (delete w/ count), `r2` (repeat w/ count), `i2`
  (insert w/ count).
- Copy/move with a destination marker: `c`+`a`, `c`+`b`, `m`+`a`, `m`+`b`
  — including a destination **above** the source (move-up), which needed
  a real algorithm fix earlier this session (see the source/destination
  merge-pairing loop in `prefix_commands.py`'s `process()` — it was
  originally line-order-dependent and broke on move-up before being
  rewritten) and should be re-verified through the actual UI, not just
  pytest.
- Block forms: `dd`...`dd`, `cc`...`cc`+`a`/`b`, `mm`...`mm`+`a`/`b`.
- Error handling in the gutter: orphan `a`/`b`, unmatched `dd`, a
  range that runs past end-of-file — should reject the whole batch,
  leave the offending cell outlined with a tooltip, not silently no-op.
- Primary commands not yet exercised: `undo`, `undo all`, `save`,
  `cancel`/`can`, `end`/`pf3`.
- LABEL construct (2026-09-12): owner has confirmed `.a` set + `LOCATE
  .a`/`L .A` work (v0.0.8+). Still unexercised: clearing one with `.`;
  `.zfoo` rejected as reserved and a too-long/digit-first name rejected as
  unknown; `X .a .b`/`EXCLUDE .a .b` label-range exclude, both orders;
  `LOCATE .ZFIRST`/`.ZLAST`/`.ZCSR`; label a line, then move/copy/delete/
  insert around it and confirm the label follows correctly; type directly
  into Monaco (not the gutter) after setting a label and confirm the
  label is dropped rather than silently misplaced.
- `FIND`/`LOCATE` scrolling the hit to the top of the screen (2026-09-12,
  v0.0.9): confirmed working by the owner.
- x/xx EXCLUDE line command + RESET LAB (new 2026-09-12, entirely
  unexercised in the real UI): `x` and `x3` on single lines; `xx`...`xx`
  block form; unmatched `xx` (should error, reject the batch); hide a
  line with `x`, then hide another in a *separate* gutter commit and
  confirm both stay hidden (accumulates, unlike primary `EXCLUDE`); label
  a line and separately `x` a different line in the *same* batch and
  confirm both apply independently; `RESET`/`RES` un-hides lines from
  both `EXCLUDE` and `x`/`xx` but leaves any set labels displayed; `RESET
  LAB`/`RES LAB` clears labels but leaves currently-hidden lines hidden;
  x/xx a line, then move/copy/delete/insert around it and confirm the
  hidden state follows correctly the same way a label would.
- FIND reveal-on-hidden-hit (2026-09-12): `X ALL` then `FIND text` shows
  the found line; `FIND text ALL` shows every match and leaves
  non-matches hidden; `LOCATE .label` reveals a hidden labeled line too.
- FIND FIRST/LAST/RFIND (new 2026-09-13, entirely unexercised): `find
  text first` jumps to the first occurrence regardless of cursor
  position; `find text last` jumps to the last; a bare `find`/`f` (no
  text) after a previous search repeats it, same as the new `rfind`/`rf`;
  a literal one-word search that happens to spell `first`/`last`/`all`
  (e.g. `find first`) should search for that word, not be misread as the
  scope keyword.
- SHIFT line commands (new 2026-09-13, entirely unexercised): `)`/`>`
  shift a line right, `(`/`<` shift left, both by 2 columns; `))`/`>>`/
  `((`/`<<` shift by 4; `)6`/`(6`/`>6`/`<6` shift by exactly 6 columns;
  shifting left past the line's actual content should truncate it (not
  error) — verify that's what actually happens on screen, since it's a
  real (if ISPF-authentic) way to lose text; a shifted line's label (if
  any) should stay put.
- View stays put after a prefix-command commit (new 2026-09-13, entirely
  unexercised): scroll deep into a large file, commit `)`/any other
  prefix command there, and confirm the view stays on that page instead
  of jumping to the top; try it also on a command that changes the line
  count (e.g. `d`/`i2`) to make sure the fix doesn't regress those.
- LOCATE by line number (new 2026-09-13, entirely unexercised): `LOCATE
  50`/`LOC 50`/`L 50` moves to line 50 and reveals it at the top;
  `LOCATE 99999` (past EOF) errors; `LOCATE .a` (label) still works
  alongside it.
- RR block repeat (new 2026-09-13, entirely unexercised): `rr`...`rr`
  repeats the marked block once; `rr3`...`rr` and `rr`...`rr3` both
  repeat it 3 times (count on either marker); unmatched `rr` errors and
  rejects the batch; a label on a line inside the original block stays
  put.
- UC/LC case conversion (new 2026-09-13, entirely unexercised): `uc`
  uppercases one line, `lc` lowercases one line; `uc` on two separate
  lines converts the whole range between them; `uc` on three or more
  lines in one batch errors as ambiguous; a label on a converted line is
  unaffected.
- CUT/PASTE + pending mark (redesigned 2026-09-14, entirely unexercised
  in this corrected shape — see that status entry for the full spec):
  type `m` on a line (or `mm`...`mm` on a block) with no `a`/`b` paired
  to it, then run the `CUT` primary command — the line(s) should
  disappear from the document (moved to the clipboard); do the same with
  `c`/`cc` instead — the line(s) should stay in place (copied, not
  removed) after `CUT`. Move the cursor to a target line and run `PASTE`
  (defaults to after) and `PASTE B` (before) and confirm placement.
  Cut in ONE open ISPF file and paste into a DIFFERENT open ISPF file —
  this is the whole point of the process-wide clipboard design, so it's
  the most important case to verify. Paste twice in a row to confirm the
  clipboard isn't consumed. `CUT` with nothing marked should error
  ("nothing marked for cut"); `PASTE` with an empty clipboard should
  error ("clipboard is empty"). Setting a second mark (e.g. `c` on
  another line) while one is already pending, without running `CUT` in
  between, should error ("already pending — use CUT first") and reject
  that batch. A lone `a`/`b` with no mark pending should still be an
  ordinary error, same as always. Paired `c`+`a`, `m`+`b`, `cc`+`a`/`b`,
  `mm`+`a`/`b` should behave exactly as before this feature existed
  (immediate in-file copy/move, no clipboard involvement) — confirm this
  didn't regress. An unmatched `cc`/`mm` block should still error.
- HOME key jumps to COMMAND ===> (new 2026-09-14, entirely unexercised):
  pressing Home with the cursor already at the very start of the
  document (line 1, column 1) in the main editor should jump focus to
  the command bar and select its contents; Home anywhere else in the
  document should behave completely normally (line-start/smart-home,
  unchanged); Home inside any gutter prefix-command cell should always
  jump to the command bar regardless of cursor position within that
  cell.
- FIND/CHANGE PREV + CHANGE FIRST/LAST (new 2026-09-13, entirely
  unexercised): `find text prev` searches backward from the cursor and
  wraps; after `find text prev`, a bare `find`/`rfind` should keep
  searching backward (not flip to forward); `change old new first` and
  `change old new last` change the first/last occurrence in the file
  regardless of cursor position; `change old new prev` changes backward.
- SORT (new 2026-09-13, entirely unexercised): `sort` alone sorts every
  line as plain text; `sort 10 20` sorts by columns 10-20; `sort 10 20 d`
  sorts descending; confirm it's a real, undoable document edit (Ctrl+Z
  should revert it) and that any labels/excluded lines present before
  the sort are gone afterward (expected — see README's "Known
  limitations").
- HX line command (new 2026-09-13, entirely unexercised): `hx` on a line
  shows two hex rows underneath it, roughly aligned column-for-column
  with the source characters (check this looks right visually — it's
  CSS-font-based alignment, not guaranteed pixel-perfect, per
  hexView.ts's docs); typing `hx` again on that same line hides it;
  `hx3` shows hex for 3 consecutive lines at once; typing directly into
  Monaco (or committing any prefix-command batch) while hex rows are
  showing should make them all disappear; try it on a line with
  non-ASCII characters to see what the "masked to one byte" hex actually
  looks like (documented as not real UTF-8, just a peek).
- FIND/CHANGE column-range restriction (new 2026-09-14, entirely
  unexercised): `f 'xxx' 8 10` only finds `xxx` where it lies entirely
  within columns 8-10, ignoring occurrences elsewhere on the line;
  `change old new 8 10` likewise only replaces a match inside that
  column range; combine with a scope (`f 'xxx' 8 10 all`, `c old new 8
  10 last`) and confirm both the column AND scope restriction apply
  together; a bare `find`/`rfind` repeat after a column-restricted FIND
  should keep honoring that same column range; `find 100 200` (no
  quotes, exactly two tokens) should be read as a literal two-word
  search, NOT misinterpreted as a column-only command with an empty
  search string; quoting a numeric search string (`find '100' 8 10`)
  should let it combine with a real column range.

## Conventions

- Test before commit/push (see Status section above — no git history
  exists yet, so this applies from the very first commit onward).
- Bump `extension/package.json`'s `version` before every
  package/install cycle during active debugging (see Build section).
- Keep `README.md` (repo root) in sync with the supported command tables
  — it's the user-facing reference; this file is the *why*, README is
  the *what*.
