#!/usr/bin/env python3
"""
Load the legacy CSVs verbatim into schema `legacy` of the **app** database.

ETL-07: this used to target a separate `legacy-db` container. It does not, because a
transform that has to reach across two servers cannot share a transaction with the
rows it writes, and a load that cannot be rolled back as one unit is not reviewable.
The `legacy-db` service has been deleted from docker-compose.yml to keep this from
drifting back.

This is a SCRATCH LANDING ZONE, not the target model. Every column is TEXT and
nothing is normalised, deduped, or cleaned. Its only jobs are to (a) prove the
CSVs parse, and (b) give every later transform in etl/*.sql a queryable copy of
the real source rows to check itself against. Transforms are SQL; this file is not
a transform, it is a pipe (ETL-06).

    python3 etl/load_legacy.py

Why COPY FROM STDIN rather than INSERT batches: Postgres' own CSV parser handles
RFC-4180 quoting, embedded newlines and embedded commas correctly. That property
IS the test -- `wc -l` reports 28,870 "lines" for tblCustomers.csv, which has only
7,541 records, because `Memo` and `Tank Location` contain newlines inside quoted
fields. If Postgres' row count matches the count Python's csv module reports, the
parse is correct.

Files are UTF-8 WITH BOM; the BOM is stripped here because Postgres would otherwise
fold it into the first column's name (ETL-05).
"""

import csv
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"

# tblSystem.csv holds only the legacy shared plaintext password. The design doc
# discards it (docs/DATA_MODEL.md s12) and it is being rotated, so it is not loaded.
SKIP = {"tblSystem.csv"}

SERVICE = "postgres"
# Same defaults docker-compose.yml uses, so a host run and a container run agree.
DB = {
    "user": os.environ.get("DATABASE_USER", "septic_dev"),
    "dbname": os.environ.get("DATABASE_NAME", "septic"),
}

# The files and the row counts established by profiling. A mismatch is a hard
# failure, not a warning: it means the CSV was mis-parsed.
EXPECTED_ROWS = {
    "tblCustDumpLog.csv": 48216,
    "tblCustomers.csv": 7541,
    "tblBilling.csv": 7572,
    "tblInvoiceAmount.csv": 6590,
    "tblInvoices.csv": 3283,
    "tblInspectionDate.csv": 2771,
    "tblInvoiceDetails.csv": 99,
    "tblOwner.csv": 7,
    "tblWasteTypes.csv": 9,
}


def snake(name: str) -> str:
    """Don't Send Reminder: -> dont_send_reminder"""
    s = name.lstrip("\ufeff").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    if not s:
        s = "col"
    return "c_" + s if s[0].isdigit() else s


# ETL-01. Idempotency is only a claim if something can notice it being false, so
# every load records an order-independent content hash per table. A re-run that
# changes any byte is a hard failure rather than a surprise found in review.
MANIFEST_DDL = """
CREATE TABLE IF NOT EXISTS legacy.load_manifest (
  source_file text PRIMARY KEY,
  table_name  text NOT NULL,
  row_count   int  NOT NULL,
  columns     text NOT NULL,
  checksum    text NOT NULL,
  loaded_at   timestamptz NOT NULL DEFAULT now()
);"""


def checksum(table: str) -> str:
    """md5 over the sorted text of every row.

    Sorting by the row's own text makes the value independent of physical order,
    so it does not move when rows are re-inserted, vacuumed or rewritten. Without
    that, a genuinely idempotent load would report drift.
    """
    return psql(
        f"SELECT md5(string_agg(t::text, E'\\n' ORDER BY t::text)) FROM legacy.{table} t"
    )


def manifest() -> dict[str, tuple[int, str, str]]:
    """Previously recorded {source_file: (row_count, columns, checksum)}."""
    out = {}
    for line in psql(
        "SELECT source_file||chr(31)||row_count||chr(31)||columns||chr(31)||checksum "
        "FROM legacy.load_manifest"
    ).splitlines():
        parts = line.split(chr(31))
        if len(parts) == 4:
            out[parts[0]] = (int(parts[1]), parts[2], parts[3])
    return out


def psql(sql: str) -> str:
    """Run SQL in the legacy-db container, return stdout."""
    return _run(sql, None)


def psql_stdin(sql: str, payload: bytes) -> str:
    """Run SQL with raw bytes on STDIN, for COPY ... FROM STDIN."""
    return _run(sql, payload)


def _run(sql: str, payload: bytes | None) -> str:
    cmd = ["docker", "compose", "exec", "-T", SERVICE,
           "psql", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-U", DB["user"],
           "-d", DB["dbname"], "-c", sql]
    r = subprocess.run(cmd, cwd=REPO, input=payload, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace") or r.stdout.decode())
    return r.stdout.decode().strip()


def main() -> int:
    csvs = sorted(p for p in DATA.glob("*.csv") if p.name not in SKIP)
    if not csvs:
        print(f"no CSVs in {DATA} - data/ is gitignored, restore it first", file=sys.stderr)
        return 1

    print(f"landing {len(csvs)} files into schema 'legacy' of '{DB['dbname']}'\n")

    # ETL-07 guard. The whole point of the retarget is that landing and transforms
    # share one database, so refuse to load anywhere the app schema is absent. This
    # is what stops the loader drifting back onto a stray server and "succeeding".
    try:
        app_tables = int(psql(
            "SELECT count(*) FROM information_schema.tables "
            "WHERE table_schema = 'septic_app'"))
    except RuntimeError as exc:
        print(f"cannot reach {DB['dbname']} on service {SERVICE}: {exc}", file=sys.stderr)
        return 1
    if app_tables == 0:
        print(f"'{DB['dbname']}' has no septic_app schema - wrong database. "
              f"Start the stack and run npm run migrate first.", file=sys.stderr)
        return 1
    print(f"  target verified: {app_tables} septic_app tables present\n")

    # DDL: one all-TEXT table per file, columns derived from that file's own
    # header, so table shape can never drift from the data loaded into it.
    ddl = ["CREATE SCHEMA IF NOT EXISTS legacy;", MANIFEST_DDL]
    for path in csvs:
        with path.open(encoding="utf-8-sig", newline="") as fh:
            hdr = next(csv.reader(fh))
        table = path.stem.lower()
        cols, seen = [], set()
        for h in hdr:
            c = snake(h)
            while c in seen:        # two headers can normalise to the same name
                c += "_x"
            seen.add(c)
            cols.append(c)
        ddl.append(f"DROP TABLE IF EXISTS legacy.{table};")
        ddl.append("CREATE TABLE legacy.{0} (\n  {1}\n);".format(
            table, ",\n  ".join('"{0}" text'.format(c) for c in cols)))
    psql("\n".join(ddl))

    failures = []
    landed: dict[str, dict] = {}
    for path in csvs:
        table = path.stem.lower()

        # ground truth: what Python's csv module says the record count is
        with path.open(encoding="utf-8-sig", newline="") as fh:
            py_rows = sum(1 for _ in csv.DictReader(fh))

        raw = path.read_bytes().lstrip(b"\xef\xbb\xbf")      # strip BOM
        psql_stdin(
            f"COPY legacy.{table} FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')",
            raw,
        )
        db_rows = int(psql(f"SELECT count(*) FROM legacy.{table};"))

        expect = EXPECTED_ROWS.get(path.name)
        ok = db_rows == py_rows and (expect is None or db_rows == expect)
        print(f"  {'ok' if ok else 'MISMATCH':8} {table:22} {db_rows:>7,} rows  "
              f"(csv module: {py_rows:,})")
        if not ok:
            failures.append((path.name, db_rows, py_rows, expect))

        landed[path.name] = {"table": table, "rows": db_rows, "checksum": checksum(table)}

    print(f"\n  skipped: {', '.join(sorted(SKIP))} (legacy shared password, discarded by design)")

    if failures:
        print("\nROW COUNT MISMATCH - the CSV did not parse cleanly:", file=sys.stderr)
        for name, d, p, e in failures:
            print(f"  {name}: postgres={d:,} csv-module={p:,} expected={e}", file=sys.stderr)
        return 1

    # ETL-01: idempotency, checked *before* the previous record is overwritten.
    # If replaying the same files produced different bytes, that is a loader bug
    # and the run must fail rather than quietly "correct" the earlier result.
    prev = manifest()
    drift = []
    for name, rec in landed.items():
        rec["columns"] = psql(
            "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) "
            "FROM information_schema.columns "
            f"WHERE table_schema = 'legacy' AND table_name = '{rec['table']}'")
        now_ = (rec["rows"], rec["columns"], rec["checksum"])
        if prev.get(name) is not None and prev[name] != now_:
            drift.append((name, prev[name], now_))

    if drift:
        print("\nNOT IDEMPOTENT - replaying the same files changed the result:", file=sys.stderr)
        for name, was, now_ in drift:
            print(f"  {name}: was {was[0]:,} rows {was[2][:10]}…, now {now_[0]:,} rows {now_[2][:10]}…",
                  file=sys.stderr)
        return 1

    psql("\n".join(
        "INSERT INTO legacy.load_manifest"
        " (source_file, table_name, row_count, columns, checksum)"
        f" VALUES ('{name}', '{rec['table']}', {rec['rows']}, '{rec['columns']}',"
        f" '{rec['checksum']}')"
        " ON CONFLICT (source_file) DO UPDATE"
        "   SET table_name = EXCLUDED.table_name, row_count = EXCLUDED.row_count,"
        "       columns = EXCLUDED.columns, checksum = EXCLUDED.checksum,"
        "       loaded_at = now();"
        for name, rec in landed.items()
    ))
    print(f"\nidempotent: {len(landed)} table checksums "
          f"{'matched the previous load' if prev else 'recorded (first load)'}")

    print("\nall row counts agree between the csv module and postgres.")
    print(f"  docker compose exec postgres psql -U {DB['user']} -d {DB['dbname']} \\dn legacy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
