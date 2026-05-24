"""Load the matchup engine data into the production Supabase project.

Reads rates.db, aggregates to per-(player, year, hand) outcome counts for
the modern era (2020-2024), and posts batches to PostgREST. Pulls player
ID mapping from the Chadwick Bureau register and uploads that too.

Usage:
  SUPABASE_URL=https://...  SUPABASE_KEY=<anon-or-service-role-key> \
    PYTHONPATH=. venv/bin/python scripts/load_to_supabase.py

The SUPABASE_URL and SUPABASE_KEY come from the Supabase project dashboard
(or the MCP `get_project_url` / `get_publishable_keys` tools). The anon
key works because the tables enable open SELECT/INSERT for the demo.
"""
from __future__ import annotations

import json
import os
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

import certifi

# macOS framework Python doesn't expose system CA certificates to urllib;
# pin our requests to certifi's bundle so HTTPS to Supabase works.
_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

REPO_ROOT = Path(__file__).resolve().parent.parent
RATES_DB = REPO_ROOT / "data" / "processed" / "rates.db"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

FIRST_YEAR = 2020
LAST_YEAR = 2024
MIN_PA = 25
BATCH_SIZE = 500


def post_rows(table: str, rows: list[dict]) -> None:
    """POST a batch of rows to PostgREST. Raises on HTTP error."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(rows).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60, context=_SSL_CONTEXT) as resp:
            if resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status}: {resp.read()[:300]}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read()[:300]}")


def load_table(table: str, rows: list[tuple], columns: list[str]) -> None:
    print(f"Loading {table}: {len(rows):,} rows in batches of {BATCH_SIZE}")
    sent = 0
    start = time.time()
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        payload = [dict(zip(columns, r)) for r in batch]
        post_rows(table, payload)
        sent += len(batch)
        if (i // BATCH_SIZE) % 20 == 0 or sent == len(rows):
            elapsed = time.time() - start
            print(f"  {sent:>6,}/{len(rows):<6,}  ({elapsed:.0f}s)")
    print(f"  done: {sent:,} rows in {time.time() - start:.0f}s")


def aggregate_rates(conn: sqlite3.Connection):
    bat = conn.execute(
        "SELECT batter, year, bats, throws AS vs_hand, outcome, COUNT(*) "
        "FROM at_bats WHERE year BETWEEN ? AND ? "
        "GROUP BY batter, year, bats, throws, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()
    pit = conn.execute(
        "SELECT pitcher, year, throws, bats AS vs_hand, outcome, COUNT(*) "
        "FROM at_bats WHERE year BETWEEN ? AND ? "
        "GROUP BY pitcher, year, throws, bats, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()
    lge = conn.execute(
        "SELECT year, bats, throws, outcome, COUNT(*) "
        "FROM at_bats WHERE year BETWEEN ? AND ? "
        "GROUP BY year, bats, throws, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()
    return bat, pit, lge


def filter_by_pa(rows: list[tuple], key_index: tuple[int, int],
                 min_pa: int) -> list[tuple]:
    totals: dict[tuple, int] = defaultdict(int)
    for r in rows:
        totals[(r[key_index[0]], r[key_index[1]])] += r[-1]
    return [r for r in rows
            if totals[(r[key_index[0]], r[key_index[1]])] >= min_pa]


def fetch_chadwick(retros: set[str]) -> list[tuple]:
    print(f"Fetching Chadwick register for {len(retros):,} retro ids...")
    from pybaseball import chadwick_register
    df = chadwick_register()
    df = df[df["key_retro"].isin(retros) & df["key_mlbam"].notna()]
    out: list[tuple] = []
    seen: set[int] = set()
    for _, r in df.iterrows():
        mlbam = int(r["key_mlbam"])
        if mlbam in seen:
            continue
        seen.add(mlbam)
        out.append((
            mlbam,
            r["key_retro"] or None,
            (r.get("name_first") or "").strip() or None,
            (r.get("name_last") or "").strip() or None,
        ))
    return out


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("SUPABASE_URL and SUPABASE_KEY env vars are required")

    print(f"Reading {RATES_DB}")
    conn = sqlite3.connect(f"file:{RATES_DB}?mode=ro", uri=True)

    bat, pit, lge = aggregate_rates(conn)
    bat = filter_by_pa(bat, (0, 1), MIN_PA)
    pit = filter_by_pa(pit, (0, 1), MIN_PA)
    print(f"After filter: batter={len(bat):,} pitcher={len(pit):,} league={len(lge):,}")

    load_table("league_rates",  lge,
               ["year", "bats", "throws", "outcome", "n"])
    load_table("batter_rates",  bat,
               ["batter", "year", "bats", "vs_hand", "outcome", "n"])
    load_table("pitcher_rates", pit,
               ["pitcher", "year", "throws", "vs_hand", "outcome", "n"])

    retros = set(r[0] for r in bat) | set(r[0] for r in pit)
    players = fetch_chadwick(retros)
    print(f"Matched {len(players):,} players in Chadwick register")
    load_table("players", players,
               ["mlbam", "retrosheet", "name_first", "name_last"])

    print("\nDone — all four tables loaded.")


if __name__ == "__main__":
    main()
