# SPFVS

A VS Code custom editor that recreates the ISPF full-screen editing
experience: a Monaco-based editor with a real, editable prefix-command
gutter to its left (`cc`...`cc`, `mm`...`aa`, `dd`...`dd`, `d5`, etc.),
instead of VS Code's plain line-number column.

Opens on demand for any file via **Reopen With -> SPFVS** — it does
not replace VS Code's default editor.

## Project layout

- `extension/` — the VS Code extension (TypeScript). Owns the custom
  editor registration, the Monaco integration, and the viewport-synced
  gutter overlay (`extension/media/gutter.ts` — see the comment at the
  top of that file for why it's a plain DOM overlay rather than a Monaco
  widget).
- `backend/` — a Python package (`ispf_backend`) implementing ISPF
  line-prefix-command semantics (delete/repeat/insert/copy/move/exclude,
  single and block forms, plus LABEL). Pure and unit-tested; talks to the extension over
  newline-delimited JSON on stdin/stdout. See the module docstring in
  `backend/ispf_backend/prefix_commands.py` for the full supported
  command set and validation rules.

## Running it

**Backend tests** (the correctness gate for prefix-command semantics):

```
cd backend
pip install -e .
pip install pytest
pytest
```

**Extension, in the VS Code Extension Development Host:**

```
cd extension
npm install
npm run compile
```

Then open the `extension/` folder in VS Code and press F5 (or use
**Run SPFVS Extension** from the Run panel) to launch a dev host window.
In that window, open any file and use **Reopen With -> SPFVS**.

The extension spawns `python -m ispf_backend` from PATH by default;
set `spfvs.pythonPath` in settings if your Python isn't on PATH.

## Installing on another machine

There's no Marketplace listing, so getting this onto a second machine
means cloning the (private) source repo:

```
git clone https://github.com/markons/spfvs.git
```

Two independent things are then required to actually run it — independent
because **the packaged `.vsix` does not contain the Python backend at
all**: `extension/.vscodeignore` strips everything down to the compiled
`dist/`, the icon, and `package.json`, and `backend/` isn't even inside
`extension/` to begin with, so `vsce package` never sees it.

Prerequisites on the target machine:

- VS Code 1.90 or newer.
- Python 3.9+ with `pip`, reachable as `python` on PATH (or note its
  full path — you'll need it for the `spfvs.pythonPath` setting
  below if it isn't).
- Node.js + npm — only needed if you're building the `.vsix` **on** this
  machine; skip it entirely if you're just copying in an already-built
  `.vsix` from wherever it was built.

**1. Install the Python backend.** This is what actually gets spawned as
`python -m ispf_backend` at runtime — do this on the target machine,
from the `backend/` folder:

```
cd backend
pip install .
```

Use `pip install .` (not the `-e .` from "Running it" above) for a
machine that's going to run this, not develop it: a regular install
copies the package into `site-packages`, so the `backend/` source folder
doesn't need to stick around afterward. `-e .` is only worth it if
you're actively editing backend code on that same machine and want
changes picked up without reinstalling.

**2. Build and install the extension.** Either build fresh, on the
target machine:

```
cd extension
npm install
npx vsce package
code --install-extension spfvs-<version>.vsix
```

...or build the `.vsix` once anywhere with Node/npm installed, then copy
just that one `.vsix` file to the target machine and run the
`code --install-extension` line there — Node/npm aren't needed on a
machine that's only installing an already-built `.vsix`, not building one.

**3. Point at Python, if needed.** If `python` isn't on PATH on the
target machine, or resolves to a different Python than the one step 1
installed the backend into, set `spfvs.pythonPath` (VS Code
settings) to that Python's full path *before* opening a file in SPFVS —
otherwise the extension shows an error trying to launch the backend, per
file, until this is set.

**4. Use it.** Open any file, **Reopen With -> SPFVS**.

**Updating an existing install** (a newer `.vsix` after a code change):
bump the `version` field in `extension/package.json` before repackaging
— VS Code's webview asset caching plus its install-folder-per-version
behavior make it genuinely ambiguous whether a same-version reinstall
actually took effect. After `code --install-extension --force` with the
bumped version, **Developer: Reload Window** has been sufficient in
practice to pick it up; a full quit-and-relaunch of VS Code is the
guaranteed fallback if Reload Window ever doesn't seem to take. If the
**backend** changed too, re-run `pip install .` in `backend/` as well —
the extension restarts its backend process automatically the next time
it's needed, but only picks up new backend code if the installed Python
package itself was actually updated first.

## Supported prefix commands (MVP)

| Code | Meaning |
|---|---|
| `d[n]` | delete n lines starting here (default 1) |
| `r[n]` | repeat this line n times |
| `i[n]` | insert n blank lines after this line |
| `c[n]` | mark n lines starting here as a copy source |
| `m[n]` | mark n lines starting here as a move source |
| `dd`...`dd` | delete the block between two `dd` markers |
| `cc`...`cc` | mark a block as a copy source |
| `mm`...`mm` | mark a block as a move source |
| `a` | destination marker: after this line |
| `b` | destination marker: before this line |
| `x[n]` | EXCLUDE: hide n lines starting here from view (default 1) |
| `xx`...`xx` | EXCLUDE the block between two `xx` markers from view |
| `)`, `))`, ... / `>`, `>>`, ... | SHIFT this line's text right by 2 columns per repeated character |
| `)n` / `>n` | SHIFT this line's text right by exactly n columns |
| `(`, `((`, ... / `<`, `<<`, ... | SHIFT this line's text left by 2 columns per repeated character |
| `(n` / `<n` | SHIFT this line's text left by exactly n columns |
| `.name` | LABEL: assign `name` (1-8 chars, must start with a letter) to this line |
| `.` | clear whatever label is on this line |

A copy/move source's destination marker can be on a line before **or**
after the source (moving a block up the file works the same as moving it
down). Committing a batch keeps the cursor and scroll position where they
were (Monaco's own `setValue()`, used to apply the backend's resulting
document, would otherwise reset the view to the top of the file on every
commit). A batch of prefix commands is applied all-or-nothing: any error
(unmatched block marker, orphan destination, overlapping ranges, etc.)
rejects the whole batch and leaves the offending gutter cells in place
with a tooltip explaining why, instead of partially applying it.

`)`/`(` and their `>`/`<` aliases physically edit the line, unlike every
other command on this page below (labels/exclude are view-only, the rest
restructure whole lines): shifting right prepends blank columns, and
shifting left **blindly drops** the leftmost n characters, blank or not —
matching real ISPF, where shifting left too far discards actual text
rather than stopping politely at the first non-blank column. `2 columns
per repeated character` is a documented default this project chose (the
2 isn't independently verified against IBM's own default, which is
profile-configurable); an explicit `)n`/`(n`/`>n`/`<n` count always
overrides it with an exact column number instead of a multiple.

Like a LABEL, `x`/`xx` don't restructure the document — hiding a line is a
view-only effect, persistent editor-session state that follows its line
through later restructuring the same way a label does (dropped if the
line is deleted, follows a moved line, stays put on a copy/repeat/insert's
source line). Unlike a label, there's no prefix command to *un*-hide a
specific line once excluded this way — that's what the `RESET` primary
command is for (see below), matching ISPF. `x`/`xx` also *accumulate*
across separate gutter commits (hide one line, then hide another later —
both stay hidden), unlike the primary `EXCLUDE` command below, which
replaces the whole hidden set on each call.

Unlike the commands above, a LABEL doesn't restructure anything either —
it's persistent, editor-session state (dropped on any external change to
the document, since it's tracked purely by line number) that stays
displayed in its gutter cell instead of being cleared after it's applied.
It moves with its line when that line is moved, stays put on a
copy/repeat/insert's *source* line, and is dropped if its line is
deleted. Names are case-insensitive (folded to uppercase) and names
starting with `Z` are reserved for the system labels
`.ZFIRST`/`.ZLAST`/`.ZCSR` (first line, last line, current cursor line —
always available, never stored), the same reservation ISPF itself makes.
Labels are used as operands for the `LOCATE` primary command and a
two-label `EXCLUDE`/`X` range — see below.

## Primary commands

A `COMMAND ===>` bar sits above the editor for whole-file commands, as
opposed to the per-line prefix commands above. `FIND`/`RFIND`/`CHANGE`/
`TOP`/`BOTTOM`/`LOCATE`/`EXCLUDE`/`RESET` run entirely client-side against
Monaco's own model (`extension/media/primaryCommand.ts`), with `LOCATE`
and the label form of `EXCLUDE` resolving `.name` operands against the
gutter's committed label map (`extension/media/gutter.ts`'s
`resolveLabel`); `UNDO`/`SAVE`/`CANCEL`/`END` are forwarded to the
extension host since they need the real `vscode.TextDocument` or a
workbench command.

| Command | Meaning |
|---|---|
| `find <text>` / `f <text>` | jump to the next match after the cursor (wraps around) |
| `find <text> first` / `f <text> first` | jump to the first match in the whole file |
| `find <text> last` / `f <text> last` | jump to the last match in the whole file |
| `find <text> all` / `f <text> all` | jump to the first match and report the total match count |
| `find` / `f` (no text) | repeat the last search, same as `rfind` |
| `rfind` / `rf` | repeat the last search (ISPF's PF5) |
| `change <old> <new> [all]` / `c <old> <new> [all]` | replace next match, or every match with `all` |
| `top` / `t` | move to the top of the file |
| `bottom` / `bot` | move to the bottom of the file |
| `locate .label` / `loc .label` / `l .label` | move to the line carrying that label |
| `exclude <text>` / `x <text>` | hide lines containing text (view-only, no edit) |
| `exclude all` / `x all` | hide every line |
| `exclude .a .b` / `x .a .b` | hide the range between two labels, inclusive (either order) |
| `reset` / `res` | show all excluded lines again (both `EXCLUDE`- and `x`/`xx`-hidden), but leave labels alone |
| `reset lab` / `res lab` | clear every LABEL (does *not* un-hide anything) |
| `undo` | undo one edit |
| `undo all` | discard all unsaved changes, reverting to the on-disk version |
| `save` | save the file |
| `cancel` / `can` | discard all unsaved changes and close the editor |
| `end` / `pf3` | save and close the editor |

A bare `FIND`/`F` (no search text at all) and `RFIND`/`RF` are the same
operation — this project's stand-in for ISPF's PF5 "repeat find" key,
since a text command bar has no PF5 to bind. Both repeat whatever text
was last searched for (by `FIND`, in any scope), always moving forward
from the cursor regardless of what scope that original search used. A
single word that happens to spell `first`/`last`/`all` is still treated
as literal search text unless there's at least one more word before it
(`find first` searches for "first"; `find x first` finds the first `x`) —
same disambiguation `CHANGE`'s trailing `all` already used.

`FIND`/`LOCATE` **permanently un-hide** their target line if it's
currently inside an `EXCLUDE`d or `x`/`xx`-hidden region — otherwise the
line would stay collapsed and invisible even after "found"/reached, which
matters most right after `EXCLUDE ALL`/`X ALL`: `FIND text ALL` then
un-hides every matching line while leaving non-matching ones hidden,
turning an all-excluded view into a filtered one showing just the hits.
This is a real (tracked, remappable) state change, not a transient peek —
the revealed line(s) stay visible until re-excluded or `RESET`.

`EXCLUDE` replaces the hidden-line set on each call rather than
accumulating across multiple `EXCLUDE` commands — a deliberate MVP
simplification (`x`/`xx` in the gutter, by contrast, accumulate — see
above). Plain `RESET`/`RES` clears whichever lines are currently hidden
regardless of whether `EXCLUDE` or a gutter `x`/`xx` put them there, but
never touches labels; `RESET LAB`/`RES LAB` is the mirror image — it
clears every label and never touches hidden lines. There's no combined
"reset everything" form (deliberate: the two are independent state with
independent lifetimes). `UNDO` (single-step, no `ALL`) relies on VS Code
routing the `undo` command to whichever editor is currently focused,
since there's no per-document API for "step back one undo entry" — the
other actions (`UNDO ALL`, `SAVE`, `CANCEL`, `END`, `RESET LAB`) address
the document/extension-host state directly and don't depend on focus.

## Known limitations / follow-up work

- Syntax coloring beyond Monaco's built-ins is implemented only for PL/I
  (`extension/media/pliLanguage.ts`, seeded from `pli-pygen`'s keyword
  table). COBOL coloring is not implemented.
- The gutter's typed-but-uncommitted values are keyed by line number and
  are not remapped if an ordinary text edit elsewhere inserts/deletes
  lines above an uncommitted gutter entry.
- LABELs and `x`/`xx`-hidden lines are editor-session state, not saved
  with the file (matching ISPF's own default behavior) — both are dropped
  on any change to the document that didn't go through the prefix-command
  gutter (typing directly into Monaco, undo/redo, another editor, git,
  `UNDO ALL`, `CANCEL`), since they're tracked purely by line number and
  such a change isn't run through the batch's remapping logic. Both are
  also local to this one editor tab/session (nothing is persisted if you
  close and reopen the file).
- No Monaco web worker is configured (`editor.api` core only, no
  `vs/language/*` rich services) — Monaco falls back to main-thread
  computation for anything that would normally use one, which is fine
  for the plain/basic-language editing this project targets, but means
  there's no JS/TS/JSON/CSS/HTML IntelliSense (only Monarch-based
  coloring for those languages).
