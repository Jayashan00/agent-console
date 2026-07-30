/**
 * TagStreamParser
 *
 * The agent's model output is a tiny tagged protocol:
 *
 *   <thinking>free-form reasoning…</thinking>
 *   <action>{"tool":"web_search","input":{"query":"…"}}</action>
 *
 * This parser consumes the model stream token by token and routes each chunk to
 * its channel *as it arrives*. That is what makes the reasoning appear in the UI
 * while the model is still writing it, instead of after the turn completes.
 *
 * The tricky part is boundaries: a chunk can end halfway through "</think".
 * The parser holds back only the characters that could still turn out to be a
 * tag and releases everything else immediately — so nothing is buffered for
 * longer than it has to be, and no tag fragment ever leaks into the UI.
 */
export class TagStreamParser {
  constructor(tags, { onDelta, onClose, onStray } = {}) {
    this.tags = tags;
    this.onDelta = onDelta ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.onStray = onStray ?? (() => {});
    this.buffer = '';
    this.current = null;
    this.currentText = '';
  }

  push(chunk) {
    this.buffer += chunk;
    let progressed = true;
    while (progressed) {
      progressed = false;

      if (!this.current) {
        let bestTag = null;
        let bestIndex = Infinity;
        for (const tag of this.tags) {
          const idx = this.buffer.indexOf(`<${tag}>`);
          if (idx !== -1 && idx < bestIndex) {
            bestIndex = idx;
            bestTag = tag;
          }
        }
        if (bestTag) {
          const stray = this.buffer.slice(0, bestIndex).trim();
          if (stray) this.onStray(stray);
          this.buffer = this.buffer.slice(bestIndex + bestTag.length + 2);
          this.current = bestTag;
          this.currentText = '';
          progressed = true;
        } else {
          const keep = this.tailToKeep(this.tags.map((t) => `<${t}>`));
          const stray = this.buffer.slice(0, this.buffer.length - keep).trim();
          if (stray) this.onStray(stray);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
        }
        continue;
      }

      const closeTag = `</${this.current}>`;
      const at = this.buffer.indexOf(closeTag);
      if (at !== -1) {
        const tail = this.buffer.slice(0, at);
        if (tail) {
          this.currentText += tail;
          this.onDelta(this.current, tail);
        }
        this.onClose(this.current, this.currentText);
        this.buffer = this.buffer.slice(at + closeTag.length);
        this.current = null;
        this.currentText = '';
        progressed = true;
      } else {
        const keep = this.tailToKeep([closeTag]);
        const emit = this.buffer.slice(0, this.buffer.length - keep);
        if (emit) {
          this.currentText += emit;
          this.onDelta(this.current, emit);
          this.buffer = this.buffer.slice(emit.length);
        }
      }
    }
  }

  /** How many trailing characters could still be the start of one of `candidates`. */
  tailToKeep(candidates) {
    let keep = 0;
    for (const candidate of candidates) {
      const max = Math.min(candidate.length - 1, this.buffer.length);
      for (let k = max; k > 0; k--) {
        if (this.buffer.endsWith(candidate.slice(0, k))) {
          keep = Math.max(keep, k);
          break;
        }
      }
    }
    return keep;
  }

  /** Flush anything still open at end of stream so no text is lost. */
  end() {
    if (this.current) {
      if (this.buffer) {
        this.currentText += this.buffer;
        this.onDelta(this.current, this.buffer);
      }
      this.onClose(this.current, this.currentText);
    } else if (this.buffer.trim()) {
      this.onStray(this.buffer.trim());
    }
    this.buffer = '';
    this.current = null;
    this.currentText = '';
  }
}

/** Tolerant JSON extraction — models occasionally wrap JSON in fences or prose. */
export function parseLooseJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to bracket scan */
  }
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
