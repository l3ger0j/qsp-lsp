// ── Performance profile ──────────────────────────────────────────────
//
// "QSP: Collect Performance Profile" (desktop only) restarts the language
// server with the profiler on (src/server/nodeProfiler.ts). The user
// opens the project as usual; "Save Profile" then stores the server's
// performance report next to the profiles and restarts the server
// normally. Nothing saved holds game text or names, so the folder can be
// sent with a bug report.
//
// The server runs on VS Code's own runtime, whose heap is capped near
// 4 GB whatever --max-old-space-size says, so a game that runs out of
// memory crashes while profiled too. Each process writes its files under
// its own pid as it goes, so the crashed runs stay in the folder: the
// heap sample taken shortly before the crash is the most useful part.

import * as os from 'os';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** What the server is started with; read again on every (re)start. */
export interface ServerLaunch {
  profileDir?: string;
}

interface ProfileStatus { active: boolean; dir?: string; pid?: number }

/** Register the collect and save commands. */
export function registerPerformanceProfile(context: vscode.ExtensionContext, client: LanguageClient, launch: ServerLaunch): void {
  const item = vscode.window.createStatusBarItem('qsp.profiling', vscode.StatusBarAlignment.Left, 100);
  item.name = 'QSP Profiling';
  item.text = '$(record) QSP profiling';
  item.tooltip = 'The QSP language server is being profiled. Click to save the profile.';
  item.command = 'qsp.savePerformanceProfile';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  const setProfiling = async (dir: string | undefined) => {
    launch.profileDir = dir;
    await vscode.commands.executeCommand('setContext', 'qsp.profiling', dir !== undefined);
    if (dir) item.show(); else item.hide();
  };

  // A server busy in a long analysis can't answer the shutdown in time;
  // languageclient then gives up on the restart. Report it rather than
  // leave the user profiling nothing.
  const restart = async (): Promise<boolean> => {
    try {
      await client.restart();
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`QSP: could not restart the language server: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const save = async () => {
    const dir = launch.profileDir;
    if (!dir) return;
    const dirUri = vscode.Uri.file(dir);
    let reportError: string | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'QSP: saving the performance profile…' },
      async () => {
        let report: unknown;
        try {
          report = await client.sendRequest('qsp/performanceReport');
        } catch (e) {
          reportError = e instanceof Error ? e.message : String(e);
          report = { error: `The server did not answer: ${reportError}` };
        }
        const environment = {
          extensionVersion: (context.extension.packageJSON as { version?: string }).version,
          vscodeVersion: vscode.version,
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
          totalMemoryMB: Math.round(os.totalmem() / 1048576),
        };
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(dirUri, 'report.json'),
          Buffer.from(JSON.stringify({ environment, report }, null, 2)),
        );
        try {
          await client.sendRequest('qsp/profile/stop');
        } catch {
          // The server died (e.g. out of memory); what it wrote on the way is in the folder.
        }
        await setProfiling(undefined);
        await restart();
      },
    );
    const files = (await vscode.workspace.fs.readDirectory(dirUri)).map(([name]) => name);
    const pids = new Set(files.map(f => /-(\d+)\./.exec(f)?.[1]).filter((p): p is string => p !== undefined));
    const crashNote = reportError
      ? ' The server was not running when you saved (it probably crashed); the files of the crashed runs are kept.'
      : '';
    const open = await vscode.window.showInformationMessage(
      `QSP: performance profile saved: ${files.length} files from ${pids.size} server run${pids.size === 1 ? '' : 's'}.${crashNote} `
      + 'It holds only numbers, grammar construct names and the extension\'s own function names: no game text, '
      + 'file, location or variable names. Review it, then attach the folder to your report.',
      'Open Folder',
    );
    if (open) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.joinPath(dirUri, 'report.json'));
  };

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('qsp.collectPerformanceProfile', async () => {
      if (launch.profileDir) return save();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = vscode.Uri.joinPath(context.logUri, `profile-${stamp}`);
      await vscode.workspace.fs.createDirectory(dir);
      await setProfiling(dir.fsPath);
      // The server analyses the open files before it answers the start-up,
      // so a game that exhausts memory makes the restart itself fail.
      // Its files are already in the folder then: offer to save them.
      if (!await restart()) {
        const pick = await vscode.window.showWarningMessage(
          'QSP: the language server failed while starting with profiling on (it may have run out of memory). Save what it recorded?',
          'Save Profile', 'Cancel',
        );
        if (pick === 'Save Profile') await save(); else await setProfiling(undefined);
        return;
      }
      let status: ProfileStatus | undefined;
      try {
        status = await client.sendRequest<ProfileStatus>('qsp/profile/status');
      } catch {
        // Died right after starting; the save below still collects its files.
      }
      if (status && !status.active) {
        await setProfiling(undefined);
        void vscode.window.showErrorMessage('QSP: the language server restarted but profiling did not start. See "QSP: Show Language Server Log".');
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `QSP: the language server restarted with profiling on${status?.pid ? ` (process ${status.pid})` : ''}. Work as usual until the problem shows up `
        + '(or until the QSP status says Ready), then save the profile here or with the "QSP profiling" status bar item. '
        + 'If the server crashes, just save: the crashed runs keep their files.',
        'Save Profile', 'Cancel',
      );
      if (pick === 'Save Profile') {
        await save();
      } else if (pick === 'Cancel') {
        await setProfiling(undefined);
        await restart();
      }
    }),
    vscode.commands.registerCommand('qsp.savePerformanceProfile', save),
  );
}
