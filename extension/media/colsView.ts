import type * as monacoNs from "monaco-editor/esm/vs/editor/editor.api";

/**
 * The `cols` prefix (line) command shows an ISPF-style column ruler
 * directly beneath a line — a pure VIEW effect via Monaco's view-zone
 * API, the same category of trick hexView.ts uses for `hx` (space
 * reserved in the rendered view, never in the document model). Real
 * ISPF's ruler ("====COLS>") has no operand/count form, so unlike `hx`
 * there is no `cols3` — see gutter.ts's `commit()`, which intercepts
 * bare `cols` before it would otherwise be sent to the backend as an
 * unknown command.
 *
 * Same simplifications as HexView, for the same reasons (see its class
 * doc comment): never persisted/remapped through prefix-command batches
 * or backend state, and ANY document edit clears every currently-shown
 * ruler rather than trying to keep it pinned to a line that may have
 * moved, shifted its length, or changed content.
 */
export class ColsView {
  private readonly zoneIds = new Map<number, string>();

  constructor(
    private readonly editor: monacoNs.editor.IStandaloneCodeEditor,
    private readonly monaco: typeof monacoNs
  ) {
    editor.onDidChangeModelContent(() => this.clearAll());
  }

  /** Shows the ruler under `line` if hidden, removes it if already shown
   * — matching real ISPF's "type COLS again to turn it back off"
   * convention. */
  toggle(line: number): void {
    if (this.zoneIds.has(line)) {
      this.hide(line);
    } else {
      this.show(line);
    }
  }

  private show(line: number): void {
    const model = this.editor.getModel();
    if (!model || line < 1 || line > model.getLineCount()) return;

    const width = rulerWidth(model);
    const lineHeight = this.editor.getOption(this.monaco.editor.EditorOption.lineHeight);
    const domNode = document.createElement("div");
    domNode.className = "ispf-cols-zone";
    domNode.style.height = `${lineHeight}px`;
    domNode.style.lineHeight = `${lineHeight}px`;
    domNode.textContent = rulerText(width);

    this.editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({ afterLineNumber: line, heightInLines: 1, domNode });
      this.zoneIds.set(line, zoneId);
    });
  }

  private hide(line: number): void {
    const zoneId = this.zoneIds.get(line);
    if (zoneId === undefined) return;
    this.editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
    this.zoneIds.delete(line);
  }

  private clearAll(): void {
    if (this.zoneIds.size === 0) return;
    this.editor.changeViewZones((accessor) => {
      for (const zoneId of this.zoneIds.values()) accessor.removeZone(zoneId);
    });
    this.zoneIds.clear();
  }
}

/** The ruler spans the longest line currently in the document (so it's
 * actually useful for aligning real data), with an 80-column floor —
 * this project has no BOUNDS/record-length concept of its own (that's
 * part of the deliberately-deferred MASK/NUMBER/CAPS/HEX-ON/BOUNDS
 * cluster — see CLAUDE.md), so 80 (a traditional mainframe record
 * width) is a reasonable stand-in default rather than a real limit. */
function rulerWidth(model: monacoNs.editor.ITextModel): number {
  let max = 80;
  const totalLines = model.getLineCount();
  for (let i = 1; i <= totalLines; i++) {
    const len = model.getLineMaxColumn(i) - 1;
    if (len > max) max = len;
  }
  return max;
}

/** ISPF's own column-ruler pattern: a `-` for most columns, a `+` every
 * 5th, and the tens digit (wrapping 1-9-0) every 10th — e.g.
 * `----+----1----+----2----+----3`. */
function rulerText(width: number): string {
  let s = "";
  for (let col = 1; col <= width; col++) {
    if (col % 10 === 0) s += String((col / 10) % 10);
    else if (col % 5 === 0) s += "+";
    else s += "-";
  }
  return s;
}
