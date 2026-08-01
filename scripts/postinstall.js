#!/usr/bin/env node
/**
 * Root `npm install` should be enough to get the whole product running.
 * This installs the server and web workspaces if they are not installed yet.
 *
 * Note on Windows: npm is `npm.cmd`, and Node 20.12+ refuses to spawn .cmd
 * files without a shell (EINVAL). Hence `shell: true` on win32.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

let failed = false;

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
    shell: isWindows,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    failed = true;
    console.error(`[setup] could not install ${pkg} dependencies automatically.`);
    if (res.error) console.error(`[setup] reason: ${res.error.message}`);
  }
}

if (failed) {
  // Exit 0 on purpose: a failed convenience step should not abort the whole
  // install with a wall of npm errors. The manual command always works.
  console.error('');
  console.error('[setup] Run these two commands and you are good to go:');
  console.error('[setup]   npm install --prefix server');
  console.error('[setup]   npm install --prefix web');
  console.error('');
} else {
  console.log('[setup] done. Next:  npm run dev');
}
