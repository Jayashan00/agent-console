import { defineTool, httpGet, htmlToText, truncate, ToolError } from './toolkit.js';

const BLOCKED_HOSTS = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/];

export default defineTool({
  name: 'fetch_url',
  title: 'Read a web page',
  category: 'research',
  description:
    'Fetch a public URL and return its readable text content with the title. Use after web_search to actually read a source instead of relying on the snippet.',
  parameters: {
    url: { type: 'string', required: true, description: 'Absolute http(s) URL to read.' },
    maxChars: { type: 'number', required: false, default: 6000, min: 500, max: 20000, description: 'Maximum characters of text to return.' },
  },
  returns: 'The page title, final URL after redirects, character count and extracted text.',
  signature: (input) => `fetch_url("${truncate(input.url ?? '', 70)}")`,

  async run({ url, maxChars = 6000 }, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError(`"${url}" is not a valid absolute URL. Include the https:// prefix.`, {
        kind: 'invalid_input',
        retriable: true,
      });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ToolError(`Only http and https URLs can be read, got "${parsed.protocol}".`, {
        kind: 'invalid_input',
        retriable: true,
      });
    }
    if (BLOCKED_HOSTS.some((re) => re.test(parsed.hostname))) {
      throw new ToolError(`Refusing to fetch private address "${parsed.hostname}".`, {
        kind: 'blocked',
        retriable: false,
      });
    }

    const { body, contentType, finalUrl, status } = await httpGet(parsed.toString(), {
      progress: ctx.progress,
      timeoutMs: ctx.timeoutMs,
    });

    ctx.progress(`Extracting text from ${(body.length / 1024).toFixed(1)} KB`);

    if (contentType.includes('application/json')) {
      return { url: finalUrl, status, contentType, title: parsed.hostname, chars: body.length, text: truncate(body, maxChars) };
    }

    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = htmlToText(body);
    if (!text) {
      throw new ToolError(`Fetched ${finalUrl} but found no readable text (likely a script-rendered page).`, {
        kind: 'empty_result',
        retriable: false,
      });
    }
    return {
      url: finalUrl,
      status,
      contentType: contentType || 'text/html',
      title: titleMatch ? htmlToText(titleMatch[1]) : parsed.hostname,
      chars: text.length,
      truncated: text.length > maxChars,
      text: truncate(text, maxChars),
    };
  },
});
