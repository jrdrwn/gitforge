// GraphQL v4 (POST /api/graphql): a small parser and executor for the documents gh and
// github-mcp-server actually send — viewer, repository fields, the __type feature probes, issue
// and pull-request reads, the create/close/merge mutations, node(id:) and batched operations.
// Unknown fields answer HTTP 200 with an errors array naming the field; unknown repositories
// answer data.repository = null with no errors; unauthenticated requests are 401.

import { Buffer } from 'node:buffer';
import { trialNowIso } from './scenario.ts';
import type { Issue, IssueComment, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- global ids

/** An opaque, stable Relay id: base64 of a type-prefixed key (never the plain database id). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
}

interface DecodedId {
  kind: string;
  key: string;
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class ParseError extends Error {}

class Lexer {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]+/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The next token, without consuming it. */
  peek(): string {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): string {
    this.skipIgnored();
    if (this.pos >= this.text.length) return '';
    const ch = this.text[this.pos] as string;
    if ('{}()[]:!$=@&|'.includes(ch)) {
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos] as string;
        if (c === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (c === '\\') {
          const esc = this.text[this.pos + 1] ?? '';
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          this.pos += 2;
          continue;
        }
        out += c;
        this.pos += 1;
      }
      throw new ParseError('unterminated string');
    }
    if (/[0-9-]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.text[this.pos] as string)) this.pos += 1;
      return this.text.slice(start, this.pos);
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos] as string)) this.pos += 1;
      return this.text.slice(start, this.pos);
    }
    if (ch === '.') {
      if (this.text.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        return '...';
      }
      throw new ParseError('unexpected dot');
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const token = lexer.next();
  if (token === '$') {
    return { kind: 'variable', name: lexer.next() };
  }
  if (token === '[') {
    const values: ValueNode[] = [];
    while (lexer.peek() !== ']') values.push(parseValue(lexer));
    lexer.expect(']');
    return { kind: 'list', values };
  }
  if (token === '{') {
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (lexer.peek() !== '}') {
      const name = lexer.next();
      lexer.expect(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    lexer.expect('}');
    return { kind: 'object', fields };
  }
  if (token.startsWith('"')) {
    return { kind: 'string', value: JSON.parse(token) as string };
  }
  if (token === 'true') return { kind: 'boolean', value: true };
  if (token === 'false') return { kind: 'boolean', value: false };
  if (token === 'null') return { kind: 'null' };
  if (/^-?[0-9]+$/.test(token)) return { kind: 'int', value: Number(token) };
  if (/^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$/.test(token)) return { kind: 'float', value: Number(token) };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return { kind: 'enum', value: token };
  throw new ParseError(`unexpected value token ${JSON.stringify(token)}`);
}

function parseSelectionSet(lexer: Lexer): SelectionNode[] {
  lexer.expect('{');
  const selections: SelectionNode[] = [];
  while (lexer.peek() !== '}') {
    if (lexer.peek() === '...') {
      lexer.next();
      const next = lexer.next();
      if (next === 'on') {
        const typeCondition = lexer.next();
        selections.push({ kind: 'fragment', typeCondition, selection: parseSelectionSet(lexer) });
      } else {
        selections.push({ kind: 'spread', name: next });
      }
      continue;
    }
    const first = lexer.next();
    let alias: string | null = null;
    let name = first;
    if (lexer.peek() === ':') {
      lexer.next();
      alias = first;
      name = lexer.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')') {
        const argName = lexer.next();
        lexer.expect(':');
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.expect(')');
    }
    let selection: SelectionNode[] | null = null;
    if (lexer.peek() === '{') selection = parseSelectionSet(lexer);
    selections.push({ kind: 'field', name, alias, args, selection });
  }
  lexer.expect('}');
  return selections;
}

function parseDocument(text: string): DocumentNode {
  const lexer = new Lexer(text);
  const operations: OperationNode[] = [];
  const fragments = new Map<string, FragmentDefinition>();
  while (lexer.peek() !== '') {
    const keyword = lexer.next();
    if (keyword === 'fragment') {
      const name = lexer.next();
      const on = lexer.next();
      if (on !== 'on') throw new ParseError('fragment needs "on"');
      const typeCondition = lexer.next();
      fragments.set(name, { name, typeCondition, selection: parseSelectionSet(lexer) });
      continue;
    }
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (keyword === 'query' || keyword === 'mutation') {
      operation = keyword;
      const next = lexer.peek();
      if (next !== '' && next !== '(' && next !== '{') name = lexer.next();
    } else if (keyword === '{') {
      // Shorthand query: the '{' was consumed as the "keyword"; re-parse from it.
      throw new ParseError('shorthand queries are not supported');
    } else {
      throw new ParseError(`unexpected definition ${JSON.stringify(keyword)}`);
    }
    const variables: string[] = [];
    if (lexer.peek() === '(') {
      lexer.next();
      let closed = false;
      while (!closed) {
        lexer.expect('$');
        variables.push(lexer.next());
        lexer.expect(':');
        // Skip the type: names, list brackets and '!' markers, until ',' or ')' at depth 0.
        let depth = 0;
        for (;;) {
          const token = lexer.next();
          if (token === '') throw new ParseError('unterminated variable definitions');
          if (token === '[') depth += 1;
          else if (token === ']') depth -= 1;
          else if (token === '=') parseValue(lexer);
          else if (depth === 0 && token === ',') break;
          else if (depth === 0 && token === ')') {
            closed = true;
            break;
          }
        }
      }
    }
    operations.push({ operation, name, variables, selection: parseSelectionSet(lexer) });
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- executor

export interface GraphQLContext {
  store: Store;
  viewer: string;
}

type GqlScalar = string | number | boolean | null;
type GqlValue = GqlScalar | GqlValue[] | GqlObject;
interface GqlObject {
  __gqlType: string;
  data: unknown;
}

function gqlObject(type: string, data: unknown): GqlObject {
  return { __gqlType: type, data };
}

function isGqlObject(value: GqlValue): value is GqlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__gqlType' in value;
}

interface Ctx {
  store: Store;
  viewer: string;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefinition>;
}

type Resolver = (source: GqlObject, args: Record<string, unknown>, ctx: Ctx) => GqlValue;

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'PULL_REQUEST', 'TOPIC', 'WIKI'];

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Ref: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  Mutation: 'OBJECT',
  SearchType: 'ENUM',
};

interface RepoRef {
  repo: Repo;
}

function repoOf(source: GqlObject): Repo {
  return (source.data as RepoRef).repo;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return gqlObject('Issue', { repo, issue });
}

function pullObject(repo: Repo, pull: PullRequest): GqlObject {
  return gqlObject('PullRequest', { repo, pull });
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, _args, ctx) => gqlObject('User', { login: ctx.viewer }),
    repository: (_source, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== ctx.viewer) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? gqlObject('Repository', { repo }) : null;
    },
    node: (_source, args, ctx) => {
      const decoded = decodeGlobalId(args.id as string);
      if (!decoded) return null;
      const { kind, key } = decoded;
      if (kind === 'Repository') {
        const slash = key.indexOf('/');
        if (slash < 0) return null;
        const repo = ctx.store.getRepo(key.slice(0, slash), key.slice(slash + 1));
        return repo ? gqlObject('Repository', { repo }) : null;
      }
      if (kind === 'Issue' || kind === 'PullRequest' || kind === 'IssueComment') {
        const hash = key.indexOf('#');
        if (hash < 0) return null;
        const fullName = key.slice(0, hash);
        const rest = key.slice(hash + 1);
        const slash = fullName.indexOf('/');
        if (slash < 0) return null;
        const repo = ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
        if (!repo) return null;
        if (kind === 'Issue') {
          const issue = repo.issues.find((entry) => entry.number === Number(rest));
          return issue ? issueObject(repo, issue) : null;
        }
        if (kind === 'PullRequest') {
          const pull = repo.pulls.find((entry) => entry.number === Number(rest));
          return pull ? pullObject(repo, pull) : null;
        }
        const colon = rest.indexOf(':');
        const issue = repo.issues.find((entry) => entry.number === Number(colon < 0 ? rest : rest.slice(0, colon)));
        if (!issue) return null;
        const comment = issue.comments.find((entry) => entry.id === Number(colon < 0 ? 0 : rest.slice(colon + 1)));
        return comment ? gqlObject('IssueComment', { repo, issue, comment }) : null;
      }
      return null;
    },
    __type: (_source, args, _ctx) => {
      const name = args.name as string;
      if (TYPE_FIELDS[name] !== undefined || name === 'SearchType') {
        return gqlObject('__Type', { name });
      }
      return null;
    },
  },
  User: {
    login: (source) => (source.data as { login: string }).login,
  },
  Repository: {
    id: (source) => repoGlobalId(repoOf(source)),
    databaseId: (source) => repoOf(source).id,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    owner: (source) => gqlObject('User', { login: repoOf(source).owner }),
    defaultBranchRef: (source, _args, ctx) => {
      const repo = repoOf(source);
      const tip = ctx.store.branchTip(repo, repo.defaultBranch);
      return tip === null ? null : gqlObject('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args, ctx) => {
      const repo = repoOf(source);
      const issue = ctx.store.getIssue(repo, args.number as number);
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (source, args, ctx) => {
      const repo = repoOf(source);
      let issues = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else {
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
      }
      const after = numberFromCursor(args.after as string | null | undefined);
      if (after !== null) issues = issues.filter((issue) => issue.number > after);
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const page = issues.slice(0, Math.max(0, first));
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
      return gqlObject('IssueConnection', {
        nodes: page.map((issue) => issueObject(repo, issue)),
        pageInfo: { hasNextPage, endCursor },
      });
    },
    pullRequests: (source, args, _ctx) => {
      const repo = repoOf(source);
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const nodes = [...repo.pulls].slice(0, Math.max(0, first)).map((pull) => pullObject(repo, pull));
      return gqlObject('PullRequestConnection', { nodes });
    },
    pullRequest: (source, args, ctx) => {
      const repo = repoOf(source);
      const pull = ctx.store.getPull(repo, args.number as number);
      return pull ? pullObject(repo, pull) : null;
    },
  },
  Ref: {
    name: (source) => (source.data as { name: string }).name,
  },
  Issue: {
    id: (source) => {
      const { repo, issue } = source.data as { repo: Repo; issue: Issue };
      return issueGlobalId(repo, issue);
    },
    number: (source) => (source.data as { issue: Issue }).issue.number,
    title: (source) => (source.data as { issue: Issue }).issue.title,
    state: (source) => issueState((source.data as { issue: Issue }).issue),
    body: (source) => (source.data as { issue: Issue }).issue.body,
  },
  IssueConnection: {
    nodes: (source) => (source.data as { nodes: GqlValue[] }).nodes,
    pageInfo: (source) => gqlObject('PageInfo', (source.data as { pageInfo: unknown }).pageInfo),
  },
  PageInfo: {
    hasNextPage: (source) => (source.data as { hasNextPage: boolean }).hasNextPage,
    endCursor: (source) => (source.data as { endCursor: string | null }).endCursor,
  },
  PullRequest: {
    id: (source) => {
      const { repo, pull } = source.data as { repo: Repo; pull: PullRequest };
      return pullGlobalId(repo, pull);
    },
    number: (source) => (source.data as { pull: PullRequest }).pull.number,
    state: (source) => pullState((source.data as { pull: PullRequest }).pull),
    merged: (source) => (source.data as { pull: PullRequest }).pull.merged,
    headRefName: (source) => (source.data as { pull: PullRequest }).pull.headRef,
    baseRefName: (source) => (source.data as { pull: PullRequest }).pull.baseRef,
    mergeable: (source, _args, ctx) => {
      const { repo, pull } = source.data as { repo: Repo; pull: PullRequest };
      if (pull.state !== 'open') return 'UNKNOWN';
      const { mergeable } = ctx.store.pullMergeable(repo, pull);
      return mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (source, args, ctx) => {
      const { repo, pull } = source.data as { repo: Repo; pull: PullRequest };
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = ctx.store.pullFiles(repo, pull).slice(0, Math.max(0, first));
      return gqlObject('PullRequestChangedFileConnection', {
        nodes: files.map((file) => gqlObject('PullRequestChangedFile', { path: file.filename })),
      });
    },
  },
  PullRequestConnection: {
    nodes: (source) => (source.data as { nodes: GqlValue[] }).nodes,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => (source.data as { nodes: GqlValue[] }).nodes,
  },
  PullRequestChangedFile: {
    path: (source) => (source.data as { path: string }).path,
  },
  IssueComment: {
    id: (source) => {
      const { repo, issue, comment } = source.data as { repo: Repo; issue: Issue; comment: IssueComment };
      return commentGlobalId(repo, issue, comment);
    },
    body: (source) => (source.data as { comment: IssueComment }).comment.body,
  },
  IssueCommentEdge: {
    node: (source) => (source.data as { node: GqlObject }).node,
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = args.input as { repositoryId: string; title: string; body?: string };
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not name a repository');
      const slash = decoded.key.indexOf('/');
      if (slash < 0) throw new Error('repositoryId does not name a repository');
      const repo = ctx.store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
      if (!repo) throw new Error('repository not found');
      const created = ctx.store.createIssue(repo, input.title, input.body ?? '', []);
      if ('error' in created) throw new Error(created.error);
      return gqlObject('CreateIssuePayload', { issue: issueObject(repo, created) });
    },
    closeIssue: (_source, args, ctx) => {
      const input = args.input as { issueId: string };
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error('issueId does not name an issue');
      const hash = decoded.key.indexOf('#');
      if (hash < 0) throw new Error('issueId does not name an issue');
      const fullName = decoded.key.slice(0, hash);
      const slash = fullName.indexOf('/');
      if (slash < 0) throw new Error('issueId does not name an issue');
      const repo = ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
      const issue = repo?.issues.find((entry) => entry.number === Number(decoded.key.slice(hash + 1)));
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = trialNowIso();
      issue.updatedAt = trialNowIso();
      return gqlObject('CloseIssuePayload', { issue: issueObject(repo, issue) });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = args.input as { repositoryId: string; baseRefName: string; headRefName: string; title: string; body?: string };
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not name a repository');
      const slash = decoded.key.indexOf('/');
      if (slash < 0) throw new Error('repositoryId does not name a repository');
      const repo = ctx.store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
      if (!repo) throw new Error('repository not found');
      const created = ctx.store.createPull(repo, input.headRefName, input.baseRefName, input.title, input.body ?? '');
      if ('error' in created) throw new Error(created.error);
      return gqlObject('CreatePullRequestPayload', { pullRequest: pullObject(repo, created) });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = args.input as { pullRequestId: string; mergeMethod?: string };
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('pullRequestId does not name a pull request');
      const hash = decoded.key.indexOf('#');
      if (hash < 0) throw new Error('pullRequestId does not name a pull request');
      const fullName = decoded.key.slice(0, hash);
      const slash = fullName.indexOf('/');
      if (slash < 0) throw new Error('pullRequestId does not name a pull request');
      const repo = ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
      const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.key.slice(hash + 1)));
      if (!repo || !pull) throw new Error('pull request not found');
      const merged = ctx.store.mergePull(repo, pull);
      if ('error' in merged) throw new Error(merged.error);
      return gqlObject('MergePullRequestPayload', { pullRequest: pullObject(repo, pull) });
    },
    addComment: (_source, args, ctx) => {
      const input = args.input as { subjectId: string; body: string };
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error('subjectId does not name an issue');
      const hash = decoded.key.indexOf('#');
      if (hash < 0) throw new Error('subjectId does not name an issue');
      const fullName = decoded.key.slice(0, hash);
      const slash = fullName.indexOf('/');
      if (slash < 0) throw new Error('subjectId does not name an issue');
      const repo = ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
      const issue = repo?.issues.find((entry) => entry.number === Number(decoded.key.slice(hash + 1)));
      if (!repo || !issue) throw new Error('issue not found');
      const comment: IssueComment = { id: repo.nextCommentId++, body: input.body, user: repo.owner };
      issue.comments.push(comment);
      return gqlObject('AddCommentPayload', { commentEdge: gqlObject('IssueCommentEdge', { node: gqlObject('IssueComment', { repo, issue, comment }) }) });
    },
  },
  CreateIssuePayload: {
    issue: (source) => (source.data as { issue: GqlObject }).issue,
  },
  CloseIssuePayload: {
    issue: (source) => (source.data as { issue: GqlObject }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => (source.data as { pullRequest: GqlObject }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => (source.data as { pullRequest: GqlObject }).pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (source) => (source.data as { commentEdge: GqlObject }).commentEdge,
  },
  __Type: {
    name: (source) => (source.data as { name: string }).name,
    kind: (source) => TYPE_KINDS[(source.data as { name: string }).name] ?? 'OBJECT',
    fields: (source) => {
      const name = (source.data as { name: string }).name;
      if (name === 'SearchType') return null;
      return (TYPE_FIELDS[name] ?? []).map((field) => gqlObject('__Field', { name: field }));
    },
    enumValues: (source) => {
      const name = (source.data as { name: string }).name;
      if (name !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((value) => gqlObject('__EnumValue', { name: value }));
    },
  },
  __Field: {
    name: (source) => (source.data as { name: string }).name,
  },
  __EnumValue: {
    name: (source) => (source.data as { name: string }).name,
  },
};

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function executeSelection(
  selections: readonly SelectionNode[],
  typeName: string,
  source: GqlObject,
  variables: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = RESOLVERS[typeName] ?? {};
  const fieldNames = TYPE_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        Object.assign(out, executeSelection(fragment.selection, typeName, source, variables, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(selection.selection, typeName, source, variables, ctx));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = typeResolvers[selection.name];
    if (!resolver || !fieldNames.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: GqlValue;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (selection.selection === null) {
      out[responseKey] = isGqlObject(value) ? null : value;
      continue;
    }
    out[responseKey] = executeValue(selection.selection, value, variables, ctx);
  }
  return out;
}

function executeValue(
  selections: readonly SelectionNode[],
  value: GqlValue,
  variables: Record<string, unknown>,
  ctx: Ctx,
): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(selections, entry, variables, ctx));
  if (isGqlObject(value)) return executeSelection(selections, value.__gqlType, value, variables, ctx);
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(
  document: DocumentNode,
  operation: OperationNode,
  variables: Record<string, unknown>,
  ctx: Ctx,
): GraphQLResult {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root = gqlObject(rootType, {});
  const data = executeSelection(operation.selection, rootType, root, variables, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/**
 * Execute one GraphQL request body ({query, variables, operationName} or an array of them for
 * batching). Returns a single result or an array of results, in order.
 */
export function handleGraphQL(
  store: Store,
  viewer: string,
  body: unknown,
): GraphQLResult | GraphQLResult[] {
  const runOne = (entry: unknown): GraphQLResult => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'request body must be a JSON object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'request body must carry a query string' }] };
    }
    const variables = (record.variables as Record<string, unknown> | undefined) ?? {};
    let document: DocumentNode;
    try {
      document = parseDocument(record.query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    let operation: OperationNode | undefined;
    if (typeof record.operationName === 'string') {
      operation = document.operations.find((entry) => entry.name === record.operationName);
    }
    operation ??= document.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'the document holds no operation' }] };
    const ctx: Ctx = { store, viewer, errors: [], fragments: document.fragments };
    return executeOperation(document, operation, variables, ctx);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
