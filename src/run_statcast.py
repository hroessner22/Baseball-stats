"""Statcast pitch-level ingestion — modern era only (2015+).

Statcast began with the 2015 season. This runner downloads pitch-level data
for the recent window we care about most (default 2020-2024) via pybaseball
and writes it into the ``pitches`` table of the rate store.

Run from the repository root:

    python -m src.run_statcast
"""
from __future__ import annotations

import time
from pathlib import Path

from src.engine.rates import (
    open_rate_store,
    stored_pitch_years,
    write_pitches,
)
from src.ingest.statcast import fetch_season

FIRST_STATCAST_SEASON = 2020
LAST_STATCAST_SEASON = 2024
REPO_ROOT = Path(__file__).resolve().parent.parent
RATE_STORE_PATH = REPO_ROOT / "data" / "processed" / "rates.db"


def main() -> None:
    print(f"Ingesting Statcast pitches "
          f"{FIRST_STATCAST_SEASON}-{LAST_STATCAST_SEASON}\n")
    conn = open_rate_store(RATE_STORE_PATH)
    for year in range(FIRST_STATCAST_SEASON, LAST_STATCAST_SEASON + 1):
        clock = time.perf_counter()
        try:
            df = fetch_season(year)
        except Exception as error:
            print(f"  {year}: download failed — {error}")
            continue
        dl = time.perf_counter() - clock
        if df is None or len(df) == 0:
            print(f"  {year}: no Statcast data")
            continue
        clock = time.perf_counter()
        write_pitches(conn, year, df)
        wr = time.perf_counter() - clock
        print(f"  {year}: {len(df):>8,} pitches  "
              f"(download {dl:>4.0f}s, write {wr:>3.0f}s)")
    low, high, count = stored_pitch_years(conn)
    print(f"\nStored {count} seasons of Statcast pitches ({low}-{high}).")
    conn.close()


if __name__ == "__main__":
    main()
