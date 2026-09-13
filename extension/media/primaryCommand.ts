import type * as monacoNs from "monaco-editor/esm/vs/editor/editor.api";
import { getExcludedLines, linesToRanges, rangesToLines, setExcludedRanges } from "./excludeFolding";

interface Handled {
  message: string;
  isError?: boolean;
}

/** UNDO/CANCEL/SAVE/END need the real vscode.TextDocument or a workbench
 * command — those can only run in the extension host, so the caller must
 * forward them via postMessage. RESET LAB is also forwarded: labels are
 * extension-host-owned state (see ispfEditorProvider.ts), so clearing
 * them means the host, not just this webview's Monaco model. CUT/PASTE
 * are forwarded too — they resolve a gutter-set pending copy/move mark
 * (or, for PASTE, the clipboard) via the SAME backend `process()` used
 * for gutter batches, which this webview has no direct line to (see
 * prefix_commands.py's module docstring and ispfEditorProvider.ts's
 * handleClipboardAction). Everything else (FIND/RFIND/CHANGE/SORT/TOP/
 * BOTTOM/LOCATE/EXCLUDE/RESET) is resolved entirely against Monaco's own
 * model here. */
export type CommandOutcome =
  | ({ kind: "handled" } & Handled)
  | { kind: "forward"; action: "undo" | "undoAll" | "cancel" | "save" | "end" | "resetLabels" | "cut" }
  | { kind: "forward"; action: "paste"; line: number; before: boolean };

/** Notifies the extension host that the webview's own EXCLUDE/RESET just
 * changed which lines are hidden, so its excluded-lines state (kept in
 * sync alongside LABELs, for the exact same reason: it needs to be the
 * baseline the next prefix-command x/xx batch remaps through) stays
 * correct. Not called for a prefix-command-driven exclude — that already
 * comes back from the backend via a "prefixResult"/"setContent" message,
 * so notifying again here would just relay it back to where it came from. */
export type ExcludedLinesNotifier = (lines: number[]) => void;

/** Splits on whitespace but keeps "..."/'...' groups intact, so
 * `change "old text" "new text"` works the way ISPF's own quoted
 * FIND/CHANGE strings do. */
function splitArgs(text: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** Resolves a LABEL token (e.g. ".A", ".ZFIRST") to a line number. Backed
 * by the gutter's committed-label map plus the ZFIRST/ZLAST/ZCSR reserved
 * names (see gutter.ts's resolveLabel) — primaryCommand.ts has no label
 * state of its own. */
export type LabelResolver = (token: string) => number | undefined;

function isLabelToken(token: string | undefined): token is string {
  return !!token && token.startsWith(".");
}

/** Un-excludes (permanently, not just for this one reveal) whichever of
 * `lines` are currently hidden, so a FIND/LOCATE target that lands inside
 * an excluded region is actually visible afterward rather than silently
 * scrolling to a collapsed, invisible row. Removing them from the
 * excluded set (rather than some transient "peek" that a later
 * setExcludedRanges call could undo) keeps the webview's folding state
 * and the extension host's remapped-through-restructuring copy (see
 * ExcludedLinesNotifier) consistent with what's actually on screen. A
 * no-op — no fold/unfold flicker — when none of `lines` were hidden. */
async function revealAndUnexclude(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  lines: number[]
): Promise<void> {
  const stillExcluded = new Set(getExcludedLines());
  let changed = false;
  for (const line of lines) {
    changed = stillExcluded.delete(line) || changed;
  }
  if (!changed) return;
  const remaining = [...stillExcluded];
  await setExcludedRanges(editor, linesToRanges(remaining));
  notifyExcludedLinesChanged(remaining);
}

/** LOCATE accepts either a `.label` (resolved via `resolveLabel`) or a
 * plain line number, e.g. `LOCATE 50` — real ISPF's own, arguably more
 * commonly-used form, previously missing here entirely. */
async function doLocate(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  resolveLabel: LabelResolver,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  token: string
): Promise<Handled> {
  let line: number | undefined;
  if (isLabelToken(token)) {
    line = resolveLabel(token);
    if (line === undefined) return { message: `label '${token}' not found`, isError: true };
  } else {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1) {
      return { message: "LOCATE requires a label or a line number, e.g. LOCATE .A or LOCATE 50", isError: true };
    }
    const totalLines = model.getLineCount();
    if (n > totalLines) return { message: `line ${n} is out of range (document has ${totalLines} lines)`, isError: true };
    line = n;
  }
  await revealAndUnexclude(editor, notifyExcludedLinesChanged, [line]);
  editor.setPosition({ lineNumber: line, column: 1 });
  // revealRangeAtTop on a single-point range (Monaco has no revealLineAtTop
  // — only revealLineNearTop, which is an approximate offset, not an exact
  // top placement): ISPF's own LOCATE always pins the target line to the
  // top of the screen, regardless of where it was relative to the current
  // viewport.
  editor.revealRangeAtTop({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
  return { message: `line ${line}` };
}

type FindScope = "next" | "prev" | "first" | "last" | "all";

/** Remembers the most recent FIND's search string and direction,
 * module-scoped like excludeFolding.ts's `currentRanges` (one JS module
 * instance per webview, so this is naturally per-editor-session state) —
 * backs both a bare `FIND`/`F` with no arguments and the explicit
 * `RFIND`/`RF` command, ISPF's real PF5 "repeat find" equivalent. The
 * needle is set whenever a non-empty one is parsed, whether or not that
 * search actually found anything, so retrying after e.g. an edit still
 * repeats the same text. The direction only updates for NEXT/PREV (an
 * explicit direction to continue in) — FIRST/LAST/ALL are one-shot jumps,
 * not something a repeat should try to redo, so they leave it alone. */
let lastFindNeedle: string | null = null;
let lastFindDirection: "next" | "prev" = "next";
/** The column restriction (if any) from the last explicit FIND, reused by
 * a bare FIND/RFIND repeat the same way the needle and direction are. */
let lastFindColumnRange: ColumnRange = null;

/** Splits a trailing FIRST/LAST/NEXT/PREV/ALL scope keyword off the end
 * of a command's argument list — shared by FIND and CHANGE, both of
 * which support the same scopes — requiring at least one token before it
 * so a literal one-word search for e.g. "first" isn't misread as the
 * scope keyword. Returns the remaining args unjoined (FIND wants them
 * joined into one needle; CHANGE wants old/new as separate tokens). */
function extractTrailingScope(args: string[]): { rest: string[]; scope: FindScope } {
  let rest = args;
  let scope: FindScope = "next";
  if (rest.length > 1) {
    const last = rest[rest.length - 1].toLowerCase();
    if (last === "all" || last === "first" || last === "last" || last === "next" || last === "prev") {
      scope = last;
      rest = rest.slice(0, -1);
    }
  }
  return { rest, scope };
}

type ColumnRange = { start: number; end: number } | null;

/** Extracts a trailing "c1 c2" column-range pair (1-indexed, inclusive)
 * off the end of an args list — ISPF's own `FIND string c1 c2` /
 * `CHANGE old new c1 c2` syntax (column limits come after the search
 * text but before any FIRST/LAST/NEXT/PREV/ALL scope keyword, which the
 * caller must already have stripped via `extractTrailingScope` before
 * calling this). `minRemaining` is how many tokens must be left over
 * AFTER removing the two column tokens (1 for FIND's needle, 2 for
 * CHANGE's old+new) — without that check, an unquoted numeric search
 * like `find 100 200` (no column restriction intended) would be
 * misread as a column-only command with an empty needle. A quoted
 * search string (`find '100' 8 10`) collapses to one token before this
 * ever runs (see splitArgs), so quoting still disambiguates exactly the
 * way it does in real ISPF. */
function extractColumnRange(args: string[], minRemaining: number): { rest: string[]; range: ColumnRange } {
  if (args.length - 2 < minRemaining) return { rest: args, range: null };
  const [c1, c2] = args.slice(-2);
  if (!/^\d+$/.test(c1) || !/^\d+$/.test(c2)) return { rest: args, range: null };
  const start = Number(c1);
  const end = Number(c2);
  if (start < 1 || end < start) return { rest: args, range: null };
  return { rest: args.slice(0, -2), range: { start, end } };
}

/** True if a match lies entirely within an (inclusive, 1-indexed) column
 * range — `null` (no range given) always passes. `range.endColumn` is
 * one PAST the last matched character (Monaco convention), so the last
 * column actually used is `endColumn - 1`. */
function withinColumnRange(range: monacoNs.Range, cols: ColumnRange): boolean {
  if (!cols) return true;
  return range.startColumn >= cols.start && range.endColumn - 1 <= cols.end;
}

function comparePositions(a: monacoNs.IPosition, b: monacoNs.IPosition): number {
  return a.lineNumber !== b.lineNumber ? a.lineNumber - b.lineNumber : a.column - b.column;
}

/** Picks one match out of a column-filtered, document-order match list
 * for the NEXT/PREV/FIRST/LAST scopes (ALL is handled separately by the
 * caller, since it wants every match, not one). NEXT/PREV wrap around
 * the document the same way Monaco's own findNextMatch/findPreviousMatch
 * do when there's no column restriction to honor. */
function pickMatch(
  matches: monacoNs.editor.FindMatch[],
  scope: Exclude<FindScope, "all">,
  cursorPos: monacoNs.IPosition
): monacoNs.editor.FindMatch | null {
  if (matches.length === 0) return null;
  if (scope === "first") return matches[0];
  if (scope === "last") return matches[matches.length - 1];
  if (scope === "prev") {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (comparePositions(matches[i].range.getStartPosition(), cursorPos) < 0) return matches[i];
    }
    return matches[matches.length - 1];
  }
  return matches.find((m) => comparePositions(m.range.getStartPosition(), cursorPos) > 0) ?? matches[0];
}

/** FIND ALL needs to actually show every hit, not just report a count —
 * including ones sitting inside an EXCLUDEd/x'd region, which would
 * otherwise stay collapsed and invisible even after "found". FIRST/LAST
 * search from the very top/bottom of the file regardless of the cursor;
 * NEXT/PREV (the default, also what a bare FIND/RFIND repeats) search
 * forward/backward from the cursor and wrap, as before.
 *
 * `cols` is ISPF's own column-restriction form (`FIND string c1 c2`) —
 * only text lying entirely within columns c1-c2 counts as a match. When
 * given, this bypasses Monaco's native findNextMatch/findPreviousMatch
 * (which have no concept of column limits) in favor of pulling every
 * raw match via findMatches and filtering/picking manually — see
 * `withinColumnRange`/`pickMatch`. With no column restriction the
 * original per-scope Monaco calls are used unchanged, to avoid any risk
 * of the manual wrap-around logic subtly behaving differently from
 * Monaco's own for the (by far more common) unrestricted case. */
async function runFind(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  needle: string,
  scope: FindScope,
  cols: ColumnRange = null
): Promise<Handled> {
  const colSuffix = cols ? ` in columns ${cols.start}-${cols.end}` : "";
  if (scope === "all") {
    let matches = model.findMatches(needle, true, false, false, null, false);
    if (cols) matches = matches.filter((m) => withinColumnRange(m.range, cols));
    if (matches.length === 0) return { message: `'${needle}' not found${colSuffix}`, isError: true };
    await revealAndUnexclude(editor, notifyExcludedLinesChanged, matches.map((m) => m.range.startLineNumber));
    editor.setSelection(matches[0].range);
    editor.revealRangeAtTop(matches[0].range);
    return { message: `${matches.length} occurrence(s) found${colSuffix}` };
  }

  let match: monacoNs.editor.FindMatch | null;
  if (cols) {
    const matches = model.findMatches(needle, true, false, false, null, false).filter((m) => withinColumnRange(m.range, cols));
    const cursorPos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = pickMatch(matches, scope, cursorPos);
  } else if (scope === "first") {
    match = model.findNextMatch(needle, { lineNumber: 1, column: 1 }, false, false, null, false);
  } else if (scope === "last") {
    const lastLine = model.getLineCount();
    match = model.findPreviousMatch(needle, { lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }, false, false, null, false);
  } else if (scope === "prev") {
    const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = model.findPreviousMatch(needle, pos, false, false, null, false);
  } else {
    const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = model.findNextMatch(needle, pos, false, false, null, false);
  }
  if (!match) return { message: `'${needle}' not found${colSuffix}`, isError: true };
  await revealAndUnexclude(editor, notifyExcludedLinesChanged, [match.range.startLineNumber]);
  editor.setSelection(match.range);
  // revealRangeAtTop (not revealRangeInCenter): matches ISPF's own FIND,
  // which always scrolls the found line to the top of the screen rather
  // than centering it.
  editor.revealRangeAtTop(match.range);
  return { message: scope === "next" ? `found '${needle}'${colSuffix}` : `found '${needle}' (${scope})${colSuffix}` };
}

/** `FIND`/`F` with no arguments at all, or the explicit `RFIND`/`RF`
 * command, repeat the last search in the same direction it last searched
 * — ISPF's real "repeat find" is PF5/RFIND; a bare FIND is this
 * project's own shortcut for the same thing, since there's no PF5 key to
 * bind in a text command bar. */
async function doFind(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  args: string[]
): Promise<Handled> {
  if (args.length === 0) {
    if (lastFindNeedle === null) return { message: "FIND requires a search string", isError: true };
    return runFind(editor, model, notifyExcludedLinesChanged, lastFindNeedle, lastFindDirection, lastFindColumnRange);
  }
  const { rest: afterScope, scope } = extractTrailingScope(args);
  const { rest, range: cols } = extractColumnRange(afterScope, 1);
  const needle = rest.join(" ");
  if (!needle) return { message: "FIND requires a search string", isError: true };
  lastFindNeedle = needle;
  lastFindColumnRange = cols;
  if (scope === "next" || scope === "prev") lastFindDirection = scope;
  return runFind(editor, model, notifyExcludedLinesChanged, needle, scope, cols);
}

/** `cols` is the same ISPF column-restriction form FIND supports
 * (`CHANGE old new c1 c2`) — see runFind's doc comment for why the
 * column-restricted path recomputes matches via findMatches/pickMatch
 * instead of Monaco's native findNextMatch/findPreviousMatch. */
function doChange(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  args: string[]
): Handled {
  if (args.length < 2) return { message: "CHANGE requires old and new text", isError: true };
  const { rest: afterScope, scope } = extractTrailingScope(args);
  const { rest, range: cols } = extractColumnRange(afterScope, 2);
  if (rest.length < 2) return { message: "CHANGE requires old and new text", isError: true };
  if (rest.length > 2) return { message: "CHANGE takes at most old text, new text, and a column range", isError: true };
  const [oldText, newText] = rest;
  const colSuffix = cols ? ` in columns ${cols.start}-${cols.end}` : "";
  if (scope === "all") {
    let matches = model.findMatches(oldText, true, false, false, null, false);
    if (cols) matches = matches.filter((m) => withinColumnRange(m.range, cols));
    if (matches.length === 0) return { message: `'${oldText}' not found${colSuffix}`, isError: true };
    editor.executeEdits(
      "ispf-primary-command",
      matches.map((m) => ({ range: m.range, text: newText }))
    );
    return { message: `${matches.length} occurrence(s) changed${colSuffix}` };
  }
  let match: monacoNs.editor.FindMatch | null;
  if (cols) {
    const matches = model.findMatches(oldText, true, false, false, null, false).filter((m) => withinColumnRange(m.range, cols));
    const cursorPos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = pickMatch(matches, scope, cursorPos);
  } else if (scope === "first") {
    match = model.findNextMatch(oldText, { lineNumber: 1, column: 1 }, false, false, null, false);
  } else if (scope === "last") {
    const lastLine = model.getLineCount();
    match = model.findPreviousMatch(oldText, { lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }, false, false, null, false);
  } else if (scope === "prev") {
    const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = model.findPreviousMatch(oldText, pos, false, false, null, false);
  } else {
    const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = model.findNextMatch(oldText, pos, false, false, null, false);
  }
  if (!match) return { message: `'${oldText}' not found${colSuffix}`, isError: true };
  editor.executeEdits("ispf-primary-command", [{ range: match.range, text: newText }]);
  return { message: scope === "next" ? `1 occurrence changed${colSuffix}` : `1 occurrence changed (${scope})${colSuffix}` };
}

/** SORT reorders every line in the file — a deliberate MVP
 * simplification vs. real ISPF, which sorts only the currently-displayed
 * (non-excluded) lines and leaves excluded ones fixed in place; this
 * project sorts the whole file regardless of exclusion state, which is
 * far simpler than interleaving hidden lines back into a sorted result.
 * Goes through `editor.executeEdits` (a plain document edit) rather than
 * the prefix-command backend, so it naturally flows through the same
 * "ordinary Monaco edit" path that already drops LABELs/excluded-lines
 * on any edit it can't remap (see ispfEditorProvider.ts) — appropriate
 * here, since a full-file sort makes old line-number-based state
 * meaningless anyway. `SORT` alone sorts whole lines ascending; `SORT
 * <start> <end>` sorts by the column range (1-indexed, inclusive)
 * instead; append `D` (descending) or `A` (ascending, the default) in
 * either form, in any position. */
function doSort(editor: monacoNs.editor.IStandaloneCodeEditor, model: monacoNs.editor.ITextModel, args: string[]): Handled {
  let descending = false;
  const colArgs: number[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "d") descending = true;
    else if (lower === "a") descending = false;
    else if (/^\d+$/.test(arg)) colArgs.push(Number(arg));
    else return { message: `SORT: unrecognized argument '${arg}'`, isError: true };
  }
  if (colArgs.length === 1) return { message: "SORT requires both a start and end column, e.g. SORT 10 20", isError: true };
  if (colArgs.length > 2) return { message: "SORT takes at most a start and end column", isError: true };
  const [colStart, colEnd] = colArgs;
  if (colArgs.length === 2 && (colStart < 1 || colEnd < colStart)) {
    return { message: `SORT: invalid column range ${colStart}-${colEnd}`, isError: true };
  }

  const totalLines = model.getLineCount();
  const contents: string[] = [];
  for (let i = 1; i <= totalLines; i++) contents.push(model.getLineContent(i));
  const key = (line: string) => (colArgs.length === 2 ? line.slice(colStart - 1, colEnd) : line);
  const order = contents.map((_, i) => i);
  order.sort((a, b) => {
    const ka = key(contents[a]);
    const kb = key(contents[b]);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return descending ? -cmp : cmp;
  });
  const sortedText = order.map((i) => contents[i]).join(model.getEOL());
  editor.executeEdits("ispf-primary-command", [{ range: model.getFullModelRange(), text: sortedText }]);
  return { message: `sorted ${totalLines} line(s)` };
}

/** EXCLUDE/X hides matching lines (or, with ALL, every line, or the range
 * between two LABELs) from view via Monaco's real folding machinery (see
 * excludeFolding.ts) — a pure view-level change, no document edit. Each
 * call REPLACES the hidden set (it doesn't accumulate across multiple
 * EXCLUDE commands, unlike the x/xx prefix commands, which DO accumulate
 * — see prefix_commands.py's module docstring) — a deliberate MVP
 * simplification. RESET/RES clears whatever is currently hidden,
 * regardless of whether EXCLUDE or x/xx put it there. */
async function doExclude(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  resolveLabel: LabelResolver,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  args: string[]
): Promise<Handled> {
  if (args.length === 0) return { message: "EXCLUDE requires a search string, ALL, or two labels", isError: true };
  const all = args.length === 1 && args[0].toLowerCase() === "all";
  const totalLines = model.getLineCount();
  let ranges: monacoNs.languages.FoldingRange[];
  if (all) {
    ranges = [{ start: 1, end: totalLines }];
  } else if (args.length === 2 && isLabelToken(args[0]) && isLabelToken(args[1])) {
    const from = resolveLabel(args[0]);
    const to = resolveLabel(args[1]);
    if (from === undefined) return { message: `label '${args[0]}' not found`, isError: true };
    if (to === undefined) return { message: `label '${args[1]}' not found`, isError: true };
    ranges = [{ start: Math.min(from, to), end: Math.max(from, to) }];
  } else {
    const needle = args.join(" ").toLowerCase();
    ranges = [];
    let rangeStart: number | null = null;
    for (let line = 1; line <= totalLines; line++) {
      const isMatch = model.getLineContent(line).toLowerCase().includes(needle);
      if (isMatch && rangeStart === null) rangeStart = line;
      if (!isMatch && rangeStart !== null) {
        ranges.push({ start: rangeStart, end: line - 1 });
        rangeStart = null;
      }
    }
    if (rangeStart !== null) ranges.push({ start: rangeStart, end: totalLines });
    if (ranges.length === 0) return { message: `'${needle}' not found`, isError: true };
  }
  await setExcludedRanges(editor, ranges);
  notifyExcludedLinesChanged(rangesToLines(ranges));
  const hiddenLineCount = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  return { message: `${hiddenLineCount} line(s) excluded` };
}

/** Executes one ISPF-style primary command (as opposed to a line/prefix
 * command, which goes through the gutter instead). */
export async function executePrimaryCommand(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  raw: string,
  resolveLabel: LabelResolver,
  notifyExcludedLinesChanged: ExcludedLinesNotifier
): Promise<CommandOutcome> {
  const text = raw.trim();
  if (!text) return { kind: "handled", message: "" };
  const parts = splitArgs(text);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1);

  switch (cmd) {
    case "undo":
      return rest[0]?.toLowerCase() === "all" ? { kind: "forward", action: "undoAll" } : { kind: "forward", action: "undo" };
    case "cancel":
    case "can":
      return { kind: "forward", action: "cancel" };
    case "save":
      return { kind: "forward", action: "save" };
    case "end":
    case "pf3":
      return { kind: "forward", action: "end" };
  }

  const model = editor.getModel();
  if (!model) return { kind: "handled", message: "no document", isError: true };

  switch (cmd) {
    case "top":
    case "t":
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.revealLine(1);
      return { kind: "handled", message: "top of data" };
    case "bottom":
    case "bot": {
      const last = model.getLineCount();
      editor.setPosition({ lineNumber: last, column: 1 });
      editor.revealLine(last);
      return { kind: "handled", message: "bottom of data" };
    }
    case "locate":
    case "loc":
    case "l":
      if (rest[0] === undefined) {
        return { kind: "handled", message: "LOCATE requires a label or a line number, e.g. LOCATE .A or LOCATE 50", isError: true };
      }
      return { kind: "handled", ...(await doLocate(editor, model, resolveLabel, notifyExcludedLinesChanged, rest[0])) };
    case "find":
    case "f":
      return { kind: "handled", ...(await doFind(editor, model, notifyExcludedLinesChanged, rest)) };
    case "rfind":
    case "rf":
      // Always repeats — an operand here would be ambiguous (ISPF's own
      // RFIND takes none either), so any trailing args are ignored.
      return { kind: "handled", ...(await doFind(editor, model, notifyExcludedLinesChanged, [])) };
    case "change":
    case "c":
      return { kind: "handled", ...doChange(editor, model, rest) };
    case "sort":
      return { kind: "handled", ...doSort(editor, model, rest) };
    case "cut":
      // Resolves whatever c/cc/m/mm mark is currently pending in the
      // extension host (see ispfEditorProvider.ts) — no operand needed
      // or accepted, matching real ISPF's own CUT.
      return { kind: "forward", action: "cut" };
    case "paste": {
      // Inserts the clipboard at the CURSOR's current line — this
      // webview has no concept of "the selected line" beyond that, so
      // unlike the old prefix `paste` word (removed) there's no way to
      // target an arbitrary line without moving the cursor there first
      // (e.g. via LOCATE). Optional trailing A (after, default) or B
      // (before) picks the direction, same letters as the a/b prefix
      // destination markers.
      const pos = editor.getPosition();
      if (!pos) return { kind: "handled", message: "no cursor position to paste at", isError: true };
      const arg = rest[0]?.toLowerCase();
      if (arg !== undefined && arg !== "a" && arg !== "b") {
        return { kind: "handled", message: "PASTE takes an optional A (after, default) or B (before)", isError: true };
      }
      return { kind: "forward", action: "paste", line: pos.lineNumber, before: arg === "b" };
    }
    case "exclude":
    case "x":
      return { kind: "handled", ...(await doExclude(editor, model, resolveLabel, notifyExcludedLinesChanged, rest)) };
    case "reset":
    case "res": {
      const arg = rest[0]?.toLowerCase();
      if (arg === "lab" || arg === "labels") {
        // Labels are extension-host-owned state (see ispfEditorProvider.ts)
        // — clearing them isn't something this webview can do on its own,
        // unlike RESET's default (plain-line-command/EXCLUDE) behavior
        // below, which only ever touches this editor's own folding state.
        return { kind: "forward", action: "resetLabels" };
      }
      await setExcludedRanges(editor, []);
      notifyExcludedLinesChanged([]);
      return { kind: "handled", message: "all lines displayed" };
    }
    default:
      return { kind: "handled", message: `unknown primary command '${parts[0]}'`, isError: true };
  }
}
