"""Phase 2 — the historical win-expectancy engine.

Ingests every available Retrosheet season into a SQLite store of per-year
win-expectancy aggregates, then demonstrates the era toggle: the win-
expectancy table for any year range — a single season to all of history —
produced in a single fast query.

Run from the repository root:

    python -m src.run_phase2
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from src.engine.store import open_store, query_range, stored_years, write_year
from src.engine.win_expectancy import Table, build_table, format_table
from src.ingest.download import download_seasons
from src.ingest.gamelog import parse_gamelog

FIRST_SEASON = 1871
LAST_SEASON = 2025
REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
STORE_PATH = REPO_ROOT / "data" / "processed" / "win_expectancy.db"


def _home_win_rate(table: Table) -> float:
    """Overall home win rate — every game has one 'end of the top of the 1st' state."""
    wins = sum(c.wins for (inn, half, _), c in table.items()
               if inn == 1 and half == "top")
    total = sum(c.total for (inn, half, _), c in table.items()
                if inn == 1 and half == "top")
    return 100.0 * wins / total if total else 0.0


def ingest(conn: sqlite3.Connection) -> list[int]:
    """Download, parse, and store every season; return the seasons with no data.

    Some 19th-century seasons carry only final scores in Retrosheet's game
    logs — no inning-by-inning line scores — so they yield no game states and
    cannot contribute to an inning-level table.
    """
    print(f"Ingesting seasons {FIRST_SEASON}-{LAST_SEASON} "
          f"(the first run downloads ~150 files)...\n")
    empty: list[int] = []
    for year, path in download_seasons(FIRST_SEASON, LAST_SEASON, RAW_DIR):
        states = parse_gamelog(path)
        if states:
            write_year(conn, year, build_table(states))
            print(f"  {year}: {len(states):>7,} game states")
        else:
            empty.append(year)
            print(f"  {year}: no inning-level line scores — skipped")
    return empty


def main() -> None:
    print("Phase 2 — historical win-expectancy engine\n")

    conn = open_store(STORE_PATH)
    empty = ingest(conn)

    low, high, count = stored_years(conn)
    print(f"\nStored {count} seasons with inning-level data ({low}-{high}).")
    if empty:
        print(f"{len(empty)} early seasons had only final scores in Retrosheet's "
              f"game logs — no line scores, so no inning detail to use.")

    # The headline: the win-expectancy table over all of history.
    print(f"\nWin-expectancy table — all of history ({low}-{high}):\n")
    print(format_table(query_range(conn, low, high)) + "\n")

    # The era toggle: the same engine, sliced by era — each in one fast query.
    print("The era toggle — overall home win rate by era:\n")
    for start, end in [(low, 1900), (1901, 1940), (1941, 1980),
                       (1981, 2010), (2011, high)]:
        clock = time.perf_counter()
        table = query_range(conn, start, end)
        elapsed_ms = (time.perf_counter() - clock) * 1000
        print(f"  {start}-{end}:  home wins {_home_win_rate(table):.1f}%"
              f"   (query took {elapsed_ms:.1f} ms)")

    conn.close()


if __name__ == "__main__":
    main()
