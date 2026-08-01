#!/usr/bin/env node
/**
 * Runs the API (port 8787) and the Vite dev server (port 5173) side by side.
 * Written by hand so the project needs no process-runner dependency.
 *
 * Note on Windows: npm is `npm.cmd`, and Node 20.12+ refuses to spawn .cmd
 * files without a shell (EINVAL). Hence `shell: true` on win32.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'api', color: '\u001b[36m', cwd: path.join(root, 'server') },
  { name: 'web', color: '\u001b[35m', cwd: path.join(root, 'web') },
];

for (const t of targets) {
  if (!existsSync(path.join(t.cwd, 'node_modules'))) {
    console.error(`\nDependencies are missing in /${path.basename(t.cwd)}.`);
    console.error('Run this first:\n');
    console.error('  npm install --prefix server');
    console.error('  npm install --prefix web\n');
    process.exit(1);
  }
}

const children = [];
let shuttingDown = false;

for (const t of targets) {
  const child = spawn(npm, ['run', 'dev'], {
    cwd: t.cwd,
    env: process.env,
    shell: isWindows,
    windowsHide: true,
  });
  children.push(child);

  const prefix = `${t.color}[${t.name}]\u001b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('error', (err) => {
    console.error(`${prefix}failed to start: ${err.message}`);
    shutdown(1);
  });

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
