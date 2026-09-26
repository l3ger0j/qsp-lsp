// UI tests: run inside a real VS Code (npm run test:ui, see .vscode-test.mjs)
// against a copy of test/ui/fixture. Unlike the Vitest suites, they cover
// the client, the language client wiring and the bundled server together.

import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qsp.qsp-lsp';

// The server parses asynchronously (debounced, WASM loaded on start), so
// every LSP-backed check polls instead of asserting once.
async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

function fixtureUri(relPath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'the fixture workspace is not open');
  return vscode.Uri.joinPath(root, relPath);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

suite('QSP extension', () => {
  test('activates on a .qsps file and publishes a syntax error', async () => {
    const uri = fixtureUri('errors.qsps');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, 'qsp');

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    await waitFor('extension activation', () => (ext.isActive ? true : undefined));

    const errors = await waitFor('syntax diagnostics', () => {
      const found = vscode.languages.getDiagnostics(uri)
        .filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      return found.length > 0 ? found : undefined;
    });
    // errors.qsps has `if x = 1` without the colon on line 2.
    const missingColon = errors.find(d => d.message.includes("Missing ':'"));
    assert.ok(missingColon, `no "Missing ':'" error; got: ${errors.map(d => d.message).join(' | ')}`);
    assert.strictEqual(missingColon.range.start.line, 1);
  });

  test('serves hover and completion for a builtin function', async () => {
    const uri = fixtureUri('main.qsps');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    // `len` in `x = len('abc')` on line 2.
    const onLen = new vscode.Position(1, 5);

    const hoverText = await waitFor('hover on len', async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, onLen);
      const text = (hovers ?? [])
        .flatMap(h => h.contents)
        .map(c => (typeof c === 'string' ? c : c.value))
        .join('\n');
      return text.length > 0 ? text : undefined;
    });
    assert.match(hoverText, /len/i);

    const afterEquals = new vscode.Position(1, 4);
    const labels = await waitFor('completion items', async () => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', uri, afterEquals);
      const names = (list?.items ?? [])
        .map(i => (typeof i.label === 'string' ? i.label : i.label.label).toLowerCase());
      return names.includes('len') ? names : undefined;
    });
    assert.ok(labels.includes('len'));
  });

  test('Combine Project Files writes the sources in txt2gam.json order', async () => {
    const root = vscode.workspace.workspaceFolders![0];
    const output = fixtureUri(`${root.name}.qsps`);
    assert.strictEqual(await exists(output), false, 'combined file left over from an earlier run');

    const done = vscode.commands.executeCommand('qsp.combineProject');
    // The save dialog is a quick input here (files.simpleDialog.enable in the
    // fixture settings) prefilled with the suggested path; accept it once it
    // shows up. Accepting before it opens is a harmless no-op.
    await waitFor('combined file', async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return (await exists(output)) ? true : undefined;
    });
    await done;

    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(output));
    const start = text.indexOf('# start');
    const data = text.indexOf('# data');
    assert.ok(start >= 0 && data > start, 'main.qsps must come before data/data.qsps');
    assert.ok(text.includes("$name = 'Алиса'"), 'Cyrillic text must survive combining');
    assert.ok(!text.includes('# broken'), 'errors.qsps is not listed in txt2gam.json');
  });

  test('Copy MCP Server Config puts a runnable server path on the clipboard', async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('qsp.copyMcpConfig');
    const config = JSON.parse(await vscode.env.clipboard.readText()) as { mcpServers: { qsp: { command: string; args: string[] } } };
    const [server, flag, folder] = config.mcpServers.qsp.args;
    assert.ok(await exists(vscode.Uri.file(server)), `${server} is not in the extension`);
    assert.strictEqual(flag, '--workspace');
    assert.strictEqual(folder, vscode.workspace.workspaceFolders![0].uri.fsPath);
  });
});
