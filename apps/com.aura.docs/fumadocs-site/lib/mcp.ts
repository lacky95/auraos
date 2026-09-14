/**
 * The Aura Docs MCP server — read-only access to this site's pages for
 * agents. Advertised by the `provides` entry in app.manifest.json and
 * reachable at `/mcp` through the shell proxy.
 *
 * Content comes from the same fumadocs `source` the site renders from, so
 * the tools can never drift from what a human reads. Page bodies are the
 * MDX source on disk: an agent wants the text (headings, code fences, links)
 * rather than a React tree, and `source` only hands out a compiled component.
 *
 * Stateless and JSON-only, same reasoning as the Notepad MCP
 * (apps/com.aura.notepad/src/mcp/serve.ts): there is nowhere durable to keep
 * a session in a dev server that restarts on every file change, and these
 * tools are plain request/response.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { source } from './source';

const CONTENT_DIR = join(process.cwd(), 'content/docs');

interface DocPage {
  /** Site path, e.g. `/docs/quick-start` — also the id `get_doc` takes. */
  url: string;
  title: string;
  description: string;
  /** Path of the .mdx file relative to content/docs. */
  file: string;
}

function pages(): DocPage[] {
  return source.getPages().map((p) => ({
    url: p.url,
    title: String(p.data.title ?? p.file.name),
    description: String(p.data.description ?? ''),
    file: p.file.path,
  }));
}

/**
 * MDX source without the frontmatter block — title and description are
 * returned as their own fields, and the `---` fence is noise to a reader.
 */
async function body(page: DocPage): Promise<string> {
  const raw = await readFile(join(CONTENT_DIR, page.file), 'utf8');
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
}

/** Accepts `/docs/quick-start`, `docs/quick-start`, `quick-start`, or the file name. */
function findPage(all: DocPage[], ref: string): DocPage | undefined {
  const want = ref.trim().replace(/^\/+/, '').replace(/\.mdx$/, '');
  return all.find((p) => {
    const url = p.url.replace(/^\/+/, '');
    return url === want
      || url === `docs/${want}`
      || p.file.replace(/\.mdx$/, '') === want
      || p.title.toLowerCase() === want.toLowerCase();
  });
}

/**
 * Line-level match with a little context, so a hit shows why it matched.
 * Lines carrying every term come first; a page that only matches across
 * separate lines (or in its title) still gets context from single-term
 * lines rather than coming back with nothing to show.
 */
function snippets(text: string, terms: string[], max: number): string[] {
  const lines = text.split('\n');
  const context = (i: number) => lines.slice(Math.max(0, i - 1), i + 2).join(' ').trim().slice(0, 300);
  const all: string[] = [];
  const partial: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (terms.every((t) => low.includes(t))) { if (all.length < max) all.push(context(i)); }
    else if (partial.length < max && terms.some((t) => low.includes(t))) partial.push(context(i));
    if (all.length >= max) break;
  }
  return [...all, ...partial].slice(0, max);
}

const SEARCH = z.object({
  query: z.string().min(1).describe('Words to look for. All must appear (case-insensitive).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max pages to return. Default 10.'),
});
const GET = z.object({
  page: z.string().min(1).describe('Page url (/docs/quick-start), slug (quick-start) or title.'),
});

const TOOLS: { name: string; title: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: 'list_docs',
    title: 'List documentation pages',
    description: 'Every page of the Aura documentation with its url, title and description. Start here to see what exists.',
    schema: z.object({}),
  },
  {
    name: 'search_docs',
    title: 'Search documentation',
    description: 'Find pages whose title, description or body contain all the given words. Returns matching lines as context.',
    schema: SEARCH,
  },
  {
    name: 'get_doc',
    title: 'Read a documentation page',
    description: 'The full Markdown source of one page, addressed by url, slug or title.',
    schema: GET,
  },
];

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const failure = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

export function buildDocsServer(): Server {
  const server = new Server(
    { name: 'aura-docs', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, title, description, schema }): Tool => ({
      name,
      title,
      description,
      inputSchema: zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Tool['inputSchema'],
      annotations: { readOnlyHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    const all = pages();

    if (req.params.name === 'list_docs') {
      return text(JSON.stringify({ total: all.length, pages: all.map(({ url, title, description }) => ({ url, title, description })) }, null, 2));
    }

    if (req.params.name === 'search_docs') {
      const parsed = SEARCH.safeParse(args);
      if (!parsed.success) return failure(`Invalid arguments: ${parsed.error.message}`);
      const terms = parsed.data.query.toLowerCase().split(/\s+/).filter(Boolean);
      const limit = parsed.data.limit ?? 10;
      const results = [];
      for (const page of all) {
        const content = await body(page);
        const haystack = `${page.title}\n${page.description}\n${content}`.toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) continue;
        results.push({
          url: page.url,
          title: page.title,
          description: page.description,
          matches: snippets(content, terms, 3),
        });
        if (results.length >= limit) break;
      }
      return text(JSON.stringify({ query: parsed.data.query, totalResults: results.length, results }, null, 2));
    }

    if (req.params.name === 'get_doc') {
      const parsed = GET.safeParse(args);
      if (!parsed.success) return failure(`Invalid arguments: ${parsed.error.message}`);
      const page = findPage(all, parsed.data.page);
      if (!page) {
        return failure(`No page '${parsed.data.page}'. Known pages: ${all.map((p) => p.url).join(', ')}`);
      }
      return text(JSON.stringify({ url: page.url, title: page.title, description: page.description, content: await body(page) }, null, 2));
    }

    return failure(`Unknown tool: ${req.params.name}`);
  });

  return server;
}
