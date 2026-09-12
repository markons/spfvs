import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

/**
 * EXCLUDE/RESET need to visually collapse (hide) line ranges. Monaco's
 * standalone editor DOES have a lower-level `setHiddenAreas` method used
 * internally by both the folding feature and the diff editor's "hide
 * unchanged regions" feature, but it isn't part of the public
 * IStandaloneCodeEditor API — calling it directly (an earlier version of
 * this file did) updates internal state without going through the
 * folding controller's own coordinated bookkeeping, and produced no
 * visible effect. This version instead drives Monaco's real, public
 * folding machinery: a FoldingRangeProvider supplies the ranges we want
 * hidden, and `editor.fold`/`editor.unfoldAll` (public trigger commands,
 * the same ones bound to the fold gutter icons and keybindings) collapse
 * or restore them.
 */

let currentRanges: monaco.languages.FoldingRange[] = [];
// Typed `any`: FoldingRangeProvider.onDidChange wants IEvent<this> (the
// provider instance as payload), but nothing here actually reads the
// fired value — only that a change happened.
const changeEmitter = new monaco.Emitter<any>();
let registered = false;

export function ensureExcludeFoldingProviderRegistered(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerFoldingRangeProvider("*", {
    onDidChange: changeEmitter.event,
    provideFoldingRanges: () => currentRanges.map((r) => ({ start: r.start, end: r.end })),
  });
}

function waitForFoldingModelRefresh(): Promise<void> {
  // The folding controller re-queries providers reactively off
  // onDidChange, not synchronously — give it a couple of animation
  // frames to settle before asking it to fold the new ranges.
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function setExcludedRanges(editor: monaco.editor.IStandaloneCodeEditor, ranges: monaco.languages.FoldingRange[]): Promise<void> {
  currentRanges = ranges;
  changeEmitter.fire(undefined);
  await waitForFoldingModelRefresh();
  if (ranges.length === 0) {
    editor.trigger("ispf", "editor.unfoldAll", {});
  } else {
    // editor.fold's selectionLines argument is 0-based; FoldingRange.start is 1-based.
    editor.trigger("ispf", "editor.fold", { selectionLines: ranges.map((r) => r.start - 1) });
  }
}

/** The webview's own current record of which lines are hidden (mirrors
 * `currentRanges`, flattened) — used by FIND/LOCATE to tell whether a hit
 * or target line needs to be un-excluded to actually become visible
 * (see primaryCommand.ts's `revealAndUnexclude`). */
export function getExcludedLines(): number[] {
  return rangesToLines(currentRanges);
}

/** Flattens ranges to individual line numbers — used to report the
 * primary EXCLUDE command's newly-hidden lines back to the extension
 * host (see main.ts's `notifyExcludedLinesChanged`), which needs a flat
 * line set to remap through future prefix-command batches the same way
 * it remaps LABELs. */
export function rangesToLines(ranges: monaco.languages.FoldingRange[]): number[] {
  const lines: number[] = [];
  for (const r of ranges) {
    for (let line = r.start; line <= r.end; line++) lines.push(line);
  }
  return lines;
}

/** Inverse of rangesToLines: coalesces a flat, unsorted line set (as
 * carried in the backend/extension-host EXCLUDE state) into the minimal
 * set of contiguous FoldingRanges setExcludedRanges wants. */
export function linesToRanges(lines: number[]): monaco.languages.FoldingRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: monaco.languages.FoldingRange[] = [];
  let start: number | null = null;
  let prev = -Infinity;
  for (const line of sorted) {
    if (start === null) {
      start = line;
    } else if (line !== prev + 1) {
      ranges.push({ start, end: prev });
      start = line;
    }
    prev = line;
  }
  if (start !== null) ranges.push({ start, end: prev });
  return ranges;
}
