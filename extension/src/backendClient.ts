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

/**
 * Talks to one persistent `python -m ispf_backend` process over newline-
 * delimited JSON on stdin/stdout. One client is shared by every open
 * ISPF-editor tab in this extension host.
 */
export class BackendClient {
  private process: cp.ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: BackendResponse) => void; reject: (e: Error) => void }>();
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
      let response: BackendResponse;
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

  dispose(): void {
    this.process?.kill();
    this.process = undefined;
  }
}
