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
approved.** This repo has no git history yet at all — don't `git init`
or commit without being asked.

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
    (`undo`/`undoAll`/`save`/`cancel`/`end`/`resetLabels` — see below),
    cache-busting query param on the webview asset URLs
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
  - `media/primaryCommand.ts` — `COMMAND ===>` bar command parsing/
    execution. `find`/`f`, `change`/`c`, `top`/`t`, `bottom`/`bot`,
    `locate`/`loc`/`l`, `exclude`/`x`, `reset`/`res` resolve entirely
    client-side against Monaco's model APIs (`locate` and the two-label
    form of `exclude` go through `gutter.ts`'s `resolveLabel` via the
    `LabelResolver` param; `exclude`/`res` report what they changed back
    to the extension host via the `ExcludedLinesNotifier` param, so its
    `excludedLines` copy stays correct for the next gutter x/xx batch —
    see Status above). `undo`, `cancel`/`can`, `save`, `end`/`pf3`, and
    `reset lab`/`res lab` (-> action `resetLabels`) return
    `{kind:"forward", action}` for the provider to execute against the
    real document or extension-host state (see ispfEditorProvider.ts's
    `handlePrimaryAction`).
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
- `backend/` — Python package `ispf_backend`, pure prefix-command
  semantics, no VS Code awareness. `prefix_commands.py`'s module
  docstring documents the full supported command grammar and validation
  rules, including LABEL (`.name`/`.`), EXCLUDE (`x[n]`/`xx`...`xx`, both
  added 2026-09-12), and SHIFT (`)`/`((`/`>`/`<<`/etc., added
  2026-09-13). `pytest backend/tests/` — 65 tests, all passing, covers
  single and block delete/repeat/insert/copy/move including move-up
  (destination line above the source), every documented error case,
  LABEL set/clear/reassign/reserved-name/case-folding/duplicate-in-batch,
  EXCLUDE set/count/block/unmatched/accumulate, and SHIFT
  right/left/explicit-count/angle-bracket-aliases/truncation, all plus
  remapping through every restructuring op where applicable. This is
  the trustworthy, already-verified layer; the webview/gutter wiring is
  the layer still
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

## Conventions

- Test before commit/push (see Status section above — no git history
  exists yet, so this applies from the very first commit onward).
- Bump `extension/package.json`'s `version` before every
  package/install cycle during active debugging (see Build section).
- Keep `README.md` (repo root) in sync with the supported command tables
  — it's the user-facing reference; this file is the *why*, README is
  the *what*.
