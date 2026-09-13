import type * as monacoNs from "monaco-editor/esm/vs/editor/editor.api";

export interface PrefixCommand {
  line: number;
  code: string;
}

export interface PrefixErrorMsg {
  line: number;
  message: string;
}

export interface HexToggle {
  line: number;
  count: number;
}

interface GutterOptions {
  width: number;
  onCommit: (commands: PrefixCommand[]) => void;
  // `hx`/`hx[n]` never reach the backend — see commit()'s interception
  // and hexView.ts's class doc comment for why. `count` is only ever >1
  // for the counted form (`hx3`); the caller treats that as "show" for
  // each of the n lines, and a bare `hx` (count 1) as "toggle".
  onHexToggle: (toggles: HexToggle[]) => void;
  // `cols` never reaches the backend either (see commit()'s interception
  // and colsView.ts's class doc comment) — unlike `hx` it has no counted
  // form (real ISPF's COLS line command takes no operand), so this is
  // just the list of lines to toggle the ruler under.
  onColsToggle: (lines: number[]) => void;
  // HOME in a gutter cell jumps to the COMMAND ===> bar (see main.ts's
  // jumpToCommandBar) — ISPF/3270's "Home goes to the first input field"
  // convention. Unconditional (no "already at start of this cell" guard
  // the way the main editor's Home interception has one): a gutter
  // cell's own "move caret to position 0" behavior is negligible for a
  // 1-9 character prefix command.
  onJumpToCommandBar: () => void;
}

// Intercepted in commit() below, before a batch would otherwise be sent
// to the backend as a set of (mostly unknown-command) prefix commands.
const HEX_CODE_RE = /^hx(\d*)$/i;
const COLS_CODE_RE = /^cols$/i;

/**
 * A viewport-synced, editable prefix-command column drawn as a plain DOM
 * overlay to the left of Monaco, since Monaco has no built-in widget type
 * that supports "one persistent editable input per visible line, outside
 * the horizontally-scrolling content area": content widgets scroll with
 * the text, overlay widgets aren't per-line, and the glyph margin isn't
 * editable. Inputs are pooled to the visible-line window (+ a small
 * buffer) and recycled on scroll rather than one per document line, so
 * this stays cheap on large files. Typed-but-uncommitted values live in
 * `pendingValues`, independent of which lines currently have a DOM node,
 * so scrolling a cell out of view and back never loses what was typed.
 */
export class PrefixGutter {
  private readonly container: HTMLDivElement;
  private readonly inputs = new Map<number, HTMLInputElement>();
  private readonly pendingValues = new Map<number, string>();
  private readonly errorLines = new Map<number, string>();
  // LABEL (.name) state, kept in both directions for O(1) lookups: the
  // gutter cell needs line->name to render, and LOCATE/EXCLUDE-by-label in
  // the primary command bar (see resolveLabel) need name->line. This is
  // purely a display cache — the extension host owns the authoritative
  // map (see ispfEditorProvider.ts) and pushes the full map down on every
  // change via setLabels(), so it's always replaced wholesale, never
  // patched incrementally.
  private readonly lineToLabel = new Map<number, string>();
  private readonly labelToLine = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly editor: monacoNs.editor.IStandaloneCodeEditor,
    private readonly monaco: typeof monacoNs,
    host: HTMLElement,
    private readonly options: GutterOptions
  ) {
    this.container = document.createElement("div");
    this.container.className = "ispf-gutter";
    this.container.style.width = `${options.width}px`;
    // insertBefore (not appendChild): the gutter must render to the LEFT
    // of the editor host regardless of DOM append order — it's created
    // here, later than editorHost, so a plain appendChild would put it
    // after (i.e. visually to the right of) the editor.
    host.insertBefore(this.container, host.firstChild);
    console.log("[ISPF gutter] constructed, host children:", host.children.length, "container rect:", JSON.stringify(this.container.getBoundingClientRect()));

    editor.onDidScrollChange(() => this.layout());
    editor.onDidLayoutChange(() => this.layout());
    editor.onDidChangeModelContent(() => this.layout());
    this.layout();
  }

  /** Marks lines with an unresolved error; the offending cells stay
   * populated (so the user can fix and re-submit) but get a visible
   * outline + tooltip, matching ISPF's "leave the bad command in place
   * with a message" behavior instead of silently discarding it. */
  setErrors(errors: PrefixErrorMsg[]): void {
    this.errorLines.clear();
    for (const e of errors) this.errorLines.set(e.line, e.message);
    this.layout();
  }

  /** Called after a successful backend apply: clears the gutter cells
   * that were consumed by that batch. Label cells among them get their
   * typed ".name" text cleared here too (it's been "consumed" the same as
   * any other command), but reappear via `setLabels` immediately after,
   * since the label itself is now committed, persistent state rather than
   * a pending typed value. */
  clearLines(lines: number[]): void {
    for (const line of lines) {
      this.pendingValues.delete(line);
      this.errorLines.delete(line);
    }
    this.layout();
  }

  /** Replaces the whole committed LABEL map (name -> line), as returned by
   * the backend after a batch, or reset to {} on an external document
   * change. Labels aren't "pending" values a user is mid-typing — they're
   * persistent, so they're rendered independently of `pendingValues` and
   * survive scrolling/recycling the same way `errorLines` does. */
  setLabels(labels: Record<string, number>): void {
    this.lineToLabel.clear();
    this.labelToLine.clear();
    for (const [name, line] of Object.entries(labels)) {
      this.lineToLabel.set(line, name);
      this.labelToLine.set(name, line);
    }
    this.layout();
  }

  /** Resolves a label token (with or without its leading '.', e.g. "A",
   * ".A", ".ZFIRST") to a line number, for the primary command bar's
   * LOCATE and label-range EXCLUDE. ZFIRST/ZLAST/ZCSR are reserved system
   * labels the backend never stores (see prefix_commands.py) — always the
   * first/last line and the current cursor line respectively. */
  resolveLabel(token: string): number | undefined {
    const name = token.replace(/^\./, "").toUpperCase();
    if (!name) return undefined;
    const model = this.editor.getModel();
    if (name === "ZFIRST") return model ? 1 : undefined;
    if (name === "ZLAST") return model?.getLineCount();
    if (name === "ZCSR") return this.editor.getPosition()?.lineNumber;
    return this.labelToLine.get(name);
  }

  dispose(): void {
    this.disposed = true;
    this.container.remove();
  }

  private layout(): void {
    if (this.disposed) return;
    const model = this.editor.getModel();
    if (!model) return;
    const lineHeight = this.editor.getOption(this.monaco.editor.EditorOption.lineHeight);
    const totalLines = model.getLineCount();
    const visible = this.editor.getVisibleRanges();
    const buffer = 5;
    // getVisibleRanges() can come back empty on the very first call, before
    // Monaco has finished its initial render pass — falling back to "the
    // top of the file" instead of bailing out means the gutter is never
    // left permanently empty if a later re-layout doesn't happen to fire.
    const first = visible.length > 0 ? Math.max(1, visible[0].startLineNumber - buffer) : 1;
    const last = visible.length > 0 ? Math.min(totalLines, visible[visible.length - 1].endLineNumber + buffer) : Math.min(totalLines, 50);
    console.log(
      "[ISPF gutter] layout():",
      "visibleRanges=", visible.length,
      "first=", first, "last=", last, "lineHeight=", lineHeight,
      "containerRect=", JSON.stringify(this.container.getBoundingClientRect())
    );

    for (const [line, input] of this.inputs) {
      if (line < first || line > last) {
        input.remove();
        this.inputs.delete(line);
      }
    }

    for (let line = first; line <= last; line++) {
      let input = this.inputs.get(line);
      if (!input) {
        input = this.createInput(line);
        this.inputs.set(line, input);
        this.container.appendChild(input);
      }
      const top = this.editor.getTopForLineNumber(line) - this.editor.getScrollTop();
      input.style.transform = `translateY(${top}px)`;
      input.style.height = `${lineHeight}px`;
      input.style.lineHeight = `${lineHeight}px`;
      const message = this.errorLines.get(line);
      input.classList.toggle("ispf-gutter-cell-error", message !== undefined);
      input.title = message ?? "";
      // A committed label only shows once nothing is pending-typed over it
      // (mid-edit, the user's own keystrokes must win) — this also means
      // it reappears automatically the moment an edit is cleared back out.
      const committedLabel = this.lineToLabel.get(line);
      input.classList.toggle("ispf-gutter-cell-label", committedLabel !== undefined && !this.pendingValues.has(line));
      if (!this.pendingValues.has(line)) {
        input.value = committedLabel !== undefined ? `.${committedLabel}` : "";
      }
      if (line === first) {
        console.log(`[ISPF gutter] cell for line ${line} rect=`, JSON.stringify(input.getBoundingClientRect()), "top=", top);
      }
    }
  }

  private createInput(line: number): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "ispf-gutter-cell";
    input.maxLength = 9; // e.g. ".ABCDEFGH" — a label is '.' + up to 8 chars
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = String(line);
    input.value = this.pendingValues.get(line) ?? "";
    input.addEventListener("mousedown", () => console.log(`[ISPF gutter] mousedown on line ${line} cell`));
    input.addEventListener("focus", () => console.log(`[ISPF gutter] focus on line ${line} cell`));
    input.addEventListener("input", () => {
      const value = input.value;
      if (value) this.pendingValues.set(line, value);
      else this.pendingValues.delete(line);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commit();
      } else if (e.key === "Home") {
        e.preventDefault();
        this.options.onJumpToCommandBar();
      }
    });
    return input;
  }

  private commit(): void {
    const commands: PrefixCommand[] = [];
    const hexToggles: HexToggle[] = [];
    const colsLines: number[] = [];
    const localLines: number[] = [];
    for (const [line, code] of this.pendingValues) {
      const trimmed = code.trim();
      if (!trimmed) continue;
      const hexMatch = HEX_CODE_RE.exec(trimmed);
      if (hexMatch) {
        hexToggles.push({ line, count: hexMatch[1] ? parseInt(hexMatch[1], 10) : 1 });
        localLines.push(line);
        continue;
      }
      if (COLS_CODE_RE.test(trimmed)) {
        colsLines.push(line);
        localLines.push(line);
        continue;
      }
      commands.push({ line, code: trimmed });
    }
    // hx/cols are consumed locally right away (see HexView/ColsView) —
    // neither goes through the backend, so there's no "consumedLines"
    // round trip to wait for before clearing their cells.
    if (localLines.length > 0) this.clearLines(localLines);
    if (hexToggles.length > 0) this.options.onHexToggle(hexToggles);
    if (colsLines.length > 0) this.options.onColsToggle(colsLines);
    if (commands.length === 0) return;
    this.options.onCommit(commands);
  }
}
