import * as vscode from "vscode";
import * as path from "path";
import { BackendClient, RawCommand } from "./backendClient";

interface MonacoChange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * A CustomTextEditorProvider (not a bespoke CustomDocument) so the real
 * vscode.TextDocument stays the single source of truth: undo/redo, save,
 * dirty state, and other extensions (git decorations, etc.) all keep
 * working without any extra code here. The webview is just a view over
 * that document plus a relay for edits and prefix commands.
 */
export class IspfEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "ispfEditor.editor";

  private readonly backend: BackendClient;
  // Document versions we produced ourselves via applyEdit, so the
  // onDidChangeTextDocument listener below can tell "the webview just
  // told us about this edit" apart from "something else changed the
  // document" (undo/redo, another editor, git) without echoing our own
  // edits back into the webview's Monaco model.
  private readonly appliedByUs = new Set<number>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new IspfEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(IspfEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    const pythonPath = vscode.workspace.getConfiguration("spfvs").get<string>("pythonPath", "python");
    this.backend = new BackendClient(pythonPath);
    context.subscriptions.push({ dispose: () => this.backend.dispose() });
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document);

    // LABEL (.name) and EXCLUDE (x/xx) state for this document's edit
    // session — see the module docstring on
    // backend/ispf_backend/prefix_commands.py. Kept here (not on `this`)
    // so it's naturally scoped to this one editor tab/document rather
    // than shared across every open ISPF editor the way `this.appliedByUs`
    // currently is. An external change invalidates both (they're tracked
    // purely by line number), so neither needs to survive one.
    let labels: Record<string, number> = {};
    let excludedLines: number[] = [];
    // Document versions produced by our OWN prefix-command batch, where
    // handlePrefixCommands has already updated `labels`/`excludedLines` to
    // the backend's post-batch values before applying the edit (same
    // ordering trick as applyEditTrackingOurVersion below, for the same
    // reason: the change listener can fire before the applyEdit promise
    // resolves). Lets the listener tell "our own restructuring, state
    // already correct" apart from "a genuinely external change, which
    // invalidates line-number state arbitrarily and must reset it".
    const pendingBatchEditVersions = new Set<number>();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;

      if (pendingBatchEditVersions.delete(e.document.version)) {
        // Our own prefix-command batch: handlePrefixCommands already
        // updated `labels`/`excludedLines` to the backend's post-batch
        // (correctly remapped) values before applying this edit. Still
        // need to push the new text — it came from the backend, not from
        // Monaco, so the webview's model doesn't have it yet.
        webviewPanel.webview.postMessage({ type: "setContent", text: e.document.getText(), labels, excludedLines });
        return;
      }
      if (this.appliedByUs.has(e.document.version)) {
        this.appliedByUs.delete(e.document.version);
        // An ordinary Monaco-typed edit: the webview's model already has
        // this text, so no setContent needed. But such an edit isn't run
        // through our line-remapping logic (that only happens for a
        // prefix-command batch, above), so any existing label or excluded
        // line could now silently point at the wrong line — safer to drop
        // both than risk that. Only bother notifying the webview if there
        // was anything to drop.
        if (Object.keys(labels).length > 0 || excludedLines.length > 0) {
          labels = {};
          excludedLines = [];
          webviewPanel.webview.postMessage({ type: "setLabels", labels, excludedLines });
        }
        return;
      }
      // A genuine external change (undo/redo, another editor, git, ...) —
      // force the webview's Monaco model back in sync, and drop labels/
      // excluded lines for the same reason as the ordinary-edit case above.
      labels = {};
      excludedLines = [];
      webviewPanel.webview.postMessage({ type: "setContent", text: e.document.getText(), labels, excludedLines });
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          webviewPanel.webview.postMessage({
            type: "init",
            text: document.getText(),
            fileName: path.basename(document.fileName),
          });
          break;
        case "edit":
          await this.applyMonacoEdit(document, message.changes as MonacoChange[]);
          break;
        case "processPrefixCommands":
          await this.handlePrefixCommands(
            document,
            webviewPanel,
            message.commands as RawCommand[],
            labels,
            excludedLines,
            (updatedLabels, updatedExcludedLines, expectedVersion) => {
              labels = updatedLabels;
              excludedLines = updatedExcludedLines;
              pendingBatchEditVersions.add(expectedVersion);
            }
          );
          break;
        case "primaryAction":
          await this.handlePrimaryAction(document, webviewPanel, message.action as string, () => {
            labels = {};
          });
          break;
        case "excludedLinesChanged":
          // Fire-and-forget notification from the webview's own EXCLUDE/
          // RESET (client-side, no backend round trip) — just keeps this
          // canonical copy in sync so the NEXT prefix-command batch's
          // request carries the right baseline to remap through.
          excludedLines = message.lines as number[];
          break;
      }
    });
  }

  /** Primary commands (UNDO/CANCEL/SAVE/END/RESET LAB) that need the real
   * vscode.TextDocument, a workbench command, or (RESET LAB only) the
   * extension host's own LABEL state, as opposed to FIND/CHANGE/TOP/
   * BOTTOM/LOCATE/EXCLUDE/RESET which stay entirely client-side against
   * Monaco's own model (see media/primaryCommand.ts). `resetLabels` is
   * invoked (synchronously updating the caller's `labels` closure
   * variable) instead of returning a value, mirroring how
   * `handlePrefixCommands`'s callbacks work below. */
  private async handlePrimaryAction(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    action: string,
    resetLabels: () => void
  ): Promise<void> {
    switch (action) {
      case "undo":
        // No document-level API for "step back one undo entry" exists;
        // this is the one primary action that relies on our webview
        // being VS Code's currently-focused editor for command routing.
        await vscode.commands.executeCommand("undo");
        break;
      case "undoAll":
        await this.revertToDisk(document);
        break;
      case "save": {
        const ok = await document.save();
        webviewPanel.webview.postMessage({
          type: "primaryActionResult",
          message: ok ? "saved" : "save failed",
          isError: !ok,
        });
        break;
      }
      case "cancel":
        await this.revertToDisk(document);
        webviewPanel.dispose();
        break;
      case "end":
        await document.save();
        webviewPanel.dispose();
        break;
      case "resetLabels":
        resetLabels();
        // Deliberately just {labels} — excludedLines is left out, so the
        // webview leaves whatever's currently folded alone (see its
        // "setLabels" handler). RESET LAB only ever touches labels.
        webviewPanel.webview.postMessage({ type: "setLabels", labels: {} });
        break;
    }
  }

  /** Replaces the document's content with what's currently on disk,
   * discarding unsaved changes. Implemented as a direct read + WorkspaceEdit
   * rather than the `workbench.action.files.revert` command so it doesn't
   * depend on this webview being the focused/active editor. */
  private async revertToDisk(document: vscode.TextDocument): Promise<void> {
    if (!document.isDirty) return;
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const text = Buffer.from(bytes).toString("utf8");
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, text);
    // Not tracked via appliedByUs — the webview's Monaco model needs the
    // reverted text pushed to it via the normal "external change" path.
    await vscode.workspace.applyEdit(edit);
  }

  /** Applies a WorkspaceEdit and marks its resulting version as ours
   * BEFORE awaiting, so the change-document listener (which may fire
   * before the applyEdit promise resolves) never mistakes it for an
   * external change. */
  private async applyEditTrackingOurVersion(document: vscode.TextDocument, edit: vscode.WorkspaceEdit): Promise<void> {
    const expectedVersion = document.version + 1;
    this.appliedByUs.add(expectedVersion);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      this.appliedByUs.delete(expectedVersion);
    }
  }

  private async applyMonacoEdit(document: vscode.TextDocument, changes: MonacoChange[]): Promise<void> {
    if (changes.length === 0) return;
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      const range = new vscode.Range(c.startLine - 1, c.startColumn - 1, c.endLine - 1, c.endColumn - 1);
      edit.replace(document.uri, range, c.text);
    }
    await this.applyEditTrackingOurVersion(document, edit);
  }

  /** `onStateResolved` is invoked with the batch's updated labels/
   * excludedLines and the document version the resulting edit is expected
   * to produce, BEFORE the edit is applied — see `pendingBatchEditVersions`
   * above for why. */
  private async handlePrefixCommands(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    commands: RawCommand[],
    labels: Record<string, number>,
    excludedLines: number[],
    onStateResolved: (labels: Record<string, number>, excludedLines: number[], expectedDocVersion: number) => void
  ): Promise<void> {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    const response = await this.backend.processPrefixCommands(lines, commands, labels, excludedLines);
    if (response.errors.length > 0 || !response.plan) {
      webviewPanel.webview.postMessage({ type: "prefixResult", errors: response.errors, consumedLines: [] });
      return;
    }

    // A prefix-command batch can restructure many discontiguous lines at
    // once, so a single whole-document replace is both simpler than a
    // minimal diff and exactly what we want for undo: one Ctrl+Z reverts
    // the entire batch, matching ISPF's own line-command granularity.
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const newText = response.plan.lines.join(eol);
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, newText);
    onStateResolved(response.labels ?? {}, response.excludedLines ?? [], document.version + 1);
    // Deliberately NOT tracked via appliedByUs: unlike a webview-originated
    // "edit" message, Monaco's own model here does not yet have this text
    // (the new content came from the backend, not from something the user
    // typed into Monaco) — treating this as an "external" change makes the
    // onDidChangeTextDocument listener below push the new text to the
    // webview via "setContent", which is exactly what's needed here.
    await vscode.workspace.applyEdit(edit);

    webviewPanel.webview.postMessage({
      type: "prefixResult",
      errors: [],
      consumedLines: response.plan.consumedLines,
      labels: response.labels,
      excludedLines: response.excludedLines,
    });
  }

  private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    // Cache-bust with the extension's own version so a rebuilt/reinstalled
    // extension can never keep serving a stale bundle from wherever the
    // webview's underlying browser process caches resources by URL.
    const cacheBust = String(this.context.extension.packageJSON.version ?? Date.now());
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.js"))
      .with({ query: `v=${cacheBust}` });
    const styleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.css"))
      .with({ query: `v=${cacheBust}` });
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <style>html, body, #ispf-root { height: 100%; margin: 0; padding: 0; overflow: hidden; }</style>
</head>
<body>
  <div id="ispf-root"></div>
  <script nonce="${nonce}">window.__ISPF_FILE_NAME__ = ${JSON.stringify(path.basename(document.fileName))};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
