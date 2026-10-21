import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const gitCommonDir = spawnSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: projectRoot, encoding: 'utf8' },
);

// ZIP downloads have no .git directory; the browser cache still works locally.
const repositoryRoot = gitCommonDir.status === 0
  ? dirname(gitCommonDir.stdout.trim())
  : projectRoot;
const playwrightCli = fileURLToPath(import.meta.resolve('@playwright/test/cli'));
const result = spawnSync(process.execPath, [playwrightCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(repositoryRoot, '.playwright-browsers'),
    npm_config_cache: join(projectRoot, '.npm-cache'),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
