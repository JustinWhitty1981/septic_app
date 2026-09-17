"""
Run etl/transform/*.sql against the app database, in filename order, as ONE
transaction.

This file contains no transformation logic on purpose (ETL-06). A Python transform
would be unreviewable at this size — 48,216 rows of decisions nobody can read in a
diff — and it would not roll back as a unit if it failed on row 40,000. Every
decision lives in a .sql file next to the reason for it.

    python3 etl/run_transforms.py

-1 wraps the whole run in BEGIN/COMMIT, and ON_ERROR_STOP makes psql stop at the
first error rather than carrying on with a half-built ledger. Together they mean the
database is either fully transformed or untouched.
"""

import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TRANSFORMS = REPO / "etl" / "transform"

SERVICE = "postgres"
DB = {
    "user": os.environ.get("DATABASE_USER", "septic_dev"),
    "dbname": os.environ.get("DATABASE_NAME", "septic"),
}

# Tables the transform is expected to have populated, in dependency order.
REPORT = [
    "pumpers", "waste_types", "service_types", "counties", "county_alias",
    "septic_system_types", "disposal_sites", "baffle_materials",
    "payers", "properties", "property_ownerships", "tanks", "service_events",
    "invoices", "invoice_lines", "payments", "inspections", "import_quarantine",
]


def psql(sql: str) -> str:
    r = subprocess.run(
        ["docker", "compose", "exec", "-T", SERVICE,
         "psql", "-U", DB["user"], "-d", DB["dbname"], "-v", "ON_ERROR_STOP=1", "-t", "-A", "-f", "-"],
        input=sql.encode(), capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace") or r.stdout.decode())
    return r.stdout.decode().strip()


def main() -> int:
    files = sorted(TRANSFORMS.glob("*.sql"))
    if not files:
        print(f"no SQL in {TRANSFORMS}", file=sys.stderr)
        return 1

    print(f"running {len(files)} transform(s) against '{DB['dbname']}' in one transaction\n")
    script = "\n".join(
        f"\n-- >>> {f.name} " + "-" * max(0, 60 - len(f.name)) + f"\n\\echo   ok  {f.name}"
        f"\n{f.read_text(encoding='utf-8')}"
        for f in files
    )

    r = subprocess.run(
        ["docker", "compose", "exec", "-T", SERVICE,
         "psql", "-U", DB["user"], "-d", DB["dbname"],
         "-v", "ON_ERROR_STOP=1", "-1", "-q", "-f", "-"],
        input=script.encode(), capture_output=True,
    )
    if r.returncode != 0:
        err = (r.stderr.decode(errors="replace") + r.stdout.decode(errors="replace")).strip()
        print("\nROLLED BACK — nothing was written.\n", file=sys.stderr)
        print(err, file=sys.stderr)
        return 1

    for line in r.stdout.decode(errors="replace").splitlines():
        if line.strip():
            print(" ", line.strip())

    print("\nseptic_app row counts")
    for t in REPORT:
        print(f"  {t:22} {psql(f'SELECT count(*) FROM septic_app.{t};'):>8}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
