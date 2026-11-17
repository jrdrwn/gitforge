// MCP (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28. The suite's client
// opens with server/discover (no handshake), then tools/list and tools/call. Six tools act on
// the same store as REST, so a repository or issue created over MCP reads back over /api/v3 as
// the same object. Unknown tools answer -32602 or -32601, never HTTP 500; a body that is not
// JSON answers HTTP 400 with -32700; no Authorization answers 401.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Repo, Store } from './store.ts';

export const MCP_SERVER_NAME = 'gitforge';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tool list, fixed at module load: two tools/list calls answer the same array byte for
 * byte. Property names are the canonical ones the suite documents, so its argument mapping is
 * a straight pass-through.
 */
export const MCP_TOOLS: readonly ToolSchema[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

export interface McpResponse {
  status: number;
  body: string | null;
}

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean };

function toolOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(store: Store, viewer: string, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner !== viewer) return null;
  return store.getRepo(owner, name) ?? null;
}

function callTool(store: Store, viewer: string, baseUrl: string, name: string, args: Record<string, unknown>): ToolResult {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewer;
      const repoName = args.name as string;
      if (owner !== viewer) return toolError(`cannot create a repository for ${owner}`);
      if (store.getRepo(owner, repoName)) return toolError(`Repository ${owner}/${repoName} already exists`);
      const repo = store.createRepo(owner, repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolOk(repoJson(repo, baseUrl));
    }
    case 'get_repo': {
      const repo = repoFor(store, viewer, args.owner, args.repo);
      if (!repo) return toolError('Repository not found');
      return toolOk(repoJson(repo, baseUrl));
    }
    case 'create_issue': {
      const repo = repoFor(store, viewer, args.owner, args.repo);
      if (!repo) return toolError('Repository not found');
      const created = store.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(created.error);
      return toolOk(issueJson(created, repo, baseUrl));
    }
    case 'list_issues': {
      const repo = repoFor(store, viewer, args.owner, args.repo);
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(issue, repo, baseUrl));
      return { content: [{ type: 'text', text: JSON.stringify(issues) }], structuredContent: { issues } };
    }
    case 'create_pull_request': {
      const repo = repoFor(store, viewer, args.owner, args.repo);
      if (!repo) return toolError('Repository not found');
      const created = store.createPull(repo, args.head as string, args.base as string, args.title as string, typeof args.body === 'string' ? args.body : '');
      if ('error' in created) return toolError(created.error);
      return toolOk(pullJson(created, repo, baseUrl));
    }
    case 'merge_pull_request': {
      const repo = repoFor(store, viewer, args.owner, args.repo);
      if (!repo) return toolError('Repository not found');
      const pull = store.getPull(repo, Number(args.pull_number));
      if (!pull) return toolError('Pull request not found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolOk({ sha: merged.sha, merged: true, message: `Pull Request #${pull.number} successfully merged`, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Extract a JSON-RPC id from a body that failed to parse, so the -32700 names it. */
function idFromRaw(raw: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(raw);
  if (!match) return null;
  const token = match[1] as string;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  return Number(token);
}

/**
 * Handle one POST /mcp body. `raw` is the request body as text (kept so a parse failure can
 * still answer -32700 with the request's id). Returns the HTTP status and the JSON body, or a
 * null body for a notification.
 */
export function handleMcp(store: Store, viewer: string, baseUrl: string, raw: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { status: 400, body: rpcError(idFromRaw(raw), -32700, 'Parse error') };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const record = body as Record<string, unknown>;
  const method = record.method;
  const id = record.id;
  const hasId = id !== undefined && id !== null;

  // A notification (no id) gets no JSON-RPC answer.
  if (typeof method === 'string' && !hasId) {
    return { status: 202, body: null };
  }
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id ?? null, -32600, 'Invalid Request') };
  }
  const params = (record.params as Record<string, unknown> | undefined) ?? {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...MCP_SUPPORTED_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      };
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        }),
      };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
    }
    case 'tools/call': {
      const toolName = params.name;
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      if (typeof toolName !== 'string' || toolName === '') {
        return { status: 200, body: rpcError(id, -32602, 'tools/call needs a tool name') };
      }
      const known = MCP_TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      }
      const result = callTool(store, viewer, baseUrl, toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    default: {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}
