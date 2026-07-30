#!/usr/bin/env node
/**
 * Root `npm install` should be enough to get the whole product running.
 * This installs the server and web workspaces if they are not installed yet.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const pkg of ['server', 'web']) {
  const dir = path.join(root, pkg);
  if (!existsSync(path.join(dir, 'package.json'))) continue;
  if (existsSync(path.join(dir, 'node_modules'))) {
    console.log(`[setup] ${pkg}: dependencies already installed, skipping`);
    continue;
  }
  console.log(`[setup] installing ${pkg} dependencies…`);
  const res = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_ignore_scripts: '' },
  });
  if (res.status !== 0) {
    console.error(`[setup] failed to install ${pkg} dependencies.`);
    console.error(`[setup] run it manually:  npm install --prefix ${pkg}`);
    process.exit(res.status ?? 1);
  }
}
console.log('[setup] done. Next:  npm run dev');
