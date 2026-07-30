#!/usr/bin/env node
/**
 * Runs the API (port 8787) and the Vite dev server (port 5173) side by side.
 * Written by hand so the project needs no process-runner dependency.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'api', color: '\u001b[36m', cwd: path.join(root, 'server') },
  { name: 'web', color: '\u001b[35m', cwd: path.join(root, 'web') },
];

const children = [];
let shuttingDown = false;

for (const t of targets) {
  const child = spawn(npm, ['run', 'dev'], { cwd: t.cwd, env: process.env });
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
