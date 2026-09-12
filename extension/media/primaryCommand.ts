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
 * them means the host, not just this webview's Monaco model. Everything
 * else (FIND/RFIND/CHANGE/TOP/BOTTOM/LOCATE/EXCLUDE/RESET) is resolved
 * entirely against Monaco's own model here. */
export type CommandOutcome =
  | ({ kind: "handled" } & Handled)
  | { kind: "forward"; action: "undo" | "undoAll" | "cancel" | "save" | "end" | "resetLabels" };

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

async function doLocate(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  resolveLabel: LabelResolver,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  token: string
): Promise<Handled> {
  const line = resolveLabel(token);
  if (line === undefined) return { message: `label '${token}' not found`, isError: true };
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

type FindScope = "next" | "first" | "last" | "all";

/** Remembers the most recent FIND's search string, module-scoped like
 * excludeFolding.ts's `currentRanges` (one JS module instance per
 * webview, so this is naturally per-editor-session state) — backs both
 * a bare `FIND`/`F` with no arguments and the explicit `RFIND`/`RF`
 * command, ISPF's real PF5 "repeat find" equivalent. Set whenever a
 * non-empty needle is parsed, whether or not that search actually found
 * anything, so retrying after e.g. an edit still repeats the same text. */
let lastFindNeedle: string | null = null;

/** Splits a trailing FIRST/LAST/NEXT/ALL scope keyword off FIND's
 * argument list, the same way CHANGE already splits off a trailing ALL
 * (see doChange) — requiring at least one token before it so a literal
 * one-word search for e.g. "first" isn't misread as the scope keyword. */
function extractFindScope(args: string[]): { needle: string; scope: FindScope } {
  let rest = args;
  let scope: FindScope = "next";
  if (rest.length > 1) {
    const last = rest[rest.length - 1].toLowerCase();
    if (last === "all" || last === "first" || last === "last" || last === "next") {
      scope = last;
      rest = rest.slice(0, -1);
    }
  }
  return { needle: rest.join(" "), scope };
}

/** FIND ALL needs to actually show every hit, not just report a count —
 * including ones sitting inside an EXCLUDEd/x'd region, which would
 * otherwise stay collapsed and invisible even after "found". FIRST/LAST
 * search from the very top/bottom of the file regardless of the cursor;
 * NEXT (the default, also what a bare FIND/RFIND repeats) searches
 * forward from the cursor and wraps, as before. */
async function runFind(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  needle: string,
  scope: FindScope
): Promise<Handled> {
  if (scope === "all") {
    const matches = model.findMatches(needle, true, false, false, null, false);
    if (matches.length === 0) return { message: `'${needle}' not found`, isError: true };
    await revealAndUnexclude(editor, notifyExcludedLinesChanged, matches.map((m) => m.range.startLineNumber));
    editor.setSelection(matches[0].range);
    editor.revealRangeAtTop(matches[0].range);
    return { message: `${matches.length} occurrence(s) found` };
  }

  let match: monacoNs.editor.FindMatch | null;
  if (scope === "first") {
    match = model.findNextMatch(needle, { lineNumber: 1, column: 1 }, false, false, null, false);
  } else if (scope === "last") {
    const lastLine = model.getLineCount();
    match = model.findPreviousMatch(needle, { lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }, false, false, null, false);
  } else {
    const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    match = model.findNextMatch(needle, pos, false, false, null, false);
  }
  if (!match) return { message: `'${needle}' not found`, isError: true };
  await revealAndUnexclude(editor, notifyExcludedLinesChanged, [match.range.startLineNumber]);
  editor.setSelection(match.range);
  // revealRangeAtTop (not revealRangeInCenter): matches ISPF's own FIND,
  // which always scrolls the found line to the top of the screen rather
  // than centering it.
  editor.revealRangeAtTop(match.range);
  return { message: scope === "next" ? `found '${needle}'` : `found '${needle}' (${scope})` };
}

/** `FIND`/`F` with no arguments at all, or the explicit `RFIND`/`RF`
 * command, repeat the last search — ISPF's real "repeat find" is PF5/
 * RFIND; a bare FIND is this project's own shortcut for the same thing,
 * since there's no PF5 key to bind in a text command bar. */
async function doFind(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  model: monacoNs.editor.ITextModel,
  notifyExcludedLinesChanged: ExcludedLinesNotifier,
  args: string[]
): Promise<Handled> {
  if (args.length === 0) {
    if (lastFindNeedle === null) return { message: "FIND requires a search string", isError: true };
    return runFind(editor, model, notifyExcludedLinesChanged, lastFindNeedle, "next");
  }
  const { needle, scope } = extractFindScope(args);
  if (!needle) return { message: "FIND requires a search string", isError: true };
  lastFindNeedle = needle;
  return runFind(editor, model, notifyExcludedLinesChanged, needle, scope);
}

function doChange(editor: monacoNs.editor.IStandaloneCodeEditor, model: monacoNs.editor.ITextModel, args: string[]): Handled {
  if (args.length < 2) return { message: "CHANGE requires old and new text", isError: true };
  let rest = args;
  let all = false;
  if (rest[rest.length - 1]?.toLowerCase() === "all") {
    all = true;
    rest = rest.slice(0, -1);
  }
  const [oldText, newText] = rest;
  if (all) {
    const matches = model.findMatches(oldText, true, false, false, null, false);
    if (matches.length === 0) return { message: `'${oldText}' not found`, isError: true };
    editor.executeEdits(
      "ispf-primary-command",
      matches.map((m) => ({ range: m.range, text: newText }))
    );
    return { message: `${matches.length} occurrence(s) changed` };
  }
  const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
  const match = model.findNextMatch(oldText, pos, false, false, null, false);
  if (!match) return { message: `'${oldText}' not found`, isError: true };
  editor.executeEdits("ispf-primary-command", [{ range: match.range, text: newText }]);
  return { message: "1 occurrence changed" };
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
      if (!isLabelToken(rest[0])) return { kind: "handled", message: "LOCATE requires a label, e.g. LOCATE .A", isError: true };
      return { kind: "handled", ...(await doLocate(editor, resolveLabel, notifyExcludedLinesChanged, rest[0])) };
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
