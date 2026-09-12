import * as vscode from "vscode";
import { IspfEditorProvider } from "./ispfEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(IspfEditorProvider.register(context));
}

export function deactivate(): void {}
