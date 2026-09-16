import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Locates a macro file for `name` in the workspace folder that owns
 * `document` — `.spfvs/macros/<name>.py`, lowercase filename, matching
 * how every other primary command token is already lowercased before
 * matching (see primaryCommand.ts). Phase 1 only searches this one,
 * workspace-local location — no global `spfvs.macroPath` fallback yet
 * (see macros.py's module docstring for the full deferred list).
 *
 * Returns `undefined` (not an error) when there's no workspace folder
 * at all, or no matching file — both are ordinary "not a macro, fall
 * through to the unknown-command error" cases, not failures.
 */
export function findMacroFile(document: vscode.TextDocument, name: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return undefined;
  const candidate = path.join(folder.uri.fsPath, ".spfvs", "macros", `${name.toLowerCase()}.py`);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * A macro is arbitrary Python code with the user's own file/process
 * privileges — the same trust model real ISPF macros have (they can
 * shell out too, e.g. via ADDRESS TSO). Gating on VS Code's own
 * Workspace Trust means opening someone else's repo can never silently
 * make their `.spfvs/macros/*.py` runnable — the SAME mechanism that
 * already gates other risky automatic behavior (tasks.json auto-run,
 * etc.), not a bespoke prompt this extension invents on its own.
 */
export function isWorkspaceTrustedForMacros(): boolean {
  return vscode.workspace.isTrusted;
}
