import { defineTool, httpGet, ToolError, truncate } from './toolkit.js';

/**
 * web_search — real search over two keyless public endpoints:
 *   • DuckDuckGo Instant Answer API (topics, abstracts, official links)
 *   • Wikipedia search API (encyclopaedic coverage, always available)
 * Results are merged and de-duplicated by URL. If one provider is down the
 * tool still returns whatever the other found, and only fails when both do.
 */

async function duckduckgo(query, progress) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const { body } = await httpGet(url, { progress, headers: { accept: 'application/json' } });
  const data = JSON.parse(body);
  const results = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || '',
      snippet: data.AbstractText,
      source: data.AbstractSource || 'DuckDuckGo',
    });
  }
  const walk = (topics) => {
    for (const topic of topics ?? []) {
      if (topic.Topics) walk(topic.Topics);
      else if (topic.Text) {
        results.push({
          title: topic.Text.split(' - ')[0],
          url: topic.FirstURL || '',
          snippet: topic.Text,
          source: 'DuckDuckGo',
        });
      }
    }
  };
  walk(data.RelatedTopics);
  return results;
}

async function wikipedia(query, progress) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=6&srsearch=' +
    encodeURIComponent(query);
  const { body } = await httpGet(url, { progress, headers: { accept: 'application/json' } });
  const data = JSON.parse(body);
  return (data?.query?.search ?? []).map((hit) => ({
    title: hit.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
    snippet: hit.snippet ? hit.snippet.replace(/<[^>]+>/g, '') : '',
    source: 'Wikipedia',
  }));
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'compare', 'differ', 'do', 'does', 'for', 'from',
  'give', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'one', 'or', 'product', 'recommend', 'should', 'so',
  'that', 'the', 'their', 'them', 'then', 'this', 'to', 'up', 'us', 'was', 'what', 'when', 'which', 'why', 'with',
  'write', 'you', 'your',
]);

/**
 * Search engines answer keywords, not sentences. A goal pasted verbatim
 * ("Compare how SSE and WebSockets differ for streaming AI output, and
 * recommend one for a chat product") returns nothing from either provider, so
 * a zero-result response triggers one retry on the distinctive terms before
 * the tool reports failure.
 */
function simplify(query) {
  const words = String(query)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word.toLowerCase()));
  return words.slice(0, 6).join(' ');
}

async function gather(query, progress) {
  const settled = await Promise.allSettled([duckduckgo(query, progress), wikipedia(query, progress)]);
  const results = [];
  const seen = new Set();
  const failures = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failures.push(outcome.reason?.message ?? String(outcome.reason));
      continue;
    }
    for (const item of outcome.value) {
      const key = item.url || item.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push({ ...item, snippet: truncate(item.snippet, 400) });
    }
  }
  return { results, failures };
}

export default defineTool({
  name: 'web_search',
  title: 'Search the web',
  category: 'research',
  description:
    'Search the public web for a topic and return ranked results with title, URL and snippet. Use this first when the goal needs facts you do not already have. Keywords work far better than full sentences.',
  parameters: {
    query: { type: 'string', required: true, description: 'Search terms, phrased as you would type them into a search box.' },
    limit: { type: 'number', required: false, default: 5, min: 1, max: 10, description: 'How many results to return.' },
  },
  returns: 'A list of { title, url, snippet, source } plus the number of results found and the query that produced them.',
  signature: (input) => `web_search("${truncate(input.query ?? '', 60)}")`,

  async run({ query, limit = 5 }, ctx) {
    ctx.progress('Querying two search providers');
    let { results, failures } = await gather(query, ctx.progress);
    let usedQuery = query;
    let narrowed = false;

    if (!results.length && !failures.length) {
      const shorter = simplify(query);
      if (shorter && shorter.toLowerCase() !== query.toLowerCase()) {
        ctx.progress(`No hits for the full phrase — retrying with "${shorter}"`);
        const retry = await gather(shorter, ctx.progress);
        if (retry.results.length) {
          results = retry.results;
          failures = retry.failures;
          usedQuery = shorter;
          narrowed = true;
        }
      }
    }

    if (!results.length) {
      throw new ToolError(
        failures.length
          ? `No search results. Both providers failed: ${failures.join(' | ')}`
          : `No search results for "${query}", including a retry on the narrower terms "${simplify(query)}". Try different keywords.`,
        { kind: failures.length ? 'network_error' : 'empty_result', retriable: true },
      );
    }

    ctx.progress(`Merged ${results.length} results`);
    return {
      query: usedQuery,
      originalQuery: narrowed ? query : undefined,
      narrowed: narrowed || undefined,
      resultCount: results.length,
      degraded: failures.length ? `One provider failed: ${failures[0]}` : undefined,
      results: results.slice(0, limit),
    };
  },
});
