"""The batter-versus-pitcher matchup engine — ingest and demonstration.

Ingests every available Retrosheet event season (play-by-play) into the rate
store, then predicts plate-appearance outcomes for a handful of marquee
matchups — each shown beside the batter's, the pitcher's, and the league's own
rates, so the prediction explains itself.

Run from the repository root:

    python -m src.run_matchup
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from src.engine.matchup import Matchup, predict_matchup
from src.engine.rates import (
    open_rate_store,
    stored_rate_years,
    tally_season,
    write_season,
)
from src.ingest.download import download_event_seasons
from src.ingest.events import OUTCOMES, load_rosters, parse_events

FIRST_SEASON = 1910
LAST_SEASON = 2024
REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
RATE_STORE_PATH = REPO_ROOT / "data" / "processed" / "rates.db"

# Marquee matchups to demonstrate — (batter id, pitcher id), Retrosheet ids.
DEMO_MATCHUPS = [
    ("judga001", "skubt001"),  # Aaron Judge   vs Tarik Skubal
    ("ohtas001", "ceasd001"),  # Shohei Ohtani vs Dylan Cease
    ("sotoj001", "salec001"),  # Juan Soto     vs Chris Sale
]


def ingest(conn: sqlite3.Connection) -> None:
    """Download, parse, and store every event season in the range."""
    print(f"Ingesting event seasons {FIRST_SEASON}-{LAST_SEASON} "
          f"(the first run downloads ~115 archives)...\n")
    for year, events_dir in download_event_seasons(
        FIRST_SEASON, LAST_SEASON, RAW_DIR
    ):
        try:
            at_bats = parse_events(events_dir, year)
        except Exception as error:  # one bad season must not stop the run
            print(f"  {year}: could not parse — {error}")
            continue
        if at_bats:
            write_season(conn, year, tally_season(at_bats))
            print(f"  {year}: {len(at_bats):>7,} plate appearances")
        else:
            print(f"  {year}: no event data — skipped")


def _print_matchup(matchup: Matchup, names: dict[str, str]) -> None:
    """Print one matchup — the prediction beside the rates that produced it."""
    batter = names.get(matchup.batter, matchup.batter)
    pitcher = names.get(matchup.pitcher, matchup.pitcher)
    print(f"{batter} ({matchup.bats}HB)  vs  {pitcher} ({matchup.throws}HP)")
    print(f"  {matchup.batter_rates.total:,} PA vs {matchup.throws}HP   |   "
          f"{matchup.pitcher_rates.total:,} batters faced vs {matchup.bats}HB")
    print(f"  {'':9}{'batter':>9}{'pitcher':>9}{'league':>9}{'PREDICT':>9}")
    for outcome in OUTCOMES:
        print(f"  {outcome:<9}"
              f"{100 * matchup.batter_rates.rate(outcome):8.1f}%"
              f"{100 * matchup.pitcher_rates.rate(outcome):8.1f}%"
              f"{100 * matchup.league.rate(outcome):8.1f}%"
              f"{100 * matchup.chance(outcome):8.1f}%")
    print()


def main() -> None:
    print("The batter-versus-pitcher matchup engine\n")

    conn = open_rate_store(RATE_STORE_PATH)
    ingest(conn)

    low, high, count = stored_rate_years(conn)
    if count == 0:
        print("\nNo seasons were ingested — cannot demonstrate matchups.")
        conn.close()
        return
    print(f"\nStored {count} seasons of play-by-play ({low}-{high}).")

    names = load_rosters(RAW_DIR / f"events{high}")
    demo_start = max(low, high - 4)
    print(f"\nPredicted plate-appearance outcomes, {demo_start}-{high}:\n")
    for batter, pitcher in DEMO_MATCHUPS:
        matchup = predict_matchup(conn, batter, pitcher, demo_start, high)
        _print_matchup(matchup, names)

    conn.close()


if __name__ == "__main__":
    main()
