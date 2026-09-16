import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// The minimal editor.api core deliberately skips default CONTRIBUTIONS
// (to avoid pulling in worker-dependent rich language services), but that
// also skipped folding — which has no worker dependency and is what
// EXCLUDE/RESET need (the editor.fold/editor.unfoldAll actions and the
// FoldingController that actually consumes registered FoldingRangeProviders
// both live here; neither exists without this import).
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import { registerPliLanguage } from "./pliLanguage";
import { PrefixGutter, PrefixCommand, HexToggle } from "./gutter";
import { executePrimaryCommand } from "./primaryCommand";
import { ensureExcludeFoldingProviderRegistered, linesToRanges, setExcludedRanges } from "./excludeFolding";
import { HexView } from "./hexView";
import { ColsView } from "./colsView";
import "./gutter.css";
import "./commandBar.css";
import "./hexView.css";
import "./colsView.css";

const vscodeApi = acquireVsCodeApi();

registerPliLanguage(monaco);
ensureExcludeFoldingProviderRegistered();

const root = document.getElementById("ispf-root")!;
root.style.display = "flex";
root.style.flexDirection = "column";
root.style.height = "100%";

// ISPF-style primary command line ("COMMAND ===>") for FIND/CHANGE/TOP/
// BOTTOM, as opposed to the per-line prefix commands typed into the
// gutter below. Implemented purely against Monaco's own model/editor
// APIs — no round trip to the extension host or backend needed.
const commandBar = document.createElement("div");
commandBar.className = "ispf-command-bar";
const commandLabel = document.createElement("span");
commandLabel.className = "ispf-command-label";
commandLabel.textContent = "COMMAND ===>";
const commandInput = document.createElement("input");
commandInput.className = "ispf-command-input";
commandInput.autocomplete = "off";
commandInput.spellcheck = false;
commandInput.disabled = true;
commandInput.placeholder = "find/f [word] [c1 c2] [first|last|prev|all], rfind/rf, change/c [word] [c1 c2] [scope], sort [c1 c2] [a|d], cut, paste [a|b], top, bottom, locate/loc/l .label|line, exclude/x, reset/res [lab], undo, save, cancel/can, end/pf3, help/h";
const commandMessage = document.createElement("span");
commandMessage.className = "ispf-command-message";
commandBar.appendChild(commandLabel);
commandBar.appendChild(commandInput);
commandBar.appendChild(commandMessage);
root.appendChild(commandBar);

// position: relative (not flex) — editorHost and the gutter (added by
// PrefixGutter) are both absolutely positioned within this box below.
// Flexbox content-sizing depends on DOM order/timing (the gutter is
// inserted after Monaco already exists), which raced with Monaco's own
// initial layout measurement; explicit left/right/width values are
// correct from the very first layout pass regardless of insertion order.
const editorRow = document.createElement("div");
editorRow.style.position = "relative";
editorRow.style.flex = "1";
editorRow.style.minHeight = "0";
root.appendChild(editorRow);

const GUTTER_WIDTH = 60;
const editorHost = document.createElement("div");
editorHost.style.position = "absolute";
editorHost.style.top = "0";
editorHost.style.bottom = "0";
editorHost.style.left = `${GUTTER_WIDTH}px`;
editorHost.style.right = "0";
editorRow.appendChild(editorHost);

function detectLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pli") || lower.endsWith(".pl1")) return "pli";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.some((ext) => lower.endsWith(ext))) return lang.id;
  }
  return "plaintext";
}

let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let gutter: PrefixGutter | undefined;
let hexView: HexView | undefined;
let colsView: ColsView | undefined;
let applyingRemoteChange = false;

/** Focuses and selects the COMMAND ===> input, so whatever's typed next
 * replaces it outright — matches how a 3270/ISPF command line behaves
 * when you jump to it (HOME, or an empty one waiting for input). */
function jumpToCommandBar(): void {
  commandInput.focus();
  commandInput.select();
}

function boot(text: string, fileName: string): void {
  const language = detectLanguage(fileName);
  const model = monaco.editor.createModel(text, language);
  editor = monaco.editor.create(editorHost, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    // Our own prefix gutter replaces Monaco's line-number column — having
    // both on screen at once made it unclear which narrow strip was
    // actually the editable one.
    lineNumbers: "off",
  });

  editor.onDidChangeModelContent((e) => {
    if (applyingRemoteChange) return;
    const changes = e.changes
      .slice()
      .sort((a, b) => a.rangeOffset - b.rangeOffset)
      .map((c) => ({
        startLine: c.range.startLineNumber,
        startColumn: c.range.startColumn,
        endLine: c.range.endLineNumber,
        endColumn: c.range.endColumn,
        text: c.text,
      }));
    vscodeApi.postMessage({ type: "edit", changes });
  });

  // ISPF/3270 convention: HOME jumps straight to the command line, the
  // first input field on the screen. Only intercepted when it wouldn't
  // otherwise do anything (cursor already at {1,1}, no modifier held) —
  // Monaco's own Home (line-start / smart-home) is far too useful during
  // normal editing to override everywhere the cursor happens to be.
  editor.onKeyDown((e) => {
    if (e.keyCode !== monaco.KeyCode.Home || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const pos = editor?.getPosition();
    if (pos && pos.lineNumber === 1 && pos.column === 1) {
      e.preventDefault();
      e.stopPropagation();
      jumpToCommandBar();
    }
  });

  hexView = new HexView(editor, monaco);
  const hexViewForCallback = hexView;
  colsView = new ColsView(editor, monaco);
  const colsViewForCallback = colsView;
  gutter = new PrefixGutter(editor, monaco, editorRow, {
    width: GUTTER_WIDTH,
    onCommit: (commands: PrefixCommand[]) => {
      vscodeApi.postMessage({ type: "processPrefixCommands", commands });
    },
    onHexToggle: (toggles: HexToggle[]) => {
      for (const { line, count } of toggles) {
        if (count > 1) {
          for (let l = line; l < line + count; l++) hexViewForCallback.show(l);
        } else {
          hexViewForCallback.toggle(line);
        }
      }
    },
    onColsToggle: (lines: number[]) => {
      for (const line of lines) colsViewForCallback.toggle(line);
    },
    // Home in a gutter cell always jumps — unlike the main editor, a
    // gutter cell's own "move caret to start of typed text" behavior has
    // negligible value for a 1-9 character prefix command.
    onJumpToCommandBar: jumpToCommandBar,
  });

  // automaticLayout's ResizeObserver reacts to editorHost's size changing,
  // but inserting the gutter as editorHost's new sibling (above) doesn't
  // itself force the browser to recompute layout before this point — so
  // without an explicit layout() here, Monaco can keep rendering (and
  // hit-testing) at the FULL editorRow width for a while, spatially
  // covering the gutter and swallowing its clicks/keystrokes. Calling
  // layout() with no args makes Monaco read the container's current
  // (now correctly narrowed) width immediately, which itself forces the
  // browser to flush the pending reflow synchronously.
  editor.layout();

  commandInput.disabled = false;
}

commandInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !editor) return;
  e.preventDefault();
  const currentEditor = editor;
  const rawCommand = commandInput.value;
  commandInput.value = "";
  const resolveLabel = (token: string) => gutter?.resolveLabel(token);
  const notifyExcludedLinesChanged = (lines: number[]) => {
    vscodeApi.postMessage({ type: "excludedLinesChanged", lines });
  };
  // RESET/RES clears any shown HX/COLS rulers too (see primaryCommand.ts's
  // ViewZoneClearer doc comment) — neither has a document edit of its own
  // to otherwise trigger this cleanup.
  const clearViewZones = () => {
    hexView?.hideAll();
    colsView?.hideAll();
  };
  void executePrimaryCommand(currentEditor, rawCommand, resolveLabel, notifyExcludedLinesChanged, clearViewZones).then((outcome) => {
    if (outcome.kind === "forward") {
      // Spread everything but `kind` — PASTE's outcome carries extra
      // `line`/`before` fields the extension host needs; every other
      // forwarded action is just `{action}`.
      const { kind: _kind, ...payload } = outcome;
      vscodeApi.postMessage({ type: "primaryAction", ...payload });
      commandMessage.textContent = "";
      commandMessage.classList.remove("ispf-command-error");
      return;
    }
    commandMessage.textContent = outcome.message;
    commandMessage.classList.toggle("ispf-command-error", !!outcome.isError);
  });
});

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      boot(message.text, message.fileName ?? window.__ISPF_FILE_NAME__ ?? "");
      break;
    case "setContent": {
      if (!editor) return;
      const model = editor.getModel();
      if (model && model.getValue() !== message.text) {
        // Every prefix-command batch (and a genuine external change) comes
        // back as a full-document replace (see ispfEditorProvider.ts), and
        // Monaco's model.setValue() resets the cursor to {1,1} and scrolls
        // to the top as a side effect — jarring after e.g. a `)`/`>` shift
        // typed deep in a large file. saveViewState/restoreViewState around
        // it keeps the cursor/scroll where the user actually was: view
        // state is line/column-based, so it still lands correctly even
        // when the edit changed the line count (Monaco clamps it to the
        // new document's bounds if a line disappeared).
        const viewState = editor.saveViewState();
        applyingRemoteChange = true;
        model.setValue(message.text);
        applyingRemoteChange = false;
        if (viewState) editor.restoreViewState(viewState);
      }
      gutter?.setLabels(message.labels ?? {});
      void setExcludedRanges(editor, linesToRanges(message.excludedLines ?? []));
      break;
    }
    case "setLabels":
      gutter?.setLabels(message.labels ?? {});
      // excludedLines is only present here when it actually changed (the
      // RESET LAB path omits it, leaving folding untouched) — applying it
      // unconditionally would re-fold the SAME lines on every label-only
      // push and cause a needless fold/unfold flicker.
      if (editor && message.excludedLines !== undefined) {
        void setExcludedRanges(editor, linesToRanges(message.excludedLines));
      }
      break;
    case "prefixResult": {
      if (!gutter) return;
      if (message.errors && message.errors.length > 0) {
        gutter.setErrors(message.errors);
      } else {
        gutter.clearLines(message.consumedLines ?? []);
        gutter.setLabels(message.labels ?? {});
        if (editor) void setExcludedRanges(editor, linesToRanges(message.excludedLines ?? []));
      }
      break;
    }
    case "primaryActionResult":
      commandMessage.textContent = message.message ?? "";
      commandMessage.classList.toggle("ispf-command-error", !!message.isError);
      break;
    case "setCursor":
      // Sent after a macro run (see ispfEditorProvider.ts's
      // handleMacroAction) — arrives AFTER the "setContent" the
      // resulting document edit already triggered, whose own
      // saveViewState/restoreViewState above would otherwise put the
      // cursor back where it was rather than where the macro moved it.
      if (editor && typeof message.line === "number") {
        editor.setPosition({ lineNumber: message.line, column: 1 });
        editor.revealLine(message.line);
      }
      break;
  }
});

vscodeApi.postMessage({ type: "ready" });
