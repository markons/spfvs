import type * as monacoNs from "monaco-editor/esm/vs/editor/editor.api";

/**
 * The `hx` prefix (line) command shows a line's hex representation as two
 * extra rows directly beneath it, ISPF-style — a pure VIEW effect via
 * Monaco's view-zone API (space reserved in the rendered view, never in
 * the document model), the same category of trick excludeFolding.ts uses
 * for EXCLUDE (view-only, no document edit).
 *
 * Unlike LABEL/EXCLUDE, this is deliberately NOT persisted or remapped
 * through prefix-command batches or backend state — it never reaches
 * `prefix_commands.py` at all (see gutter.ts's `commit()`, which
 * intercepts `hx`/`hx[n]` codes before they'd otherwise be sent to the
 * backend as unknown commands). It's a quick "peek at this line's
 * bytes" aid, toggled per line, and ANY document edit clears every
 * currently-shown zone rather than trying to keep them pinned to lines
 * that may have moved or changed — simpler and safer than teaching this
 * one more thing to track through restructuring the way labels/excluded
 * lines do.
 */
export class HexView {
  private readonly zoneIds = new Map<number, string>();

  constructor(
    private readonly editor: monacoNs.editor.IStandaloneCodeEditor,
    private readonly monaco: typeof monacoNs
  ) {
    editor.onDidChangeModelContent(() => this.clearAll());
  }

  /** Shows the hex rows for `line` if hidden, removes them if already
   * shown — matching real ISPF's "type HX again to turn it back off"
   * convention. */
  toggle(line: number): void {
    if (this.zoneIds.has(line)) {
      this.hide(line);
    } else {
      this.show(line);
    }
  }

  /** Unconditionally shows the hex rows for `line` (idempotent — a
   * no-op if already shown). Used for the `hx[n]` counted form, where
   * toggling per line would give a confusing mixed on/off result if some
   * of the n lines already had a zone and others didn't. */
  show(line: number): void {
    if (this.zoneIds.has(line)) return;
    const model = this.editor.getModel();
    if (!model || line < 1 || line > model.getLineCount()) return;

    const [highNibbles, lowNibbles] = hexRows(model.getLineContent(line));
    const lineHeight = this.editor.getOption(this.monaco.editor.EditorOption.lineHeight);
    const domNode = document.createElement("div");
    domNode.className = "ispf-hex-zone";
    for (const text of [highNibbles, lowNibbles]) {
      const row = document.createElement("div");
      row.className = "ispf-hex-row";
      row.style.height = `${lineHeight}px`;
      row.style.lineHeight = `${lineHeight}px`;
      // A blank line has no hex digits at all; an empty row would collapse
      // to zero width and make the zone look broken rather than just empty.
      row.textContent = text || " ";
      domNode.appendChild(row);
    }

    this.editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({ afterLineNumber: line, heightInLines: 2, domNode });
      this.zoneIds.set(line, zoneId);
    });
  }

  private hide(line: number): void {
    const zoneId = this.zoneIds.get(line);
    if (zoneId === undefined) return;
    this.editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
    this.zoneIds.delete(line);
  }

  /** Hides every currently-shown hex zone at once — called both
   * internally on any document edit, and by the `RESET`/`RES` primary
   * command (see primaryCommand.ts), since a view-only toggle like this
   * has no document edit of its own to trigger the internal cleanup:
   * without this, `RES` (which already clears EXCLUDE'd lines) would
   * leave any shown hex rows behind, looking like they can't be turned
   * off at all. */
  hideAll(): void {
    this.clearAll();
  }

  private clearAll(): void {
    if (this.zoneIds.size === 0) return;
    this.editor.changeViewZones((accessor) => {
      for (const zoneId of this.zoneIds.values()) accessor.removeZone(zoneId);
    });
    this.zoneIds.clear();
  }
}

/** One hex digit per row per character, both rows the same length as
 * `text` — not two digits stacked under one column, which wouldn't fit
 * a monospace character cell. This is also how real ISPF's HEX display
 * lines it up: the character's high nibble directly above its low
 * nibble, both directly below the character itself.
 *
 * Each character's code point is masked to one byte (0-255), matching
 * ISPF's single-byte-per-column convention — characters beyond Latin-1
 * show the low byte of their UTF-16 code unit rather than a true
 * multi-byte breakdown, a deliberate simplification for this project's
 * mostly-ASCII target use case rather than an attempt at real UTF-8
 * byte-accurate hex. */
function hexRows(text: string): [string, string] {
  let high = "";
  let low = "";
  for (let i = 0; i < text.length; i++) {
    const hex = (text.charCodeAt(i) & 0xff).toString(16).toUpperCase().padStart(2, "0");
    high += hex[0];
    low += hex[1];
  }
  return [high, low];
}
