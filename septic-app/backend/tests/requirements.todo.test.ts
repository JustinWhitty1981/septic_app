import { join } from 'path';

/**
 * Unbuilt requirements, as failing-by-default tests.
 *
 * A feature that does not exist cannot be unit tested, and a test that asserts
 * nothing is worse than none because it reports green. So these are `it.todo`:
 * they do not pass, they are counted by jest, and they name the requirement they
 * are waiting for. `npm test` output is therefore the build checklist — when you
 * implement DRV-07 you delete its todo line and write the real test in its place.
 *
 * IDs refer to docs/REQUIREMENTS.md.
 */
const PENDING: Array<[string, string]> = [
  // The checklist is fully built or manual-only: the bids sprint (BIL-09..16)
  // shipped 2026-09-04, and the remaining ⬜ rows — DRV-02, DRV-19, SCH-07,
  // LED-06 — are procedures a browser or a phone verifies, not jest. A new
  // ⬜ that jest could eventually cover goes back on this list, and the row
  // flips to ✅ in the same commit that deletes the line.
];

describe('Unbuilt requirements (docs/REQUIREMENTS.md)', () => {
  if (PENDING.length === 0) {
    // Jest refuses an empty suite, and silence would look like coverage:
    // state the actual news instead.
    it('nothing is pending — every ⬜ row is manual-only', () => {
      expect(PENDING).toHaveLength(0);
    });
  }
  for (const [id, text] of PENDING) it.todo(`${id}: ${text}`);
});

// Guards the checklist itself: a requirement cannot be marked built by quietly
// deleting its todo line, and the document cannot claim a status its tests do
// not back up. The document is mounted read-only at /docs in the dev container,
// so these assertions always run — a guard clause that skips when the file is
// missing would make the whole block pass vacuously.
const IDS = PENDING.map(([id]) => id);

const DOC = join(__dirname, '..', '..', '..', 'docs', 'REQUIREMENTS.md');

/**
 * Rows whose ✅ is deliberately qualified, so 🟡 is correct despite a ✅ in Verify.
 *
 * AUT-06 and DRV-15 are here because a test pins a *known defect* — the code does the wrong
 * thing, the test proves it, and the row stays open until somebody decides which behaviour is
 * wanted. (AUT-06 left this set on 2026-08-30 when the character class was widened; the
 * defect is fixed and its test now asserts the fix.)
 *
 * DRV-12 is here for a reason that is not about code at all. Its queue, its driver controls
 * and its unsent-work indicator are built and asserted, including the case a walk-through
 * cannot reach: a tap made with no signal that lands when the signal returns. What stands
 * between it and ✅ is that the app is served over http:// to handsets on a VPN, which the
 * Secure Contexts spec does not list as trustworthy, so no browser will store the shell at
 * all. The notes and photos endpoints have since shipped; what keeps the media story half-told is
 * that the upload goes direct — queueing the photo path against the 16 MB parser is open.
 * A row cannot be ✅ while the deployment refuses the feature.
 *
 * DRV-03/04/05/10/11 were a fifth kind, and they left this set when the component harness
 * arrived. Each is worded as something a driver *sees*, and for the life of this repository
 * nothing had ever rendered a component in a test: the payload half was asserted against the
 * database row it came from and the rendering half was a todo. Saying so is why they were 🟡
 * rather than ✅, and it was the right call while it was true — marking them ✅ on payload
 * evidence alone would have made the checklist read as though a person had looked at a phone.
 * `StopCard.render.test.tsx` closes that gap against real records (property 1193's
 * `4-100 Pits`, property 7309's two customer numbers, property 4813's `Brothertown`), and
 * every one of the five was checked by mutating the thing its test is supposed to catch.
 */
const QUALIFIED = new Set([
  // DRV-15 left on 2026-08-31: the pipeline half (T-DRV-15b) landed, so both
  // halves are asserted and the row is honestly ✅.
  'DRV-12',
]);

type Row = { id: string; st: string; verify: string };

function parseDoc(): Row[] {
  const { readFileSync, existsSync } = require('fs');
  if (!existsSync(DOC)) {
    throw new Error(
      `Cannot read ${DOC}. The docs tree must be mounted read-only in the backend ` +
      `container (see docker-compose.yml). Refusing to pass silently.`
    );
  }
  const rows: Row[] = [];
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*((?:AUT|DRV|SCH|LED|BIL|ETL|NF)-\d+)\s*\|\s*(✅|🟡|⬜)\s*\|/);
    if (!m) continue;
    const cells = line.split('|');
    rows.push({ id: m[1], st: m[2], verify: cells[cells.length - 2] });
  }
  return rows;
}

/** Requirement ids referenced in a Verify cell as pending, or as built. */
function refs(verify: string, kind: 'built' | 'pending'): string[] {
  const re = kind === 'built'
    ? /`T-([A-Z]+-\d+b?)`\s*✅/g
    : /`T-([A-Z]+-\d+b?)`\s*\(pending\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(verify))) out.push(m[1]);
  return out;
}

describe('Checklist integrity', () => {
  const doc = parseDoc();

  it('has no duplicate requirement ids', () => {
    expect(IDS.filter((id, i) => IDS.indexOf(id) !== i)).toEqual([]);
    // The rows, not just the todo list: two features were shipped under DRV-20
    // on the strength of a test that only inspected PENDING, which has been
    // empty since the checklist filled. A duplicated id means two rows answer
    // to one name, and the traceability the §9 table counts is a fiction.
    const ids = doc.map((r) => r.id);
    expect([...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]).toEqual([]);
  });

  it('has a status glyph on every requirement row', () => {
    expect(doc.length).toBeGreaterThan(0);
    expect(doc.filter((r) => !['✅', '🟡', '⬜'].includes(r.st)).map((r) => r.id)).toEqual([]);
  });

  // The strong form, in both directions: the todo list and the document's
  // `(pending)` markers must be the same set. Either half drifting alone is a bug.
  it('lists exactly the requirements the document marks pending', () => {
    const fromDoc = new Set<string>();
    for (const r of doc) refs(r.verify, 'pending').forEach((id) => fromDoc.add(id));
    expect(IDS.filter((id) => !fromDoc.has(id))).toEqual([]);   // retired todo
    expect([...fromDoc].filter((id) => !IDS.includes(id))).toEqual([]); // undocumented todo
  });

  it('marks 🟡 only the requirements whose partial state is reviewed', () => {
    const amber = doc.filter((r) => r.st === '🟡').map((r) => r.id);
    expect(amber.sort()).toEqual([...QUALIFIED].sort());
  });

  it('gives every row a status its Verify cell supports', () => {
    const bad: string[] = [];
    for (const r of doc) {
      const check = /✅/.test(r.verify);
      const pending = /\(pending\)/.test(r.verify);
      // Evidence is either an automated test (`T-…`) or a named host script.
      const evidence = /`T-/.test(r.verify) || /`\.?\/?[\w./-]+\.(sh|sql|py)`/.test(r.verify);

      if (QUALIFIED.has(r.id)) {
        if (r.st !== '🟡') bad.push(`${r.id}: qualified row must be 🟡, is ${r.st}`);
        continue;
      }
      if (check && pending) bad.push(`${r.id}: mixed ✅ and (pending) — must be a reviewed 🟡 row`);

      // Manual-only rows have no automated evidence either way, so their status is
      // a recorded judgement. Still constrain it to a meaningful pair.
      if (!check && !pending) {
        if (!['⬜', '✅'].includes(r.st)) bad.push(`${r.id}: manual-only row is ${r.st}`);
        if (!/manual/.test(r.verify)) bad.push(`${r.id}: no evidence and no stated procedure`);
        continue;
      }
      if (r.st === '✅' && !(check && !pending)) bad.push(`${r.id}: ✅ but Verify is "${r.verify.trim()}"`);
      if (r.st === '✅' && !evidence) bad.push(`${r.id}: ✅ names no test and no script`);
      if (r.st === '⬜' && !(pending && !check)) bad.push(`${r.id}: ⬜ but Verify is "${r.verify.trim()}"`);
    }
    expect(bad).toEqual([]);
  });

  // The counts table in §9 is asserted, not maintained by hand. It drifted once
  // already when it was prose.
  it('reports the measured counts in §9', () => {
    const { readFileSync } = require('fs');
    const body = readFileSync(DOC, 'utf8');
    const want: Record<string, number> = {
      'Requirements': doc.length,
      '✅ built and verified': doc.filter((r) => r.st === '✅').length,
      '🟡 partially verified': doc.filter((r) => r.st === '🟡').length,
      '⬜ not built': doc.filter((r) => r.st === '⬜').length,
      'Pending, tracked as `it.todo`': IDS.length,
      'Manual procedure only': doc.filter((r) => /manual/.test(r.verify)).length,
    };
    const wrong: string[] = [];
    for (const [label, n] of Object.entries(want)) {
      const m = body.match(new RegExp(`\\|\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*(\\d+)\\s*\\|`));
      if (!m) wrong.push(`${label}: row missing from §9`);
      else if (Number(m[1]) !== n) wrong.push(`${label}: doc says ${m[1]}, measured ${n}`);
    }
    expect(wrong).toEqual([]);
  });
});
