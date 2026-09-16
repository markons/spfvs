import * as cp from "child_process";
import * as vscode from "vscode";

export interface RawCommand {
  line: number;
  code: string;
}

export interface CommandErrorMsg {
  line: number;
  message: string;
}

export interface LinePlanMsg {
  lines: string[];
  consumedLines: number[];
}

// A pending copy/move mark left by an unpaired c/cc/m/mm, resolved by a
// CUT primary command (see prefix_commands.py's module docstring).
export interface PendingMark {
  kind: "copy" | "move";
  start: number;
  end: number;
}

export interface BackendResponse {
  id: number;
  errors: CommandErrorMsg[];
  plan: LinePlanMsg | null;
  // Updated name->line LABEL map after this batch (see prefix_commands.py's
  // module docstring). null iff plan is null (batch rejected, caller keeps
  // whatever label map it already had).
  labels: Record<string, number> | null;
  // Updated sorted list of excluded (hidden) line numbers after this
  // batch's x/xx ops. Same null-iff-rejected rule as labels.
  excludedLines: number[] | null;
  // Updated pending copy/move mark (or null if none/just resolved by
  // executeCut). Same null-iff-rejected rule as labels.
  pendingMark: PendingMark | null;
}

// A macro's result — separate response shape from BackendResponse, sent
// for `type: "runMacro"` requests (see macros.py/server.py's module
// docstrings). Deliberately its own request/response pair, not folded
// into the existing prefix-command shape, so a macro bug can never touch
// that well-tested path.
export interface MacroResponse {
  id: number;
  ok: boolean;
  lines: string[] | null;
  cursorLine: number | null;
  labels: Record<string, number> | null;
  message: string;
  error: string | null;
}

/**
 * Talks to one persistent `python -m ispf_backend` process over newline-
 * delimited JSON on stdin/stdout. One client is shared by every open
 * ISPF-editor tab in this extension host.
 */
export class BackendClient {
  private process: cp.ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  // Shared between both response shapes (BackendResponse and
  // MacroResponse both carry an "id") — each public method below
  // constructs its own correctly-typed Promise, so the untyped `resolve`
  // here is safe: it's cast back to the right shape at the one call site
  // that created it.
  private readonly pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(private readonly pythonPath: string) {}

  private ensureStarted(): cp.ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) {
      return this.process;
    }
    const proc = cp.spawn(this.pythonPath, ["-m", "ispf_backend"]);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => console.error("[ispf-backend]", chunk));
    proc.on("exit", (code) => {
      console.error(`[ispf-backend] exited with code ${code}`);
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("ispf_backend process exited"));
      }
      this.pending.clear();
      this.process = undefined;
    });
    proc.on("error", (err) => {
      vscode.window.showErrorMessage(
        `SPFVS: failed to launch the Python backend ("${this.pythonPath} -m ispf_backend"): ${err.message}. ` +
          `Set "spfvs.pythonPath" in settings if Python isn't on PATH.`
      );
    });
    this.process = proc;
    return proc;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let response: { id: number };
      try {
        response = JSON.parse(line);
      } catch {
        console.error("[ispf-backend] malformed response line:", line);
        continue;
      }
      const waiter = this.pending.get(response.id);
      if (waiter) {
        this.pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  }

  processPrefixCommands(
    lines: string[],
    commands: RawCommand[],
    labels: Record<string, number>,
    excludedLines: number[],
    pendingMark: PendingMark | null,
    executeCut = false,
    executePaste: { line: number; before: boolean } | null = null
  ): Promise<BackendResponse> {
    const proc = this.ensureStarted();
    const id = this.nextId++;
    const request =
      JSON.stringify({ id, lines, commands, labels, excludedLines, pendingMark, executeCut, executePaste }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(request, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Runs a macro file (an absolute filesystem path the caller already
   * resolved via macros.ts's lookup) against a snapshot of the document.
   * Sent as `type: "runMacro"` — a separate request shape from the
   * default (untyped) prefix-command one, so server.py can dispatch
   * between them without touching the existing, well-tested
   * `process()` path at all (see macros.py's module docstring).
   * `labels` is read-only here — the macro can `resolve_label()` an
   * existing one, but nothing comes back to update the caller's own
   * copy, since Phase 1 macros can't create/clear one. */
  runMacro(
    macroPath: string,
    lines: string[],
    cursorLine: number,
    args: string[],
    labels: Record<string, number>
  ): Promise<MacroResponse> {
    const proc = this.ensureStarted();
    const id = this.nextId++;
    const request = JSON.stringify({ id, type: "runMacro", macroPath, lines, cursorLine, args, labels }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(request, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    this.process?.kill();
    this.process = undefined;
  }
}
