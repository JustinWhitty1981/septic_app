module.exports = {
  testEnvironment: 'node',
  // src/models/*.ts use TypeORM decorators, which need Reflect metadata present
  // before the entity modules are evaluated.
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // tsconfig.json sets rootDir: ./src and excludes tests/; override both so
        // ts-jest can compile specs without changing what `npm run build` emits.
        tsconfig: { rootDir: '.', declaration: false, declarationMap: false },
      },
    ],
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // Seed the stage props (sites, a bench of properties, payers) that the
  // suites assume exist, so the suite passes on a blank migrated database
  // as well as on the corpus one. No-op there — see tests/bootstrap.ts.
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  // bcrypt costs 12 rounds (~300ms per hash) and several tests hash repeatedly.
  testTimeout: 30000,
  /**
   * One suite at a time. This is not a performance setting and must not be "fixed".
   *
   * These are integration tests against one shared dev database, and several of them need a
   * property that is not already booked on today's route. They find one the only way they
   * can — `SELECT ... WHERE NOT EXISTS (route_stops ...) ORDER BY id LIMIT 1`, then a
   * separate `POST /routes/:id/stops` — and that is a check and an insert with a window
   * between them. Under jest's default parallel workers, two suites pick the same site in
   * that window and one gets a 409 from `uq_stop_one_open_route`.
   *
   * Measured before this was written, three consecutive `npm test` runs: 2 failures, 0
   * failures, 16 failures. The same code, the same database, a different worker schedule
   * each time. The failure lands in whichever suite lost the race, which is why it was
   * believed to be a flake in `route-composition.test.ts` specifically — it was not, and a
   * checklist whose tests fail a third of the time is not a checklist, because the first
   * thing a red run teaches everybody is to run it again rather than to read it.
   *
   * `dispatch-api.test.ts` already guards this inside one file with a `chosen` array, and
   * that guard is real but file-local: it cannot see another worker's inserts. Serialising is
   * the honest fix, and it costs about 20 seconds. The alternative — a reservation table, or
   * `FOR UPDATE SKIP LOCKED` against a table the conflict is not actually on — would be the
   * right answer if the suite ever grows past the point where 59 seconds matters.
   */
  maxWorkers: 1,
};
