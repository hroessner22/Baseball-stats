"""Upload per-count rate CSVs into Supabase via PostgREST.

Reads the gzipped CSVs produced by `python -m src.build_rates_by_count`
and POSTs them to batter_rates_by_count / pitcher_rates_by_count in
~5000-row batches. Uses Prefer: resolution=merge-duplicates so reruns
are safe (each row's PK is (player, hand, balls, strikes, outcome) and
existing rows get their `n` overwritten — fine for a deterministic
aggregation; the source data only changes when we rebuild the script).

Run locally (needs the SERVICE key — anon can't write to these tables):
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
        python -m src.upload_rates_by_count
"""
from __future__ import annotations

import csv
import gzip
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import certifi


BATTER_CSV  = Path("data/processed/batter_rates_by_count.csv.gz")
PITCHER_CSV = Path("data/processed/pitcher_rates_by_count.csv.gz")
BATCH_SIZE = 5000  # rows per POST; Supabase REST handles this comfortably


def _ssl_ctx() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def upload(table: str, rows: list[dict], url: str, key: str) -> int:
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}",
        data=body,
        method="POST",
        headers={
            "apikey":         key,
            "Authorization":  f"Bearer {key}",
            "Content-Type":   "application/json",
            # merge-duplicates: existing PKs get their `n` overwritten.
            # That's correct for a deterministic re-aggregation — if you
            # rebuild from the same pitches table you should get the
            # same numbers, and a re-upload should silently no-op
            # mathematically.
            "Prefer":         "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=120) as r:
        if r.status not in (200, 201):
            raise RuntimeError(f"HTTP {r.status}")
    return len(rows)


def upload_csv(table: str, path: Path, url: str, key: str) -> None:
    print(f"\nUploading {path.name} → {table} ...")
    if not path.exists():
        print(f"  missing {path}, skipping.")
        return

    t0 = time.time()
    batch: list[dict] = []
    sent = 0
    with gzip.open(path, "rt", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Cast numeric fields explicitly — PostgREST is type-strict
            # and a string "3" would fail the SMALLINT column.
            row[next(iter(row))] = int(row[next(iter(row))])  # mlbam
            for k in ("balls", "strikes", "n"):
                row[k] = int(row[k])
            batch.append(row)
            if len(batch) >= BATCH_SIZE:
                try:
                    upload(table, batch, url, key)
                except urllib.error.HTTPError as e:
                    msg = (e.read() or b"").decode("utf-8", errors="replace")[:500]
                    print(f"  batch failed at {sent + len(batch):,}: HTTP {e.code}: {msg}",
                          file=sys.stderr)
                    return
                sent += len(batch)
                batch.clear()
                elapsed = time.time() - t0
                print(f"  {sent:,} rows uploaded  [{elapsed:.1f}s]")
        if batch:
            try:
                upload(table, batch, url, key)
            except urllib.error.HTTPError as e:
                msg = (e.read() or b"").decode("utf-8", errors="replace")[:500]
                print(f"  final batch failed: HTTP {e.code}: {msg}", file=sys.stderr)
                return
            sent += len(batch)

    print(f"  done: {sent:,} rows in {time.time() - t0:.1f}s")


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment. "
            "Upload requires the service_role key (write-grant, anon won't work).",
            file=sys.stderr,
        )
        return 2

    upload_csv("batter_rates_by_count",  BATTER_CSV,  url, key)
    upload_csv("pitcher_rates_by_count", PITCHER_CSV, url, key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
