import * as vscode from 'vscode';
import { PreBasePanel } from './webview/PreBasePanel';

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('PreBase');
  context.subscriptions.push(output);
  output.appendLine('PreBase extension activated (command-driven; no repository scan).');
  output.appendLine(
    `Workspace trust: ${vscode.workspace.isTrusted ? 'trusted' : 'restricted (read-only analysis still allowed)'}`,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prebase.open', () => {
      PreBasePanel.createOrShow(
        context.extensionUri,
        context.storageUri ?? context.globalStorageUri,
        output!,
      );
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PreBasePanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        PreBasePanel.revive(
          panel,
          context.extensionUri,
          context.storageUri ?? context.globalStorageUri,
          output!,
        );
      },
    }),
  );
}

export function deactivate(): void {
  PreBasePanel.current?.dispose();
  output?.appendLine('PreBase extension deactivated.');
}
