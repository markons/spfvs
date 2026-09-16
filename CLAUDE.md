# CLAUDE.md — project notes for spfvs

## Status as of 2026-09-16: Edit macros can now SET/CLEAR labels (`ctx.set_label`/`ctx.clear_label`)

Owner audited the macro feature list against a checklist ("Find/Find
Next, Change/Replace, Insert, Delete, Line ranges, Copy/Move, Macro
arguments, Return codes, Labels, Column operations") across two rounds;
after insert/delete-line support shipped, the only two genuine gaps left
were Labels (still read-only) and Column operations (nothing built).
Owner: "can you realize set-label?" — this entry is that.

**Backend (`backend/ispf_backend/macros.py`)**: `EditContext` gained
`set_label(name, line)` and `clear_label(name)`, deliberately mirroring
`prefix_commands.py`'s own LABEL validation EXACTLY rather than
inventing divergent rules — a fresh `_LABEL_NAME_RE = re.compile(r"^[A-
Za-z][A-Za-z0-9]{0,7}$")` restated here (not imported — that name is
`prefix_commands.py`'s own private implementation detail, and this
module is deliberately kept independent of it, per the module
docstring; keep the two regexes in sync by hand if either ever
changes), same fold-to-uppercase, same "names starting with Z are
reserved" rejection, same "one label per line — assigning a new name to
an already-labeled line replaces the old one" behavior, same "a label
can be moved to a different line via plain dict overwrite" semantics.
`clear_label` is lenient (a no-op, not an error, if the name isn't set)
— matches how a gutter `.` clear behaves whether or not anything was
actually there. New `result_labels()` returns the final map, read by
`run_macro()` and returned as `MacroResult.labels`.

**The other half of this piece, easy to miss**: `insert_after`/
`insert_before`/`delete_line`/`delete_lines` (added the previous round)
did NOT remap `self._labels` at all — harmless while labels were
read-only, but a real latent bug the instant they became settable
(existing labels would silently go stale the moment a macro also
inserted/deleted a line). Fixed with two new helpers,
`_remap_labels_for_insert(at_line)` (every label at or after the new
line's position shifts down by one) and `_remap_labels_for_delete(start,
end)` (a label inside the deleted range is dropped; one after it shifts
up by the removed count) — wired into all four insert/delete methods.
This is the exact same "caller-owned, backend-remapped state" pattern
`prefix_commands.py`'s own `process()` uses for its `line_new_key`/
`key_to_new_line` machinery, just reimplemented at `EditContext`'s
smaller scale (no batch of mixed operation kinds to reconcile, just one
insert/delete at a time).

**Extension host (`extension/src/ispfEditorProvider.ts`) — the
necessary architectural change**: `handleMacroAction` previously applied
a macro's edit via the SAME `appliedByUs`/`applyEditTrackingOurVersion`
path a plain Monaco keystroke uses — deliberately chosen back when
Phase 1 macros were snapshot-only and labels were read-only, since there
was nothing to remap. That path's `onDidChangeTextDocument` branch
UNCONDITIONALLY drops labels/excludedLines/pendingMark after ANY edit on
it (same as a real typed keystroke, where that's the only safe
assumption) — which would now silently discard a macro's own
`set_label()`/`clear_label()` result the instant it was applied. Fixed
by switching `handleMacroAction` onto the SAME `pendingBatchEditVersions`
pattern `handlePrefixCommands`/`handleClipboardAction` already use: an
`onStateResolved(labels, pendingMark, expectedDocVersion)` callback
updates the caller's closure state BEFORE the edit is applied (or before
returning, if no edit is needed), rather than after. `pendingMark` is
defensively cleared whenever an edit IS applied (a macro's own
restructuring isn't remapped through it) but left untouched when no
edit occurs (nothing shifted, so it's still valid).

**The "no edit, but labels still changed" case, worth understanding**: a
macro that ONLY calls `set_label`/`clear_label` (no `set_line`/insert/
delete at all) produces `newText === document.getText()` — same
non-destructive shape `handleClipboardAction`'s copy-mark case already
skips the edit for. But unlike that CUT/PASTE case (which never actually
changes labels, so there's nothing new to display), a macro's labels
really did change here, and skipping the edit means the usual
`setContent` message (which normally carries `labels` along) never
fires — so `handleMacroAction` now pushes an explicit `{type:
"setLabels", labels: newLabels}` message directly in that branch, rather
than assuming the webview will find out some other way.

**Shipped example (`.spfvs/macros/setlabel.py`, new)**: `setlabel <name>`
assigns to the cursor's line, `setlabel <name> <line>` to an explicit
line, `setlabel <name> clear` removes it — added as a NEW file rather
than editing `.spfvs/macros/showlabel.py` (which the owner had already
hand-edited earlier this session to append cursor-line text to its
message; left untouched, not reverted).

Backend: 22 new pytest cases in `test_macros.py` — `set_label`
(valid/format-invalid/reserved-Z/out-of-range/replaces-existing-label-
on-same-line/moves-existing-name-to-new-line), `clear_label` (existing/
leading-dot-and-lowercase/no-op-when-absent), label remapping through
each of `insert_after`/`insert_before`/`delete_line`/`delete_lines`
(shifts correctly; dropped when its exact line is deleted; unaffected
when unrelated to the change), two `run_macro()` end-to-end tests
(`result.labels` reflects set_label+clear_label; reflects remapping
through a delete), and three shipped-example integration tests for
`setlabel.py`. **172 total backend tests, all passing** (up from 151 at
the start of this round). `npm run typecheck` and `npm run compile`
both pass.

Updated `README.md` (EditContext table: `set_label`/`clear_label` rows
added, `resolve_label`'s row no longer says read-only; a new "Example:
setting and clearing a label" section; Phase 1 limitations bullet
rewritten to reflect labels now being read/write and remapped), 
`extension/src/helpText.ts` (macro section), and `server.py`'s module
docstring + `_handle_macro`'s response dict (`labels` now echoed back on
a macro response, no longer a request-only, read-only field) and
`backendClient.ts`'s `MacroResponse` interface (`labels` field added).

Packaged and installed as **v0.0.29**. **Not yet tested by the owner** —
manual test focus: set a label with a macro (`setlabel foo`) and confirm
it shows up in the gutter immediately with NO document edit/dirty-flag
change; `setlabel foo 5` to an explicit line; `setlabel foo clear`
removes it; set a label with the GUTTER (`.bar`), then run a macro that
inserts/deletes lines around it (e.g. `duplicateline`) and confirm the
gutter label follows correctly, the same way it would after a gutter
`i`/`d` prefix command; a macro that both edits text AND sets a label in
the same run (not yet shipped as an example — try composing one) to
confirm both land correctly in one go; reserved `Z`-prefixed and
malformed names are rejected with a clear macro error, not silently
ignored.



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

## Status as of 2026-09-16 (latest): macro insert/delete-line support — unblocks Insert/Delete/Copy/Move

Owner asked me to audit `EditContext` against a 10-item ISPF-macro
feature checklist (Find/Find Next, Change/Replace, Insert, Delete, Line
ranges, Copy/Move, Macro arguments, Return codes, Labels, Column
operations). Verdict at the time: 2 fully done (arguments, return-
codes-as-exceptions), 4 achievable via composition with no dedicated
helper (find-next, change, line ranges, columns), 3 hard-blocked by one
root cause (Insert/Delete/Copy-Move all need a line-count-changing
primitive that didn't exist), labels half-built (read-only). Owner's
instruction: build the line-count primitive, since it unblocks three
items at once.

**Backend (`macros.py`)**: `EditContext` gained four methods —
`insert_after(line, text)` / `insert_before(line, text)` (either can
insert at the very ends via `ctx.last_line`/`ctx.first_line`) and
`delete_line(line)` / `delete_lines(start, end)` (the range form exists
specifically so a macro doesn't have to loop `delete_line()` calls and
fight index-shifting after each one). All four range-check their
arguments the same way `get_line`/`set_line` already do (a `MacroError`
on an invalid line number, reported as an ordinary macro failure).

**Deliberately NOT added**: dedicated `copy`/`move` methods. Copy is
`get_line` + `insert_after`/`insert_before`; Move is that plus
`delete_line` on the original — both trivial one-or-two-line
compositions (see the new shipped example below), so a third pair of
methods would be pure duplication for the sake of a label. If this
turns out to feel clunky in practice, revisit.

**New invariant, handled explicitly**: `cursor_line` can become invalid
after a `delete_line`/`delete_lines` shrinks the document past it (e.g.
cursor was on line 10, macro deletes lines 8-12). New private
`_clamp_cursor()` (called at the end of every insert/delete) clamps it
back to `line_count` (or `1` if the document became empty) — mirrors
the SAME clamp already done once, in the constructor, for a stale
caller-supplied initial value. Deliberately just a clamp, not an
attempt to track "where did the cursor's original line go" — `insert_*`
docstrings say so explicitly, so a macro that cares about relative
position sets `ctx.cursor_line` itself afterward rather than assuming.

**Architectural question resolved without any code change**: does
`ispfEditorProvider.ts`'s `handleMacroAction` (which applies a macro's
result via the same `appliedByUs`-tracked path plain Monaco keystrokes
use, NOT the `pendingBatchEditVersions` remapping path prefix-command
batches use) still work correctly now that macros can change line
count? **Yes — re-read the `onDidChangeTextDocument` listener and
confirmed the `appliedByUs` branch ALREADY drops labels/excludedLines/
pendingMark UNCONDITIONALLY for every edit on that path**, regardless
of whether the line count changed — it was never contingent on "same
line count = safe," it's the same defensive "not run through remapping,
so drop rather than risk staleness" behavior a plain typed keystroke
edit already gets. So the ONLY change needed was fixing a stale doc
comment on `handleMacroAction` that had claimed (accurately, at the
time it was written) that macros "can never change the document's LINE
COUNT" — now corrected to explain why the architecture holds regardless.
**Worth remembering if this area is touched again**: don't assume a
"drop caller-owned state" branch needs new handling just because a
precondition it was written under has changed — check whether the drop
was already unconditional first.

`find_all()`'s docstring gained a stronger version of its existing
snapshot-staleness caution: a match's `.line` can now be wrong not just
in CONTENT after a same-line edit, but in POSITION entirely after any
insert/delete elsewhere in the document — call it again after
restructuring rather than reusing an old result.

**New shipped example, `.spfvs/macros/duplicateline.py`**: demonstrates
exactly the Copy/Move composition — `duplicateline` (duplicate the
cursor's line after itself), `duplicateline before` (before instead),
`duplicateline move` (relocate it to the end of the file instead of
copying). Joins `todocomment.py`/`showlabel.py` as the third shipped,
pytest-verified example.

Backend: 18 new pytest cases in `test_macros.py` — `insert_after`/
`insert_before` at the ends and in the middle, out-of-range errors for
both insert and delete, `delete_line`/`delete_lines` (including
end-before-start rejection), cursor clamping when a delete shrinks past
it vs. left alone when it doesn't, insert leaving an in-range cursor
undisturbed, copy-via-composition and move-via-composition as direct
unit tests of the pattern, one full `run_macro()` end-to-end test
combining insert+delete+message, and three integration tests loading
and running the actual shipped `duplicateline.py` (default-after,
before, move). **151 total backend tests, all passing** (133 previous +
18 new).

Updated README's `EditContext` table (two new rows), a new "Example:
insert, delete, and copy/move by composition" section, the Phase 1
limitations bullet (removed "can't change line count" — replaced with
the composition/no-dedicated-copy-move framing and the cursor-clamping
note), and `helpText.ts`'s macro section to match. `npm run typecheck`
and `npm run compile` both pass — no functional extension-host code
changed, only a stale comment corrected (see above). **Not yet
packaged/installed or tested by the owner** — verify: `duplicateline`/
`duplicateline before`/`duplicateline move` all behave as described;
write a throwaway macro that deletes several lines including the
cursor's own line and confirm the editor's cursor ends up somewhere
valid afterward rather than erroring; confirm labels/excludedLines
still get dropped (not silently stale) after a line-count-changing
macro, same as they already were for a same-count one.

## Status as of 2026-09-16: macro output — long/multi-line results go to an Output Channel

Owner asked (after writing `showlabel.py`'s multi-line report and
asking where `ctx.message()` actually renders): where does a macro's
message show up? Answer surfaced a real gap: the `COMMAND ===>` bar's
status span (`.ispf-command-message` in `commandBar.css`) is
`white-space: nowrap; overflow: hidden; text-overflow: ellipsis` — the
SAME single-line, truncating style every other primary command's
feedback already uses. A multi-line `ctx.message()` result (like
`showlabel`'s 3-4 line report) would have its newlines collapsed into
plain spaces by `nowrap` and then likely gotten cut off with `…`,
losing everything past whatever fits the bar's width. This was flagged
explicitly, then fixed on request — worth noting the Phase 1 planning
conversation had actually already floated an Output Channel as the
right answer for this ("route stdout capture to a dedicated 'SPFVS
Macros' Output Channel... reserve the status-message line for the
final one-line result"), but the SHIPPED Phase 1 implementation never
built it — everything went through the single-line channel uniformly.
This entry is that follow-through.

**Fix (`ispfEditorProvider.ts`)**: new `private readonly
macroOutputChannel: vscode.OutputChannel`, created once in the
constructor (`vscode.window.createOutputChannel("SPFVS Macros")`,
pushed to `context.subscriptions` for disposal) — one channel shared
across every open SPFVS tab in this extension host, same "one instance
per extension host" pattern `BackendClient` already uses. New private
`reportMacroResult(webviewPanel, name, message, isError)` replaces
every direct `primaryActionResult` `postMessage` call inside
`handleMacroAction` (blocked-by-trust, unknown-command, macro-failed,
and success — all four now go through it): if `message` fits (no `\n`,
≤120 chars), it posts exactly as before, unchanged; otherwise it
`appendLine`s `[<macro name>] <full message>` to the output channel,
calls `.show(true)` (the `true` = `preserveFocus`, so the output panel
becomes visible without yanking keyboard focus away from the editor),
and posts a SHORT one-line summary instead (`<first line, clipped to 80
chars>` + `— see "SPFVS Macros" output for full result`) so the status
bar still shows something immediately useful rather than going silent.

No backend change (this is purely how the extension host presents a
`MacroResult` it already had — `macros.py`/`run_macro()` are untouched)
and no new pytest cases for the same reason. `npm run typecheck` and
`npm run compile` both pass. README's `EditContext` table and
`helpText.ts`'s macro section both gained a short explanation of the
short-vs-long routing rule and point at both shipped examples now
(`todocomment.py` and `showlabel.py`). **Not yet packaged/installed or
tested by the owner** — verify: a short macro result (e.g.
`todocomment`'s "ISPF EDIT MACRO FINISHED\nLines in member: N" — this
ALREADY has a `\n` in it, so it should now route to the output channel
too, worth specifically re-checking since it predates this fix and
wasn't rewritten) shows the summary+pointer in the status bar and the
full text in "SPFVS Macros"; `showlabel`'s multi-line report does the
same; a short single-line result (e.g. a plain `"macro completed"`)
still shows directly in the status bar exactly as before, with no
output channel involvement at all.

## Status as of 2026-09-16: Edit macros — read-only label resolution (`ctx.resolve_label`)

Owner asked (across a few short questions, working through the Phase 1
`EditContext` surface interactively) whether a macro could detect a
label SPFVS itself set via the gutter's `.name`. Answer at the time:
no — Phase 1 (see the entry below) explicitly listed "direct access to
labels" as deferred. Owner said to build it. Scoped down from "full
label access" to just the READ side, per the offer made and accepted:
a macro can now *resolve* an existing label to a line number, but still
can't *create or clear* one — that stays deferred, since writing a
label back would mean the extension host's `labels` closure state
(currently only mutated by prefix-command batches and `RESET LAB`)
gaining a THIRD writer, a bigger design question than this round's
scope.

**Backend (`macros.py`)**: `EditContext.__init__` gained an optional
`labels: dict[str, int] | None` parameter, stored as `self._labels` — a
read-only snapshot, same spirit as `self._lines`, no setter exposed.
New method `resolve_label(name)`: strips a leading `.` if present,
uppercases (matching how `prefix_commands.py` already stores label
names), and either returns the reserved names computed fresh —
`.ZFIRST`→`first_line`, `.ZLAST`→`last_line`, `.ZCSR`→**current**
`cursor_line`, checked BEFORE the labels dict so a stale/malformed
entry literally named `"ZFIRST"` could never shadow the reserved
computation — or falls through to `self._labels.get(key)`, returning
`None` (not raising) for an unset name, matching `find_all()`'s own
"empty result, not an error" precedent for "nothing matched." `ZCSR`
tracking the CURRENT cursor_line (not a snapshot at construction time)
means a macro that moves the cursor via `ctx.cursor_line = n` and then
calls `resolve_label(".ZCSR")` gets `n` back, not the original position
— covered by its own test.

`run_macro()` gained a matching optional `labels` parameter, threaded
straight into `EditContext`; `server.py`'s `_handle_macro` reads an
optional `"labels"` field off the request (defaults to `{}` if absent
— an OLDER/other caller that doesn't send it still works, though there
is currently only the one caller). The macro RESPONSE never echoes
labels back — this is one-way, read-only, unlike how a prefix-command
response returns an updated `labels` map.

**Extension host**: `backendClient.ts`'s `runMacro()` gained a required
`labels: Record<string, number>` parameter (the request always includes
it now, even though the backend tolerates its absence);
`ispfEditorProvider.ts`'s `handleMacroAction` gained a matching
parameter, and its one call site (the `"primaryAction"`/`"macro"`
branch in `onDidReceiveMessage`) passes the same closure-local `labels`
variable prefix-command batches and `CUT`/`PASTE` already read from —
no new state, just handing existing state to one more consumer.

Backend: 9 new pytest cases in `test_macros.py` — `resolve_label` with
a known name, lowercase/leading-dot normalization, an unknown name
(`None`), no `labels` argument at all, all three reserved names, ZCSR
tracking a cursor move, and confirmation a reserved name is never
shadowable even by a maliciously-matching entry in the labels dict —
plus two `run_macro()` integration tests (labels threaded all the way
through end to end, and the "no labels arg" default-empty-dict case).
**130 total backend tests, all passing** (121 previous + 9 new).
`npm run typecheck` and `npm run compile` both pass.

Updated the module docstring's "deferred" list (labels moved from
"no access at all" to "read-only resolution only, still can't set"),
README's `EditContext` table + Phase-1-limitations bullet, and
`helpText.ts`'s macro section — all three now describe `resolve_label`
consistently. Packaged and installed as **v0.0.26**. **Not yet tested
by the owner** — try it by labeling a line with `.foo` in the gutter,
committing that batch, then running a macro that calls
`ctx.resolve_label(".foo")` and messages the result.

**Follow-up same day**: owner asked for a sample macro demonstrating
this — shipped as a THIRD example, `.spfvs/macros/showlabel.py`
(joining `todocomment.py` and the README-only `striptrailing.py`
snippet): `showlabel` alone reports `.ZFIRST`/`.ZLAST`/`.ZCSR`;
`showlabel <name>` also resolves a real label and, if found, jumps
`ctx.cursor_line` there (ISPF's `LOCATE .label` in one step) — reports
`not set` rather than erroring if it doesn't exist. Added 3 more pytest
cases mirroring `test_shipped_todocomment_example_macro`'s "load and
run the ACTUAL shipped file" pattern (`_repo_example_macro_path` was
generalized to take a filename rather than being hardcoded to
`todocomment.py`): reserved-names-only, resolve-and-jump for a real
label, and the not-set case (confirms `cursor_line` stays UNCHANGED
when there's nothing to jump to). **133 total backend tests, all
passing.** Pure data/test addition — no extension code changed, so no
repackage needed for this follow-up; README gained a matching third
"Example:" subsection.

## Status as of 2026-09-15: Edit macros, Phase 1 — Python macros invoked from COMMAND ===>

Owner asked (as an explicit design conversation first — "plan only,"
then a REXX sample to validate the design against, then "implement the
first version... prepare it ready for a backfall") for macro support
similar to real ISPF's REXX edit macros. This entry is the actual
implementation of that plan's Phase 1 — see the design conversation
itself (session history, not reproduced here) for the fuller rationale
and the REXX-to-Python idiom mapping worked out against the owner's own
sample macro.

**What "ready for a backfall" drove, concretely**: every piece of this
is new, additive surface that reuses existing, already-trusted
machinery wherever possible, rather than touching or risking the
well-tested prefix-command engine:
  - `server.py` dispatches on a NEW `"type": "runMacro"` field — any
    request without it (i.e. every existing prefix-command request)
    goes through the EXACT unchanged original code path. A macro bug
    can't reach `process()`; a `process()` bug can't reach macros.
  - Macro execution lives entirely in a new module, `macros.py` — zero
    lines of `prefix_commands.py` changed.
  - Applying a macro's result to the real document reuses the SAME
    `appliedByUs`/`applyEditTrackingOurVersion` path plain Monaco
    keystroke edits already use (see `applyMonacoEdit`) — deliberately
    NOT the `pendingBatchEditVersions` remapping path prefix-command
    batches use, because Phase 1 macros can never change the document's
    LINE COUNT (no insert/delete-line API on `EditContext` yet), so
    there's no restructuring to remap labels/excludedLines/pendingMark
    THROUGH — reusing "ordinary edit" (which already resets that state,
    same as direct typing does) is simpler and safer than building a
    second remapping mechanism for a case that literally cannot arise
    yet. If a later phase adds line insert/delete to `EditContext`,
    this will need to move onto the `pendingBatchEditVersions` path.

**Backend (`backend/ispf_backend/macros.py`, new)**: `EditContext`
wraps an in-memory copy of the document + cursor line, exposing
`line_count`/`first_line`/`last_line`, `cursor_line` (get/set, range-
validated), `get_line`/`set_line` (`change_line` is a plain alias),
`find_all(text)` (a snapshot substring search — see its own docstring
for why snapshot-not-live was chosen, and the exact caveat about
mutating a line then re-reading stale match text), and `message(text)`.
`run_macro(source_path, lines, cursor_line, args)` reads the file,
`compile()`+`exec()`s it into a FRESH namespace per run (never the
module's own globals — one macro can't see another's state), looks for
a module-level `run(ctx, args)`, calls it with stdout redirected into a
capture buffer, and turns EVERY failure mode (unreadable file, syntax
error, missing `run`, an exception raised inside it, a `MacroError`
from `EditContext`'s own range-checking) into a `MacroResult` with
`error` set — nothing ever propagates as an uncaught exception, since
that would crash the shared backend process every other open tab
depends on. `run_macro()`'s docstring and this whole module's own
docstring both spell out the explicit "not yet built" list (global
macro path, interactivity, labels/exclude/clipboard access, line
insert/delete) so a future session doesn't have to reverse-engineer
scope from what's missing.

**Extension host (`extension/src/macros.ts`, new)**: `findMacroFile(document,
name)` resolves `.spfvs/macros/<lowercased-name>.py` relative to
`vscode.workspace.getWorkspaceFolder(document.uri)` — returns
`undefined` (not an error) when there's no workspace folder or no
matching file, both ordinary "not a macro" cases. `isWorkspaceTrustedForMacros()`
is a thin wrapper around `vscode.workspace.isTrusted` — VS Code's own
Workspace Trust gates macro execution, deliberately NOT a bespoke
prompt this extension invents (same mechanism already gates
`tasks.json` auto-run and similar risky automatic behavior elsewhere in
VS Code). `ispfEditorProvider.ts` gained `handleMacroAction()`: checks
trust, resolves the file, builds `lines`, calls the backend's new
`runMacro()`, applies the result as an ordinary edit (see above), posts
a new `"setCursor"` message if the macro moved the cursor, and reports
success/failure through the existing `primaryActionResult` channel
every other primary action already uses.

**Invocation (`extension/media/primaryCommand.ts`)**: the `default:`
case (previously: immediately return `"unknown primary command"`) now
ALWAYS forwards instead — `{kind:"forward", action:"macro", name, args,
cursorLine}` — since this sandboxed webview has no filesystem access to
check for a macro file itself; the extension host now owns the final
"is this a macro or genuinely unknown" decision, and reports the exact
same `"unknown primary command '<name>'"` message back when it isn't,
so a genuine typo still reads exactly as it always did.
`main.ts` gained a `"setCursor"` message handler (`editor.setPosition`
+ `revealLine`) — needed because a macro's document edit already
triggers the ordinary `"setContent"` path, whose `saveViewState`/
`restoreViewState` would otherwise put the cursor back where it WAS
rather than where the macro moved it to; `setCursor` arrives
deliberately AFTER that, once `handleMacroAction`'s edit has been
applied.

**Shipped example (`.spfvs/macros/todocomment.py`, new)**: a full,
tested, line-by-line translation of the owner's own REXX sample macro
(a TODO-search-and-a-no-op-CHANGE loop, plus a "prefix every `/*` with
`COMMENT: `" loop) — invoke it by opening this repo in SPFVS and typing
`todocomment`. Its own doc comment quotes the original REXX and explains
what each REXX/`ISREDIT` idiom (`ADDRESS ISREDIT` + quoted subcommands,
`RC`-checked `DO WHILE` loops, `FIND FIRST`/`FIND NEXT`, reading
`.ZLAST` like a variable) became in Python and why (mostly: Python
already has iterators and real return values, so several REXX
"features" just aren't needed at all rather than needing simulation —
see the design conversation for the full idiom-by-idiom mapping).

Backend: 19 new pytest cases in `backend/tests/test_macros.py` — every
`EditContext` member in isolation, `run_macro()`'s full success/every-
failure-mode matrix (missing file, syntax error, no `run` function, an
exception raised inside `run()`, an out-of-range `MacroError`), that a
failed macro leaves `lines`/`cursor_line` as `None` and never mutates
the CALLER's own `lines` list, and — the most end-to-end one —
`test_shipped_todocomment_example_macro`, which loads and runs the
actual shipped `.spfvs/macros/todocomment.py` file (not a synthetic
`tmp_path` fixture) and asserts its exact output, catching drift between
this doc entry's description and the real shipped file automatically.
**121 total backend tests, all passing** (102 existing, untouched, +
19 new). `npm run typecheck` and `npm run compile` both pass.

**Not yet packaged/installed or tested by the owner** — needs the usual
version-bump/`vsce package`/`code --install-extension --force`/
quit-relaunch cycle. Manual test focus once installed: open THIS repo
(`spfvs`) in SPFVS itself (so `.spfvs/macros/todocomment.py` is
reachable), type `todocomment` in `COMMAND ===>` on a file containing a
`/* comment */` somewhere, confirm every `/*` gets `COMMENT: ` prefixed
and the status message reports the line count; type a genuinely unknown
word and confirm the ordinary "unknown primary command" error still
appears unchanged; try it in an UNTRUSTED workspace and confirm macro
execution is blocked with a clear message rather than silently doing
nothing or silently running anyway.

## Status as of 2026-09-15: SHIFT rebuilt against IBM's actual docs — `))` is a real BLOCK form, `>`/`<` removed

**This supersedes two same-day false starts on SHIFT (both documented
below, kept for the record) — this entry is the actually-correct,
IBM-source-verified design.** The full arc, worth understanding before
touching SHIFT again:

1. Owner: "the line-shift commands... are not ispf-conform... there is
   no ispf line command `)))` etc." — taken at face value, the
   repeat-character multiplier (`))`=2x default, present since SHIFT's
   original 2026-09-13 implementation) was removed.
2. Owner tested `))1`, expected it to shift by 1, got an unexpected
   rejection, and pushed back: "i specified: install the line shift
   commands according to the corresponding ispf editor syntax" — at
   this point this session's own (imperfect) recollection of ISPF said
   the repeat-character form WAS real, so it was restored, net figuring
   out nothing new about *actual* IBM documentation.
3. Owner posted the actual IBM doc link:
   https://www.ibm.com/docs/en/zos/2.1.0?topic=commands-column-shift-right
   — fetched it (and the Column Shift Left, Data Shift Right, and Edit
   Line Commands summary pages) directly via WebFetch rather than
   guessing again. **This is the first point in the whole SHIFT saga
   this session worked from a real source instead of recollection.**

**What IBM's docs actually say** (syntax diagrams + prose, fetched
verbatim): Column Shift Right/Left (`)`/`(`) have TWO real forms, not
the "single line vs. repeat-to-multiply" shape this project had before:
  - `)` / `)n` — shift THIS line, default width 2, or exactly n columns.
  - `))` / `))n` — a **block** form: "Type `))` in the line command
    field of the first line to be shifted... Type `))` in the line
    command field of the last line to be shifted... the lines that
    contain the two `))` commands and all of the lines between them are
    column shifted" — i.e. `))` is a PAIRED MARKER like `dd`...`dd`, not
    "shift this one line by double the default." `))n` puts an explicit
    count on either marker. There is no `)))`/triple-or-more form at
    all — that was this project's own repeated invention, wrong both
    times it existed.
  - Left (`(`/`(n`/`((`/`((n`) works identically, mirrored.

**Separately, `>`/`<` are NOT aliases of `)`/`(` at all** — they're a
different, genuinely distinct real ISPF command, **Data Shift**: "moves
the body of a program statement to the right without shifting the label
or comments," and — unlike Column Shift's blind truncation — "if you
shift data beyond the current BOUNDS setting, the text stops at the
right bound and the shifted lines are marked with `==ERR>` flags."
Faithfully implementing this needs a BOUNDS setting (already deferred,
see the 2026-09-13 ISPF-parity status entry's cluster #8) AND a
language-specific definition of "label field"/"comment field" (trivial
for COBOL's fixed columns, undefined for a generic multi-language
editor) — neither exists in this project. Asked the owner how to handle
this gap; **decision: remove `>`/`<` entirely for now** (deferred
alongside BOUNDS/MASK/NUMBER, not faked as `)`/`(` aliases — that alias
relationship never existed in real ISPF and was this project's own
mistake).

**Implementation**: `_SHIFT_RE` is now `^([()])(\1?)(\d*)$` — group 1
the shift char (`)`/`(` only, `<`/`>` removed entirely), group 2 an
OPTIONAL single repeat (present = block form), group 3 optional digits
(valid on either form). A genuine new block-pairing mechanism,
`_SHIFT_BLOCK_CODES = ("))", "((")`, was added to the SAME
`pending_block`/`pending_*_count` machinery `dd`/`cc`/`mm`/`xx`/`rr`
already use — new `pending_shift_count` dict (analogous to
`pending_rr_count`, but keyed per direction since a `))` block and a
`((` block could both be open in one batch) with `0` as the "no explicit
count on this marker" sentinel (0 is otherwise always invalid for a
shift amount, so it's unambiguous — unlike RR, which reuses `1` for
this since 1 IS its legitimate default). Count resolution mirrors RR's
tie-break exactly: closing marker's explicit count wins if both markers
specify one, else whichever one did, else the default width. A new
`("shift_block", start, end, delta, defining)` operation kind was added
alongside the existing `("shift", line, delta, defining)`: unlike plain
`shift` (deliberately exempt from the range/overlap validation loop,
since it only ever touches one already-validated line), `shift_block`
DOES have a real multi-line range and goes through that validation like
any other block op (added to the `("case", "repeat_block", "paste",
"shift_block")` unpacking group) — out-of-range and overlap-with-another-
line-command are both caught the normal way. Building the document just
applies the existing per-line shift formula to every line in the range,
independently, with no `line_new_key` remapping needed (identity/order
never changes, only text).

Rewrote the whole SHIFT test block: single-line forms unchanged
(`)`/`)n`/`(`/`(n`), a `)))`-style triple now explicitly asserts
"unknown line command," `<`/`>` now explicitly assert "unknown line
command" too (not an alias), and a full new suite for the block form
(default width, count on opening marker, count on closing marker,
closing-wins-when-both-specify, unmatched-is-an-error for both
directions, labels survive a block shift untouched, overlap with a
separate line command inside the block's range is rejected).
**102 total tests, all passing.**

Updated `README.md` (new table rows separating Column Shift's real block
form from the removed `>`/`<`, a "Known limitations" bullet explaining
the BOUNDS+label/comment-field gap), the module docstring, and
`extension/src/helpText.ts` to all describe this exact final design —
no lingering references to the two now-superseded attempts.

`)))` and `>`/`<` correctly read as "unknown line command"; a lone
unpaired `))` (or `))n`) now correctly reads as **"unmatched '))'
starting at line N"** — a more accurate error than either prior
attempt gave for the exact case (`))1`) that started this whole
investigation, since `))1` really is meaningful ISPF syntax (an opening
block marker with an explicit count), just one that was never closed in
that test. `pytest` (102 tests) and `npm run typecheck`/`npm run
compile` both pass. No repackage needed for the backend fix itself
(editable install), but `extension/src/helpText.ts` DID change this
round, so package/install before relying on `HELP`'s SHIFT section
being accurate. **Not yet tested by the owner** — verify in particular:
`))`...`))` and `((`...`((` block shifts (with and without an explicit
count on either marker), an unmatched `))`/`((` rejects the batch, and
`>`/`<` are now plain unrecognized commands (not silently doing
anything).

## Status as of 2026-09-14: HELP primary command

Owner asked for a "help primary command which shows all actual
implemented primary and line command syntax." New `HELP`/`H` primary
command opens a plain, static text summary as a new, ordinary VS Code
tab beside the current one (`vscode.workspace.openTextDocument({content,
language:"plaintext"})` + `showTextDocument(..., {viewColumn:
vscode.ViewColumn.Beside})`) — NOT another SPFVS custom editor instance,
just a normal scrollable/searchable text buffer, since a full multi-line
reference doesn't fit in the single-line `COMMAND ===>` status message
the way every other command's feedback does.

The reference text itself is a new module-level string constant,
`HELP_TEXT` in a new file `extension/src/helpText.ts` — deliberately
placed in `src/` (the extension-host bundle), NOT `media/` (the webview
bundle), because opening a new editor tab is an extension-host-only API
(`vscode.workspace.openTextDocument`/`showTextDocument` don't exist in
the webview's sandboxed context) — `ispfEditorProvider.ts` imports it
directly. `HELP` itself is forwarded from the webview exactly like
`cut`/`resetLabels`/etc. (`primaryCommand.ts`'s `CommandOutcome` gained
`"help"` in its forward-action union; `ispfEditorProvider.ts`'s
`handlePrimaryAction` gained a `case "help"`) purely for this reason,
even though — unlike every other forwarded action — it never touches
the current document or any extension-host state at all.

`HELP_TEXT` is a hand-maintained plain-text mirror of README.md's
prefix-command and primary-command tables (not generated from them) —
**keep it in sync manually whenever a command's syntax changes**, the
same discipline this file's own "Conventions" section already asks for
between README and CLAUDE.md. A fresh untitled document is opened every
time `HELP`/`H` runs rather than reusing/tracking a single instance —
simpler, and safe since the content is static (no live document state
to go stale).

`npm run typecheck` and `npm run compile` both pass. No backend
changes, no new pytest cases (pure webview-forward + extension-host tab
opening). Packaged and installed as **v0.0.23**. **Not yet tested by
the owner.**

## Status as of 2026-09-14: fixed the v0.0.21 regression, + WORD qualifier + gutter arrow-key nav

**Reverted the previous entry's `getTopForLineNumber(line, true)` change
— it was based on a wrong root-cause diagnosis and introduced a real
regression**, caught immediately by the owner retesting: "'res' resets
now 'cols' line. but now not the 'cols' line-number part is locked, but
rather the line under." Read Monaco's own source this time instead of
guessing (`node_modules/monaco-editor/esm/vs/editor/common/viewLayout/
linesLayout.js`'s `getVerticalOffsetForLineNumber`): the accumulated-
whitespace-height lookup is computed for `lineNumber - (includeViewZones
? 1 : 0)`. For a SINGLE zone anchored at `afterLineNumber = N` and the
very next real line `N+1`: the DEFAULT (`includeViewZones=false`, i.e.
plain `getTopForLineNumber(line)`, no second argument) already looks up
whitespace-before `N+1`, which correctly includes the zone (since `N <
N+1`). Passing `true` instead looks up whitespace-before `N+1-1 = N`,
which EXCLUDES that exact same zone (since `N < N` is false) — i.e. it
un-counts the zone specifically for the one line immediately after it,
while every line further below is unaffected either way (the boundary
condition only bites at that one line). This is the OPPOSITE of a fix:
default was already correct, and `true` broke exactly the line the
owner then reported as newly "locked." **Takeaway for future sessions:
`includeViewZones` is not a generic "account for zones" toggle — verify
against Monaco's own source before touching this argument again**, not
just from the `.d.ts` comment (which says nothing about the off-by-one
semantics). Fixed by reverting to plain `getTopForLineNumber(line)`.

The owner's original "cols line-number part... locked" report (the one
that prompted the wrong fix) most likely was ALSO about this exact
same immediately-following-line case all along — their terminology
("the cols line") plausibly means "the line associated with/right after
the ruler," not the ruler's own row (which correctly has no gutter cell
at all, by design, and was never the issue). Reverting should resolve
both reports at once, since default was correct for this case the whole
time; if a genuinely different line is still misbehaving after this
revert, that would point to an actual NEW bug, not this one — ask for
an exact line number next time before touching gutter geometry again,
given how easy this area is to misdiagnose (see also the original
"Debugging journey" section for three earlier rounds of exactly this
kind of gutter-geometry trouble).

**Feature request 1: `WORD` qualifier for `FIND`/`CHANGE`**
(`extension/media/primaryCommand.ts`, webview-only, no backend change).
Real ISPF's own `FIND string WORD` / `CHANGE old new WORD` form:
restricts a match to a whole word — flanked by a non-alphanumeric
character (or line start/end) on both sides. Implemented as a straight
pass-through to Monaco's own `wordSeparators` argument (its own "match
whole word" mechanism — already accepted by every `findMatches`/
`findNextMatch`/`findPreviousMatch` call, previously always passed
`null`) via a new module constant `WORD_SEPARATORS` (every ASCII
punctuation/whitespace character, i.e. "not a letter/digit/underscore"
— matches the owner's own framing: "not-alphanumerical-character-
trimmed part of a string"). New `extractWordQualifier(args,
minRemaining)` mirrors `extractColumnRange`'s disambiguation pattern
exactly (same `minRemaining` guard so `find word` alone reads as a
literal search for "word", not an empty WORD-qualified search).

Real ISPF's token order is `string [WORD] [c1 c2] [scope]` — WORD sits
BETWEEN the search text and the column range, closest to the text.
Extraction correspondingly peels from the right in this order:
`extractTrailingScope` (rightmost) -> `extractColumnRange` -> the new
`extractWordQualifier` (leftmost of the three optional trailing groups,
applied to whatever's left after the other two). Module-level
`lastFindWord` joins `lastFindNeedle`/`lastFindDirection`/
`lastFindColumnRange` as state a bare `FIND`/`RFIND` repeat reuses.

**Important divergence from the owner's own example worth flagging
explicitly**: the owner's sample was `c dcl word all declare` (old,
WORD, scope, new — new text LAST). The actual working syntax follows
real ISPF's documented grammar instead — new text right after old text,
always: `c dcl declare word all`. This was a deliberate choice (follow
the authentic, well-established ISPF grammar rather than guess at a
possibly-informal example ordering) — flagged to the owner so it can be
corrected if the informal ordering was actually intended as a real
design ask, not just how they happened to phrase the request.

**Feature request 2: gutter cells are walkable with Up/Down**
(`extension/media/gutter.ts`): a real ISPF prefix-area convention this
project's plain `<input>`-per-line gutter cells had no equivalent for
(arrow keys do nothing useful in a lone single-line text box otherwise,
so intercepting them unconditionally — no "already at an edge" guard
the way Home-in-the-main-editor has one — is safe). New private
`focusLine(line, caretPos)`: looks up the pooled input for the target
line, calls `editor.revealLine()` + a synchronous `layout()` first if
it's not currently pooled (e.g. right at the visible-range buffer's
edge) so it gets created, then focuses it and restores the caret to the
same column offset (clamped to the target cell's shorter/longer value
length) rather than resetting to column 0 — makes walking several cells
in a row via arrow keys feel continuous rather than jumpy.

`npm run typecheck` and `npm run compile` both pass. No backend changes
for either feature request, no new pytest cases (both pure webview:
command-string parsing and DOM focus management respectively).
Packaged and installed as **v0.0.22**. **Not yet retested by the
owner** — this is the third round on the gutter-geometry regression
specifically, so treat "not yet confirmed fixed" as the default
assumption until the owner explicitly says otherwise.

## Status as of 2026-09-14: gutter cells misplaced below an HX/COLS zone

**Superseded by the entry above — this diagnosis and fix were WRONG,
reverted in v0.0.22.** Kept for the record since it documents a real,
verified-from-source Monaco semantics lesson (`includeViewZones` is not
a simple "account for zones" toggle), just applied to the wrong root
cause. Read the entry above before touching `gutter.ts`'s
`getTopForLineNumber` call again.

Owner tested v0.0.20 and reported: after setting a `cols` ruler, "I
cannot retype the number area of this new line" — clarified via a
follow-up question into: they weren't trying to type into the ruler's
own row (which correctly has no gutter cell — it's not a document
line), they were trying to use the gutter cell that visually sits near
it, which behaved wrong.

**Root cause, confirmed by reading Monaco's own source**
(`node_modules/monaco-editor/esm/vs/editor/browser/widget/codeEditor/
codeEditorWidget.js`): `getTopForLineNumber(lineNumber, includeViewZones
= false)` — the `includeViewZones` parameter **defaults to false**.
`gutter.ts`'s `layout()` was calling it with just `(line)`, so as soon
as an `hx`/`cols` zone is shown, every gutter cell for a REAL line
**below** that zone was positioned as if the zone weren't there — too
high, landing on/near the zone's own visual row instead of the actual
line it belongs to. Clicking what looked like "the new [ruler] line's
cell" was actually a misplaced cell for a different real line entirely
— objectively broken, not a misunderstanding of the "ruler has no cell"
design (which is correct and unchanged).

Fixed with a one-line change: `getTopForLineNumber(line, true)`. No
other geometry call in `gutter.ts` needed the same fix (`getScrollTop()`
is a scalar already in the zone-inclusive coordinate space, so it needed
no change). This bug has presumably existed since HX shipped
(2026-09-13) — it just hadn't been reported, likely because nobody had
tried typing into a gutter cell for a line sitting below a shown hex
zone before this COLS testing round surfaced it. **Retest HX below-zone
gutter typing too, not just COLS**, next time either is exercised.

The owner also asked (via a clarifying round) about a second thing they
tried: typing `cc` as a line command on one line, then running `RES`,
expecting it to also clear that pending, uncommitted `cc` out of the
gutter cell — "nothing happens." This is **not a bug**: an unpaired/
uncommitted line command sitting in a gutter cell is just literal typed
text in an `<input>` (`pendingValues`, see gutter.ts) waiting for
`Enter`, not tracked state the way EXCLUDE/labels/hx/cols are — `RESET`
was never meant to discard arbitrary in-progress gutter input any more
than it discards unsaved text typed into the main editor. Clearing it
manually (select and delete the cell's text, or overwrite it) remains
the way to back out of a not-yet-committed line command.

`npm run typecheck` and `npm run compile` both pass. No backend
changes, no new pytest cases (pure webview geometry fix). Packaged and
installed as **v0.0.21**. **Not yet retested by the owner.**

## Status as of 2026-09-14: RESET now clears HX/COLS rulers too

Owner reported: "if a raster is set by cols, it cannot be revoked. the
raster line remains as not-editable line, even after a 'res' command."
Retyping `cols` on the **same originating line** already did (and
still does) toggle it off — that part of `ColsView`/`HexView` was
correct — but that's easy to miss, since the ruler itself renders as an
extra visual row with no gutter cell of its own to type into (it's a
Monaco view zone, not a real document line — see colsView.ts/hexView.ts's
class doc comments), and nothing about it visually points back at the
real line above it that owns the toggle. The owner's other reach —
`RESET`/`RES` — did NOT clear it, which from the outside looks
indistinguishable from "stuck forever": `RES` already clears
EXCLUDE'd/x'd lines, so expecting it to also clear a ruler is a
reasonable, ISPF-consistent "get the screen back to normal" mental
model, even though real ISPF's own RESET/HEX-OFF/COLS-OFF are
technically separate toggles.

Fixed the actual complaint by making `RES` (not `RES LAB`, which is
already scoped to labels only) ALSO clear every shown `hx`/`cols` zone,
on top of its existing un-hide-EXCLUDEd-lines job. New `HexView`/
`ColsView` method `hideAll()` (thin public wrapper around each class's
existing private `clearAll()`, already used internally on every
document edit). `primaryCommand.ts`'s `executePrimaryCommand` gained a
5th parameter, `clearViewZones: ViewZoneClearer` (`() => void`), called
from the plain-`RESET` branch right alongside the existing
`setExcludedRanges(editor, [])`/`notifyExcludedLinesChanged([])` calls.
`main.ts` wires it as `() => { hexView?.hideAll(); colsView?.hideAll();
}` — passed into `executePrimaryCommand` as the new last argument.

The retype-to-toggle mechanism itself was NOT changed (code review found
no bug in it — `toggle()`/`show()`/`hide()` in both classes look correct
in isolation); README's `cols` paragraph now explicitly spells out BOTH
routes (retype on the source line, or `RES`) so this doesn't recur as a
"how do I get rid of this" report. If retyping `cols` on the source line
*still* doesn't remove it after this fix, that would point at an actual
bug in the toggle path itself, not just a missing RES hook — worth
distinguishing explicitly if the owner reports it again.

No backend changes, no new pytest cases (pure webview view-zone
lifecycle, same category as HX/COLS themselves). `npm run typecheck`
and `npm run compile` both pass. Packaged and installed as **v0.0.20**.
**Not yet retested by the owner.**

## Status as of 2026-09-14: README screenshot

Owner sent a screenshot of the editor in use (SPFVS editing a PL/I file,
gutter + `COMMAND ===>` bar both visible) and asked for it in the
README. Saved to `docs/screenshot.png` (new `docs/` folder — nothing
else there yet) and embedded right under the intro paragraph in
`README.md`, before "Project layout" — first thing a Marketplace/GitHub
visitor sees, per `C:\temp\vsapp.md`'s own advice (written earlier this
session) that a listing with an image up top converts far better than
text-only. No code change. Getting the actual image file into this
session took two failed clipboard-paste attempts before the owner saved
it to a file and gave the path directly — worth remembering if a future
session hits the same "user says they pasted an image but nothing
arrived" situation: ask for a saved file path rather than retrying paste
indefinitely.

## Status as of 2026-09-14: COLS line command

Owner asked to "install the cols line command." Implemented as a new
`extension/media/colsView.ts`'s `ColsView` class, deliberately modeled
directly on `hexView.ts`'s `HexView` (same view-zone mechanism, same
"intercepted in gutter.ts's `commit()` before it would otherwise reach
the backend as an unknown command" pattern, same "any document edit
clears every shown zone" simplification) rather than inventing a new
approach — `cols` and `hx` are the same *category* of feature (a pure
view effect, never touching the document or the backend). The one real
difference: real ISPF's `COLS` line command takes no operand, so unlike
`hx[n]` there's no counted form — `COLS_CODE_RE = /^cols$/i` (no digit
group), and `gutter.ts`'s `GutterOptions` grew a plain `onColsToggle:
(lines: number[]) => void` instead of `HexToggle`'s `{line, count}`
shape.

The ruler itself (`rulerText()`) reproduces ISPF's own pattern
character-by-character: `-` per column, `+` every 5th, the tens digit
(wrapping 1-9-0) every 10th — e.g. `----+----1----+----2----+----3`.
Its width (`rulerWidth()`) is the longest line currently in the whole
document, with an 80-column floor for a short/empty file — this project
has no BOUNDS/record-length concept to size it against exactly (that's
part of the already-deliberately-deferred MASK/NUMBER/CAPS/HEX-ON/
BOUNDS cluster from the 2026-09-13 ISPF-parity status entry), so 80 (a
traditional mainframe record width) is a reasonable stand-in rather
than a real limit.

`gutter.ts`'s `commit()` was refactored slightly to share one
`localLines` array between `hx` and `cols` (both are "consumed locally,
never round-trips through consumedLines") rather than duplicating the
same clear-and-skip logic under two different names.

No backend changes, no new pytest cases (pure webview view-zone
feature, exactly the `hx` precedent). `npm run typecheck` and `npm run
compile` both pass. Packaged and installed as **v0.0.19**. **Not yet
tested by the owner.**

## Status as of 2026-09-14: FIND/CHANGE column-range restriction

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
**this original design is SUPERSEDED — see the 2026-09-15 status entry
above ("SHIFT rebuilt against IBM's actual docs") for the current,
IBM-source-verified behavior.** In short: `)`/`(` single-line shift is
unchanged; the "repeat the character to multiply the shift" idea
described here originally was wrong twice over (`)))`+ was never valid,
and `))` is actually a real ISPF BLOCK marker paired like `dd`...`dd`,
not "shift this one line by double"); `<`/`>` were never real aliases of
`(`/`)` at all — they're a different, unimplemented ISPF command (Data
Shift) and have been removed rather than kept as incorrect aliases.
Don't use anything in this paragraph as current truth; the SHIFT section
of the module docstring in `prefix_commands.py` itself is correct and
current.

Backend: 11 new pytest cases for SHIFT shipped in this original round
(single-line default/explicit-count right and left, truncation, zero-
amount rejection, label survives a shift, malformed code falls back to
"unknown line command"), 65 total at the time. All since superseded/
expanded by the 2026-09-15 rework (102 total as of that entry). `npm run
typecheck` passes. **Neither of these two features has been packaged/
installed or tested by the owner yet** — see the manual test checklist
below, and remember the standing gotcha from the LABEL entry: compiling
isn't enough, the `.vsix` must actually be rebuilt and reinstalled (bump
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
    via `handleClipboardAction` — see below, and `help`, which opens
    `helpText.ts`'s static `HELP_TEXT` as a new tab beside the current
    one — added 2026-09-14, forwarded purely because opening a tab is an
    extension-host-only API, not because it touches any state), a
    `pendingMark` closure variable (added 2026-09-14, same per-document/
    reset-on-non-batch-edit treatment as `labels`/`excludedLines`, but
    never itself pushed to the webview since there's nothing to
    display), cache-busting query param on the webview asset URLs
    (`?v=<extension version>`, added after a debugging round where a
    stale bundle was briefly suspected).
  - `src/backendClient.ts` — spawns one persistent `python -m
    ispf_backend` process per extension host, newline-delimited JSON over
    stdin/stdout, request-id keyed.
  - `src/helpText.ts` — the `HELP`/`H` primary command's static
    `HELP_TEXT` string (added 2026-09-14), a hand-maintained plain-text
    mirror of README.md's command tables (now including the Edit Macros
    section, added 2026-09-15). Lives in `src/`, not `media/`,
    since it's only ever read by `ispfEditorProvider.ts` (opening a new
    tab is extension-host-only) — keep it in sync manually with README
    whenever a command's syntax changes, same discipline as this file's
    own "Conventions" section already asks for.
  - `src/macros.ts` — edit-macro support, Phase 1 (added 2026-09-15, see
    Status above for the full design rationale). `findMacroFile(document,
    name)` resolves `.spfvs/macros/<name>.py` relative to the document's
    workspace folder; `isWorkspaceTrustedForMacros()` gates execution on
    VS Code's own Workspace Trust. `ispfEditorProvider.ts`'s
    `handleMacroAction` is the actual orchestration (lookup → backend
    `runMacro()` call → apply result as an ordinary `appliedByUs` edit,
    same path plain Monaco keystrokes use, deliberately not the
    `pendingBatchEditVersions` remapping path — Phase 1 macros can't
    change the line count, so there's nothing to remap yet).
    `handleMacroAction` gained a `labels` parameter 2026-09-16 (see
    Status above) — the same closure-local map prefix-command batches
    and `CUT`/`PASTE` already read, now ALSO handed to
    `runMacro()`/`EditContext.resolve_label()`, read-only.
  - `media/main.ts` — webview entry: boots Monaco, wires the gutter and
    command bar, message bridge to the extension host. Handles a
    `"setCursor"` message (added 2026-09-15) that moves the real cursor
    after a macro run — arrives deliberately AFTER the edit's own
    `"setContent"` message, whose `saveViewState`/`restoreViewState`
    would otherwise put the cursor back where it was instead of where
    the macro moved it.
  - `media/gutter.ts` — the editable prefix-command gutter. **Read the
    class doc comment before touching this file** — it explains why it's
    a plain DOM overlay (pooled/recycled `<input>` elements, windowed to
    the visible-line range + buffer) rather than any Monaco widget type.
    Also owns the LABEL display/lookup cache (`lineToLabel`/`labelToLine`,
    `setLabels()`, `resolveLabel()`) — it holds no authoritative label
    state itself, just mirrors whatever the extension host last pushed.
    `commit()` intercepts `hx`/`hx[n]` codes (via `HEX_CODE_RE`) and bare
    `cols` (via `COLS_CODE_RE`) BEFORE they'd otherwise be sent to the
    backend as a batch — see `hexView.ts`/`colsView.ts`'s class doc
    comments for why neither ever touches the backend at all, unlike
    every other prefix command including the other view-only ones
    (`x`/`xx`). Cell vertical positioning uses plain
    `getTopForLineNumber(line)` — NOT `includeViewZones: true`, which
    looks like the "obviously correct" fix for a cell rendering wrong
    near a shown hx/cols zone but is actually backwards for the line
    immediately after one (see the 2026-09-14 status entries — one wrong
    attempt, one corrected, with the exact Monaco-source derivation).
    New private `focusLine(line, caretPos)` (added 2026-09-14) backs
    Up/Down arrow navigation between cells, ISPF's own prefix-area
    walking convention.
  - `media/hexView.ts` — the `HX` line command's real implementation:
    Monaco's view-zone API (`changeViewZones`/`addZone`/`removeZone`),
    the same "reserve space in the render, not the model" category of
    trick `excludeFolding.ts` uses for EXCLUDE, but simpler here since HX
    doesn't need a `FoldingRangeProvider` — just a DOM node per shown
    line. Deliberately NOT remapped through restructuring the way LABEL/
    EXCLUDE are (any `onDidChangeModelContent` just clears every zone).
    Public `hideAll()` (added 2026-09-14, see Status above) lets
    `RESET`/`RES` clear every shown zone too, not just an edit.
  - `media/colsView.ts` — the `COLS` line command's real implementation
    (added 2026-09-14), modeled directly on `hexView.ts`'s `HexView` —
    same view-zone mechanism, same "any edit clears every zone"
    simplification, same `hideAll()` for `RESET`/`RES` — but with no
    counted form, since real ISPF's own COLS takes no operand.
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
    `lastFindColumnRange`/`lastFindWord` — the latter two added
    2026-09-14 alongside ISPF's `FIND`/`CHANGE` column-range restriction
    (`extractColumnRange`/`withinColumnRange`/`pickMatch`) and `WORD`
    qualifier (`extractWordQualifier`/`WORD_SEPARATORS`, passed straight
    through as Monaco's own `wordSeparators` find-API argument), see
    Status above). `undo`,
    `cancel`/`can`, `save`, `end`/`pf3`, `reset lab`/`res lab` (-> action
    `resetLabels`), and (added 2026-09-14) `cut` and `paste`/`paste a`/
    `paste b` return `{kind:"forward", action}` for the provider to
    execute against the real document or extension-host state (see
    ispfEditorProvider.ts's `handlePrimaryAction` for the first group and
    `handleClipboardAction` for cut/paste). `PASTE`'s forwarded outcome
    is the one `CommandOutcome` variant that carries extra payload
    (`line`/`before`) alongside `action` — `main.ts`'s forwarding handler
    spreads everything but `kind` into the posted message rather than
    just `{action}`. `executePrimaryCommand`'s 5th parameter,
    `clearViewZones` (added 2026-09-14, see Status above), is called by
    plain `RESET`/`RES` to hide any shown `hx`/`cols` zones alongside its
    existing un-hide-EXCLUDEd-lines job — `main.ts` wires it to both
    `HexView`/`ColsView`'s `hideAll()`. The `default:` switch case (added
    2026-09-15, see Status above) no longer resolves "unknown primary
    command" itself — it forwards EVERY non-built-in word as a
    `{action:"macro", name, args, cursorLine}` outcome instead, since
    macro files live on the filesystem this sandboxed webview can't see;
    the extension host makes the final "macro or genuinely unknown" call.
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
  (`.name`/`.`), EXCLUDE (`x[n]`/`xx`...`xx`), SHIFT — Column Shift
  `)`/`)n`/`(`/`(n` single-line plus a REAL block form `))`...`))`/
  `((`...`((` (paired markers like `dd`...`dd`, not a repeat-to-multiply
  trick — rebuilt against actual IBM docs 2026-09-15, see Status; `>`/`<`
  removed entirely, they're a different unimplemented ISPF command, not
  aliases) — `RR`...`RR` block repeat, `UC`/`LC` case conversion, and the
  2026-09-14 `pending_mark`/`execute_cut`/`execute_paste` design: an
  unpaired `c[n]`/`cc`/`m[n]`/`mm` becomes a pending copy/move mark
  (paired ones are unaffected, unchanged in-file copy/move), resolved by
  the `CUT`/`PASTE` **primary** commands via `process()`'s
  `execute_cut`/`execute_paste` flags — `prefix_commands.py` itself never
  parses the words `cut`/`paste`, those only exist in
  `primaryCommand.ts` now. `macros.py` (added 2026-09-15, see Status
  above) is a SEPARATE module with its own request type (`server.py`'s
  `"type": "runMacro"` dispatch) — a macro's `EditContext`/`run_macro()`
  never touches `prefix_commands.py` or its `process()` engine at all.
  `EditContext.resolve_label()` (added 2026-09-16, see Status above) is
  the one place macros DO touch caller-owned state also used elsewhere
  (the `labels` map) — but strictly read-only, passed in fresh on every
  call, never written back. `EditContext.insert_after`/`insert_before`/
  `delete_line`/`delete_lines` (also added 2026-09-16, see Status above)
  let a macro change the document's LINE COUNT for the first time —
  Copy/Move have no dedicated method, composed from these plus
  `get_line` instead (see `.spfvs/macros/duplicateline.py`).
  `pytest backend/tests/` — **151 tests, all
  passing** (102 in `test_prefix_commands.py` + 49 in `test_macros.py`),
  covers single and block delete/repeat/insert/copy/move
  including move-up (destination line above the source), every
  documented error case, LABEL set/clear/reassign/reserved-name/case-
  folding/duplicate-in-batch, EXCLUDE set/count/block/unmatched/
  accumulate, SHIFT single-line right/left/explicit-count/truncation plus
  the block form's default/opening-count/closing-count/closing-wins/
  unmatched/label-survives/overlap-rejected, `>`/`<` and `)))`+ correctly
  unknown-command, RR default/opening-count/closing-count/unmatched, UC/LC
  single/range/too-many-markers/case-insensitivity, and the
  pending-mark/CUT/PASTE design (mark creation single/block/copy/move,
  setting-while-pending is an error, remapping through same-batch and
  later-batch restructuring, dropped when its line is deleted,
  execute_cut both mark kinds and its no-mark error, execute_paste
  after/before/empty-clipboard-error/non-consuming, and
  cut-in-one-document-then-paste-in-another), all plus remapping through
  every restructuring op where applicable, PLUS (in `test_macros.py`)
  every `EditContext` member in isolation, `run_macro()`'s full success/
  every-failure-mode matrix, and `test_shipped_todocomment_example_macro`
  — the one integration test that loads and runs the ACTUAL shipped
  `.spfvs/macros/todocomment.py` file rather than a synthetic fixture, so
  this file's own description of that macro can't silently drift from
  what it really does. This is the trustworthy, already-verified layer;
  the webview/gutter wiring is the layer still under manual test.

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
- SHIFT line commands (rebuilt 2026-09-15 against actual IBM docs —
  entirely unexercised in this final shape): `)` shifts a line right by
  the default 2 columns, `(` shifts left; `)6`/`(6` shift by exactly 6
  columns; `))1` alone (unpaired) should be REJECTED as **"unmatched
  '))' starting at line N"** (not "unknown command") — this is the exact
  case that kicked off this whole investigation, so it's the single most
  important thing to re-verify; `)))` (three or more) should be REJECTED
  as "unknown line command"; `>` and `<` alone should ALSO be "unknown
  line command" (they used to be treated as aliases of `)`/`(` — confirm
  that's really gone, not silently still shifting); shifting left past a
  line's actual content should truncate it (not error); a shifted line's
  label should stay put.
- SHIFT BLOCK form (new 2026-09-15, entirely unexercised — this is the
  actual real ISPF construct `))`/`((` turned out to be): type `))` on
  one line and `))` again on a later line, commit, and confirm every
  line from the first to the last (inclusive) shifted right by the
  default 2 columns — NOT just the two marker lines; try `((`...`((` for
  left; put an explicit count on the OPENING marker only (`))3`...`))`)
  and confirm the whole block shifts by 3; put it on the CLOSING marker
  only (`))`...`))3`) — same result; put DIFFERENT counts on both
  (`))5`...`))3`) and confirm the CLOSING one (3) wins; an unmatched
  `))` or `((` (opened, never closed) should reject the whole batch; a
  label on a line inside the shifted block should stay on that same
  line, unmoved; a separate line command (e.g. `d`) on a line INSIDE a
  `))`...`))` range should be rejected as overlapping, same as it would
  be for `dd`...`dd`.
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
- COLS line command (new 2026-09-14; owner already tried this once and
  hit the RES gap fixed in the "RESET now clears HX/COLS rulers too"
  status entry above — re-verify with that fix in place): `cols` on a
  line shows a column ruler underneath it (`----+----1----+----2...`);
  typing `cols` again on **that same line** (not the ruler's own row,
  which has no gutter cell) hides it; running `RESET`/`RES` also hides
  it (this is the new part — confirm it actually disappears now); the
  ruler's width should span at least the longest line in the file
  (verify against a file with a long line); typing directly into Monaco
  (or committing any prefix-command batch) while a ruler is showing
  should make it disappear, same as `hx`; there's no counted form —
  `cols3` should be sent to the backend as an unknown command and error,
  not treated as "show cols on 3 lines."
- HX rulers also cleared by RESET (new 2026-09-14, same fix as COLS
  above, entirely unexercised specifically for this): show `hx` on a
  line, run `RESET`/`RES`, confirm the hex rows disappear (this used to
  require retyping `hx` on the same line or making any edit — RES is a
  new third way to clear it).
- Gutter cells below a shown HX/COLS zone (bug fix, REVERTED AND
  RE-FIXED 2026-09-14 — this is the third round on this exact issue, see
  the two status entries above): show `cols` (or `hx`) on some line,
  then type a line command (e.g. `d`, `.a`) into the gutter cell for the
  line **immediately below** the ruler/hex rows and confirm it lands on
  the correct real line, not shifted onto/near the ruler's own row —
  verify for a few lines below it too, and after scrolling the zone
  partially off-screen. This exact scenario was reported broken twice in
  a row (once before any fix, once again after the first, wrong fix) —
  confirm carefully rather than assuming it's fine this time.
- Gutter Up/Down arrow navigation (new 2026-09-14, entirely unexercised):
  focus a prefix cell, press Down — focus should move to the cell
  directly below, at the same caret column (not reset to the start);
  press Up to go back; try it at/near the top and bottom of the file
  (should just stop, not error); try it right after scrolling so the
  target cell isn't currently pooled — it should still work (scrolls the
  target into view first); try it with a shown hx/cols zone in between
  two lines, to make sure arrow-nav and the zone-positioning fix above
  don't interact badly.
- WORD qualifier for FIND/CHANGE (new 2026-09-14, entirely unexercised):
  `find dcl word` matches only the whole word `dcl`, not `dcla`/`xdcl`;
  `c dcl declare word all` changes every whole-word `dcl` to `declare`
  — note this is NOT the same token order as the owner's own original
  example (`c dcl word all declare`); flag to the owner whether the
  documented order (old, new, WORD, scope) is acceptable or the original
  phrasing was actually the intended syntax. Also verify: `word` combines
  with a column range (`find 'x' word 8 10`); a bare `find`/`rfind`
  repeat after a WORD-qualified FIND keeps requiring whole-word matches;
  `find word` alone (one token) searches for the literal text "word",
  not an empty WORD-qualified search.
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
- HELP primary command (new 2026-09-14, entirely unexercised): `help`/
  `h` opens a new tab BESIDE the current one showing the command
  reference; confirm it's a plain text tab (not another SPFVS custom
  editor) and doesn't disturb the currently-open SPFVS file/cursor
  position; running it again should open ANOTHER new tab (by design —
  not reused/tracked); spot-check the listed syntax against a few
  recently-added commands (WORD qualifier, COLS, CUT/PASTE) for drift
  against `helpText.ts`'s hand-maintained content.
- Edit macros, Phase 1 (new 2026-09-15, entirely unexercised — the
  actual real-world test of the whole design): open THIS repo (`spfvs`)
  in SPFVS itself, put the cursor anywhere, and type `todocomment` in
  `COMMAND ===>` — every line containing `/*` should get `COMMENT: `
  prefixed onto that `/*`, and the status message should report
  `ISPF EDIT MACRO FINISHED` / the file's line count; confirm the
  document is genuinely dirty/undoable afterward (Ctrl+Z should revert
  it, same as any other edit); type a genuinely unknown word (no
  matching `.spfvs/macros/*.py`) and confirm the ordinary "unknown
  primary command" error still appears, unchanged from before macros
  existed; open a DIFFERENT file/folder that VS Code treats as
  untrusted (or explicitly restrict trust) and confirm typing
  `todocomment` there is blocked with a clear message rather than either
  silently doing nothing or silently running anyway — this is the one
  actual safety mechanism in Phase 1, worth verifying carefully rather
  than assuming; try a macro name that collides with a real primary
  command (e.g. create `.spfvs/macros/save.py` and confirm typing `save`
  still does the REAL save, never reaches the macro file) to confirm
  built-ins still win as designed.
- `ctx.resolve_label()` (new 2026-09-16, entirely unexercised): in a
  real file, set a label with `.foo` in the gutter and commit that
  batch; create a small test macro (e.g.
  `.spfvs/macros/showlabel.py`) whose `run(ctx, args)` does
  `ctx.message(str(ctx.resolve_label(".foo")))` and confirm it reports
  the correct line number; confirm `.ZFIRST`/`.ZLAST` report line 1 /
  the last line, and `.ZCSR` reports wherever the cursor actually was
  when the macro ran; move `ctx.cursor_line` inside the SAME macro and
  confirm a subsequent `resolve_label(".ZCSR")` call reflects the NEW
  position, not the original one; resolve a label that was never set
  and confirm it reports `None` rather than erroring.
- Macro output routing to "SPFVS Macros" (new 2026-09-16, entirely
  unexercised): run `todocomment` and confirm the status bar shows a
  short summary + `— see "SPFVS Macros" output for full result` rather
  than a truncated wall of text, AND that the "SPFVS Macros" output
  channel actually opens (without stealing focus from the editor) and
  contains the full two-line message prefixed with `[todocomment]`; do
  the same for `showlabel foo`; write a trivial macro whose message is
  a short one-liner (e.g. `ctx.message("done")`) and confirm THAT one
  still shows directly in the status bar with no output channel
  involvement at all — this is the regression check, since the routing
  logic must not affect the common short-message case; check the output
  channel is reachable from the normal "Output" panel dropdown (it's a
  real `vscode.OutputChannel`, not anything bespoke).
- Macro insert/delete-line support (new 2026-09-16, entirely
  unexercised — the first macro capability that changes the document's
  LINE COUNT, worth testing carefully): `duplicateline` on some line
  duplicates it right after itself and the line count grows by one;
  `duplicateline before` puts the copy before instead; `duplicateline
  move` relocates the line to the end of the file (count UNCHANGED,
  content reordered) rather than copying it; confirm the resulting
  document is genuinely dirty/undoable (Ctrl+Z reverts it) same as any
  other edit; if a label was set anywhere in the file before running
  any of these, confirm it's DROPPED afterward (expected — same
  "ordinary edit resets caller-owned state" behavior every other
  non-batch edit already has, not a new regression to chase); write a
  quick throwaway macro that does `ctx.delete_lines(a, b)` spanning the
  cursor's own current line and confirm the real editor's cursor ends
  up on a valid line afterward (the new `_clamp_cursor` behavior) rather
  than erroring or landing somewhere nonsensical; try `insert_after`/
  `insert_before`/`delete_line`/`delete_lines` with an out-of-range line
  number and confirm the macro fails with a clear
  `line N is out of range` message, same as any other macro error.

## Conventions

- Test before commit/push (see Status section above — no git history
  exists yet, so this applies from the very first commit onward).
- Bump `extension/package.json`'s `version` before every
  package/install cycle during active debugging (see Build section).
- Keep `README.md` (repo root) in sync with the supported command tables
  — it's the user-facing reference; this file is the *why*, README is
  the *what*.
