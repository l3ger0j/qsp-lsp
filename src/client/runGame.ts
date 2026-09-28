/**
 * qsp.runGame — Node.js (desktop) implementation.
 *
 * Builds the project to a .qsp file in the workspace root and launches
 * the configured player. The output file stays in the workspace so that
 * relative resource paths (images, sounds, etc.) resolve correctly.
 * This file is only imported by nodeMain.ts; the browser entry point registers
 * a stub that tells the user the command is unavailable on VS Code for Web.
 */

import * as cp from 'child_process';
import * as vscode from 'vscode';
import { encodeTextToGame } from './txt2gam';
import { getActiveQspEditor, qspGlob } from './shared';
import { buildProjectGame, normalizeText } from './exportCommands';
import { ensureGameConfig, readGameConfig, workspaceRoot, type GameConfig } from './gameConfig';
import { classifyPlayerPath, pickPlayerExecutable } from '../common/playerExecutable';
import * as logger from './logger';

export async function runGameCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger.show();
  logger.log('[Run] Starting...');
  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);
  logger.log(`[Run] Project mode: ${projectEnabled}`);

  // Project mode builds through buildProjectGame; single-file mode encodes the active editor.
  let gameCfg: GameConfig | undefined;
  let sourceText = '';
  let outputUri: vscode.Uri | undefined;

  if (projectEnabled) {
    gameCfg = await ensureGameConfig(qspGlob(context));
    if (!gameCfg) return; // user cancelled setup
  } else {
    const editor = getActiveQspEditor();
    if (!editor) return;
    sourceText = normalizeText(editor.document.getText());
    const docUri = editor.document.uri;
    const baseName = docUri.path.split('/').pop()!.replace(/\.[^.]+$/, '') + '.qsp';
    const dirUri = docUri.with({ path: docUri.path.slice(0, docUri.path.lastIndexOf('/')) });
    outputUri = vscode.Uri.joinPath(dirUri, baseName);
  }

  const playerExe = await resolvePlayer(gameCfg);
  if (!playerExe) return; // cancelled

  // Use configured password silently — no prompt for a run-and-test workflow.
  const password = vscode.workspace.getConfiguration('qsp.game').get<string>('password') || undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building game…' },
    async () => {
      // In perFile mode several .qsp files are written; the first in source
      // order holds the start location, so that's the one the player opens.
      let gameUri: vscode.Uri;
      try {
        if (gameCfg) {
          const written = await buildProjectGame(context, gameCfg, qspGlob(context), password);
          if (written.length === 0) {
            vscode.window.showWarningMessage('No QSP source files found in the workspace.');
            return;
          }
          gameUri = written[0];
        } else {
          logger.log(`[Run] Building: ${vscode.workspace.asRelativePath(outputUri!)}`);
          const gameBytes = await encodeTextToGame(context.extensionUri, sourceText, { password });
          await vscode.workspace.fs.writeFile(outputUri!, gameBytes);
          logger.log(`[Run] Written: ${vscode.workspace.asRelativePath(outputUri!)} (${Math.round(gameBytes.byteLength / 1024)}kb)`);
          gameUri = outputUri!;
        }
      } catch (err) {
        logger.log(`[Run] Build failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(
          `Build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // execFile passes playerExe and qspPath as distinct argv entries —
      // spaces in both paths are handled correctly, no shell quoting needed.
      logger.log(`[Run] Launching: ${playerExe} ${gameUri.fsPath}`);
      cp.execFile(playerExe, [gameUri.fsPath], (err) => {
        if (err) {
          logger.log(`[Run] Launch failed: ${err.message}`);
          vscode.window.showErrorMessage(`Failed to launch player: ${err.message}`);
        }
      });
    },
  );
}

/**
 * The player to launch: txt2gam.json's `playerExecutable`, then the
 * `qsp.game.playerExecutable` setting, then a file picker whose choice is
 * saved to the setting. Undefined when the picker is cancelled.
 */
async function resolvePlayer(projectCfg: GameConfig | undefined): Promise<string | undefined> {
  // Single-file mode doesn't build from txt2gam.json, but a player named
  // there is still the project's player.
  let cfg = projectCfg;
  if (!cfg) {
    try {
      cfg = await readGameConfig();
    } catch (err) {
      logger.log(`[Run] Ignoring txt2gam.json for the player: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fromFile = pickPlayerExecutable(cfg?.playerExecutable, process.platform);
  if (fromFile) {
    const root = workspaceRoot();
    const player = classifyPlayerPath(fromFile) === 'relative' && root
      ? vscode.Uri.joinPath(root, fromFile).fsPath
      : fromFile;
    logger.log(`[Run] Player (txt2gam.json): ${player}`);
    return player;
  }
  if (cfg?.playerExecutable !== undefined) {
    logger.log(`[Run] txt2gam.json playerExecutable has no usable path for ${process.platform}; using the setting`);
  }

  const fromSetting = vscode.workspace
    .getConfiguration('qsp.game')
    .get<string>('playerExecutable')
    ?.trim();
  if (fromSetting) {
    logger.log(`[Run] Player (setting): ${fromSetting}`);
    return fromSetting;
  }

  const picked = await vscode.window.showOpenDialog({
    title: 'Select QSP player executable',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Select player',
  });
  if (!picked || picked.length === 0) return undefined;

  const player = picked[0].fsPath;
  // Saved globally rather than to txt2gam.json: an absolute path picked on
  // this machine means nothing on another checkout.
  await vscode.workspace
    .getConfiguration('qsp.game')
    .update('playerExecutable', player, vscode.ConfigurationTarget.Global);
  logger.log(`[Run] Player executable saved: ${player}`);
  return player;
}
