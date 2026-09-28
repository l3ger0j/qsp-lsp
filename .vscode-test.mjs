// @vscode/test-cli config for the UI tests in test/ui (run: npm run test:ui).
import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The tests write files (the combined .qsps), so each run gets a fresh copy
// of the fixture instead of dirtying the one in the repository.
const workspace = mkdtempSync(join(tmpdir(), 'qsp-ui-'));
cpSync('test/ui/fixture', workspace, { recursive: true });

export default defineConfig({
  files: 'out/test/ui/**/*.test.js',
  workspaceFolder: workspace,
  version: 'stable',
  // Other extensions installed in the developer's profile must not change
  // what the tests see (another QSP extension, a Russian UI language pack).
  launchArgs: ['--disable-extensions', '--locale=en'],
  mocha: { ui: 'tdd', timeout: 60_000 },
});
