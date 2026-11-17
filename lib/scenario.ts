// The suite's seeded scenario, re-derived the way the conformance suite derives it: one fixed
// seed (SCENARIO_SEED) feeds named streams, and the 'users' stream names the viewer. The token the
// suite presents is opaque, so the server learns who the token belongs to by replaying this
// generation at startup: the viewer is always the first user of the 'users' stream.
//
// The generator is the suite's own: FNV-1a over the label, splitmix64's finalizer, and an
// xorshift64* stream. Only the first three logins are needed (viewer, teammate, stranger), but the
// whole 12-user list is derived so the shape matches.

const U64_MASK = 0xffffffffffffffffn;
/** The one seed every generated name derives from; the contest's fixed data. */
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** The scenario's day one, 2025-01-01T00:00:00Z, the fallback clock when no trial now is set. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** `count` users with unique logins, deterministic for the stream. */
export function generateUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The login the suite's bearer token names. */
export const VIEWER_LOGIN: string = USERS[0]?.login ?? 'adaiversen';
/** The viewer's full identity, for commit authors and user objects. */
export const VIEWER: ScenarioUser = USERS[0] ?? { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
/** The teammate login (second user); any other owner is a stranger to this token. */
export const TEAMMATE_LOGIN: string = USERS[1]?.login ?? 'quinnkeller';
/** The stranger login (third user). */
export const STRANGER_LOGIN: string = USERS[2]?.login ?? 'olgabauer';

/**
 * The trial's clock: MAKEFUN_TRIAL_NOW is the instance's opening time and the only "now" a
 * request may carry, so every timestamp the forge stores or sends derives from it. It may be an
 * ISO string, epoch seconds, or epoch milliseconds; without it the scenario epoch is used, so a
 * local run is deterministic too. No wall clock is ever read.
 */
export function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return SCENARIO_EPOCH_SEC;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // Epoch milliseconds are past 1e12; epoch seconds are near 1.7e9.
    return Math.trunc(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  return SCENARIO_EPOCH_SEC;
}

/** The trial now as an ISO-8601 string, for created_at / merged_at and friends. */
export function trialNowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}
