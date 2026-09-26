import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 3,
    // test/ui (and its build in out/) runs inside VS Code via @vscode/test-cli.
    exclude: [...configDefaults.exclude, 'test/ui/**', 'out/**'],
  },
});
