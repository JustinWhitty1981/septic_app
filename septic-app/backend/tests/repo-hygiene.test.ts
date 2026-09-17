import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * NF-01 / NF-02 — things that should be impossible, enforced mechanically.
 *
 * Scope note: the backend container only mounts the backend tree, so this suite
 * can only see the backend. The repository-wide credential scan is the separate
 * host-side `npm run audit:secrets`, which can see README.md and docker-compose.yml.
 */
const SRC = join(__dirname, '..', 'src');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|js)$/.test(f))
    .map((f) => join(dir, f));

describe('NF-02 / P10: application code never reads the clock directly', () => {
  // current_date in a query looks harmless and is correct in production, which is
  // exactly why it survives review — it is wrong only against the frozen legacy
  // snapshot, where it silently returns nonsense. business_today() is the only
  // permitted source of "today".
  it('no current_date, systimestamp or localtimestamp in src/', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => /\bcurrent_date\b|\bsystimestamp\b|\blocaltimestamp\b/i.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC + '/', ''));
    expect(offenders).toEqual([]);
  });
});

describe('NF-01: no credentials in the backend tree', () => {
  // Patterns that are unambiguously secrets wherever they appear.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
    ['private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['password inside a connection string', /[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s/@]+@/i],
    ['a signed JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];

  it('no tracked source file contains a secret-shaped string', () => {
    const hits: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const body = readFileSync(f, 'utf8');
      for (const [label, re] of FORBIDDEN) if (re.test(body)) hits.push(`${f}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it('ships a .env.example so a new clone is not guesswork', () => {
    expect(existsSync(join(__dirname, '..', '.env.example'))).toBe(true);
  });

  // The recurring onboarding trap: someone adds a variable to .env, it works on
  // their machine, and the next clone fails with a missing-env-var error that
  // points nowhere. Only key names are ever read here, never values.
  it('every key in the local .env is documented in .env.example', () => {
    const keysOf = (p: string) =>
      existsSync(p)
        ? readFileSync(p, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
            .map((l) => l.split('=')[0])
        : [];
    const root = join(__dirname, '..');
    const example = keysOf(join(root, '.env.example'));
    expect(example.length).toBeGreaterThan(0);
    const undocumented = keysOf(join(root, '.env')).filter((k) => !example.includes(k));
    expect(undocumented).toEqual([]);
  });

  // The one place a literal secret is acceptable: a fallback that only applies to
  // local development, and even then it must be the documented one.
  it('the only JWT fallback is the documented development placeholder', () => {
    const body = readFileSync(join(SRC, 'config', 'auth.ts'), 'utf8');
    expect(body).toContain('dev-secret-change-in-production');
    // ...and it must be a fallback, never the whole value.
    expect(body).toMatch(/process\.env\.JWT_SECRET\s*\|\|/);
  });
});

/**
 * Documentation drift, caught mechanically.
 *
 * `backend/README.md` was rewritten on 2026-08-30 because it had become fiction: it told people to
 * run `npm run migration:run` (no such script), gave default passwords for accounts that were never
 * seeded, listed ten tables that had been deliberately deleted, and named 2 of the routes that
 * existed. Review did not catch it. A prose warning would not either, because the failure mode is
 * quiet — the README stays plausible while the code moves away from it.
 *
 * So the three claims that can be checked from here are checked. They are the ones that were wrong.
 *
 * Scope: the container mounts only the backend tree, so the repository root's README.md and docs/
 * are not visible and are not asserted. Those are covered by `scripts/audit-secrets.sh` for secrets
 * and by `tests/requirements.todo.test.ts` for the requirement tables.
 */
const ROUTES_DIR = join(SRC, 'routes');
const README_PATH = join(__dirname, '..', 'README.md');

describe('Documentation does not drift from the code it describes', () => {
  const readme = readFileSync(README_PATH, 'utf8');

  /**
   * The real surface, composed the way Express composes it: index.ts mounts sub-routers and each
   * file declares paths relative to its mount point. Reading the router is the only way to know,
   * because a README is a copy of it and copies go stale.
   */
  function mountedRoutes(): string[] {
    const index = readFileSync(join(ROUTES_DIR, 'index.ts'), 'utf8');
    const found: string[] = [];

    for (const m of index.matchAll(/router\.(?:get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
      found.push(`/api${m[1]}`);
    }

    for (const m of index.matchAll(/router\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
      const [, mount, symbol] = m;
      const imported = index.match(
        new RegExp(`import\\s+${symbol}\\s+from\\s+'\\./([^']+)'`),
      );
      if (!imported) throw new Error(`route router "${symbol}" is mounted but not imported`);
      const body = readFileSync(join(ROUTES_DIR, `${imported[1]}.ts`), 'utf8');
      for (const r of body.matchAll(/router\.(?:get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
        found.push(`/api${mount}${r[1] === '/' ? '' : r[1]}`);
      }
    }
    return found;
  }

  it('every route the server mounts is documented', () => {
    const missing = mountedRoutes().filter((p) => !readme.includes(p));
    // A route that exists but is not written down is a feature nobody will use.
    expect(missing).toEqual([]);
  });

  it('the README advertises no route the server does not mount', () => {
    const real = new Set(mountedRoutes());
    // The other direction, and the more dangerous one: a documented endpoint that has been
    // removed sends a caller to a 404 and costs them an afternoon. `/api/*` is prose, not a path.
    const claimed = [...readme.matchAll(/`(\/api\/[^`]*)`/g)]
      .map((m) => m[1].replace(/\/+$/, ''))
      .filter((p) => !p.includes('*'))
      .filter((p) => !real.has(p));
    expect(claimed).toEqual([]);
  });

  it('every npm command in a README code block is a real script', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const scripts = pkg.scripts ?? {};
    // Only fenced blocks: prose is allowed to name a script that was removed, and this file does
    // exactly that to warn about it. A copy-pasteable command is not allowed to.
    const commands = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .flatMap((block) => [...block[1].matchAll(/npm run ([\w:-]+)|npm (?:run )?(test|build|start)/g)])
      .map((m) => m[1] ?? m[2] ?? m[0]);
    const unknown = [...new Set(commands)].filter((c) => !(c in scripts));
    expect(unknown).toEqual([]);
  });

  it('the entity count the README states is the count that exists', () => {
    // `ls src/models | wc -l` says 18. The truth is 20, because lookups.ts declares five entities
    // in one file and enums.ts declares none. Counting files is how the old README got this wrong.
    const actual = sourceFiles(join(SRC, 'models'))
      .reduce((n, f) => n + (readFileSync(f, 'utf8').match(/@Entity\(/g) ?? []).length, 0);
    const stated = [...readme.matchAll(/(\d+)\s+(?:TypeORM\s+)?entities/g)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    for (const s of stated) expect(s).toBe(actual);
  });
});

