import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { defineTool, ToolError, truncate } from './toolkit.js';

/**
 * The agent gets a real, writable workspace on disk — scoped per run so two
 * runs can never see or clobber each other's files, and resolved through
 * path.resolve so "../../etc/passwd" style inputs are rejected, not sanitised
 * into something that silently works.
 */

function resolveSafe(runId, relative) {
  const base = path.resolve(config.workspaceDir, runId);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new ToolError(`Path "${relative}" escapes the run workspace. Use a plain relative filename.`, {
      kind: 'blocked',
      retriable: true,
    });
  }
  return { base, target };
}

export const writeFile = defineTool({
  name: 'write_file',
  title: 'Write a file',
  category: 'workspace',
  description:
    'Write text to a file in this run\'s private workspace. Use it to save notes, extracted data or draft sections you will need later.',
  parameters: {
    path: { type: 'string', required: true, description: 'Relative filename, e.g. "notes.md".' },
    content: { type: 'string', required: true, maxLength: 200000, description: 'Full text content to write.' },
    mode: { type: 'string', required: false, default: 'overwrite', enum: ['overwrite', 'append'], description: 'Overwrite the file or append to it.' },
  },
  returns: 'The stored path and byte count.',
  signature: (input) => `write_file("${input.path ?? ''}", ${String(input.content ?? '').length} chars)`,

  async run({ path: rel, content, mode = 'overwrite' }, ctx) {
    const { target } = resolveSafe(ctx.runId, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    ctx.progress(`Writing ${rel}`);
    if (mode === 'append') await fsp.appendFile(target, content, 'utf8');
    else await fsp.writeFile(target, content, 'utf8');
    const stat = await fsp.stat(target);
    return { path: rel, bytes: stat.size, mode, preview: truncate(content, 240) };
  },
});

export const readFile = defineTool({
  name: 'read_file',
  title: 'Read a file',
  category: 'workspace',
  description: 'Read back a file previously written to this run\'s workspace.',
  parameters: {
    path: { type: 'string', required: true, description: 'Relative filename to read.' },
    maxChars: { type: 'number', required: false, default: 8000, min: 100, max: 40000, description: 'Maximum characters to return.' },
  },
  returns: 'The file contents and its size.',
  signature: (input) => `read_file("${input.path ?? ''}")`,

  async run({ path: rel, maxChars = 8000 }, ctx) {
    const { base, target } = resolveSafe(ctx.runId, rel);
    ctx.progress(`Reading ${rel}`);
    try {
      const content = await fsp.readFile(target, 'utf8');
      return { path: rel, chars: content.length, truncated: content.length > maxChars, content: truncate(content, maxChars) };
    } catch (err) {
      if (err.code === 'ENOENT') {
        let available = [];
        try {
          available = await fsp.readdir(base);
        } catch {
          /* workspace not created yet */
        }
        throw new ToolError(
          `No file named "${rel}" in this workspace.` +
            (available.length ? ` Available files: ${available.join(', ')}.` : ' The workspace is currently empty.'),
          { kind: 'not_found', retriable: true },
        );
      }
      throw new ToolError(`Could not read "${rel}": ${err.message}`, { kind: 'io_error', retriable: false });
    }
  },
});
