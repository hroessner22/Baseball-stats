"""The batter-versus-pitcher matchup engine — ingest, scouting, predictions.

Ingests every available Retrosheet event season (play-by-play and game info)
into the rate store, then for each marquee batter prints a multi-dimensional
**scouting report** — traditional BA / OBP / SLG / OPS / wOBA across every
matrix dimension we capture (handedness, count, base-out, rest, day/night) —
and for each marquee matchup prints the engine's predicted plate-appearance
outcome distribution, side-by-side with the rates that produced it.

Run from the repository root:

    python -m src.run_matchup
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from src.engine.matchup import Matchup, predict_matchup
from src.engine.rates import (
    RateLine,
    batter_line,
    open_rate_store,
    pitcher_pitch_mix,
    pitcher_velocity,
    stored_pitch_years,
    stored_rate_years,
    write_at_bats,
    write_games,
)
from src.ingest.download import download_event_seasons
from src.ingest.events import (
    OUTCOMES,
    compute_rest,
    load_rosters,
    parse_events,
    parse_games,
)

FIRST_SEASON = 1910
LAST_SEASON = 2024
REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
RATE_STORE_PATH = REPO_ROOT / "data" / "processed" / "rates.db"

# Marquee players for the scouting reports.
DEMO_BATTERS = ["judga001", "ohtas001", "sotoj001"]
# Marquee matchups to predict — (batter id, pitcher id).
DEMO_MATCHUPS = [
    ("judga001", "skubt001"),  # Aaron Judge   vs Tarik Skubal
    ("ohtas001", "ceasd001"),  # Shohei Ohtani vs Dylan Cease
    ("sotoj001", "salec001"),  # Juan Soto     vs Chris Sale
]

# Demo pitcher Retrosheet id → MLBAM id (used to look up Statcast pitch data).
PITCHER_MLBAM = {
    "skubt001": 669373,  # Tarik Skubal
    "ceasd001": 656302,  # Dylan Cease
    "salec001": 519242,  # Chris Sale
}

# The splits each scouting report shows. Each entry is a label + filter dict
# passed to ``batter_line``. Empty splits (no PA matched) are skipped.
SCOUTING_SPLITS = [
    ("Overall",            {}),
    ("vs RHP",             {"throws": "R"}),
    ("vs LHP",             {"throws": "L"}),
    ("Runners in scoring", {"risp": True}),
    ("With 2 outs",        {"outs": 2}),
    ("0-strike counts",    {"strikes": 0}),
    ("2-strike counts",    {"strikes": 2}),
    ("3-1 count",          {"count": (3, 1)}),
    ("0 days rest",        {"batter_days_rest": 0}),
    ("1 day rest",         {"batter_days_rest": 1}),
    ("2+ days rest",       {"batter_days_rest_range": (2, 30)}),
    ("Day games",          {"daynight": "D"}),
    ("Night games",        {"daynight": "N"}),
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
            at_bats = compute_rest(at_bats)
            games = parse_games(events_dir, year)
        except Exception as error:  # one bad season must not stop the run
            print(f"  {year}: could not parse — {error}")
            continue
        if at_bats:
            write_at_bats(conn, year, at_bats)
            write_games(conn, year, games)
            print(f"  {year}: {len(at_bats):>7,} PA, {len(games):>5,} games")
        else:
            print(f"  {year}: no event data — skipped")


def _three(value: float) -> str:
    """Format a rate stat as the classic three-decimal baseball line.

    ``.284`` for sub-1.0 rates; ``1.351`` when the rate exceeds 1.0
    (slugging in select situations can; on-base mathematically cannot).
    """
    if value >= 1.0:
        return f"{value:.3f}"
    return f".{int(round(value * 1000)):03d}"


def _slash_line(line: RateLine) -> str:
    """Render a RateLine as ``PA  .BA/.OBP/.SLG  OPS x.xxx  wOBA x.xxx``."""
    return (
        f"{line.total:>5,} PA  "
        f"{_three(line.ba)}/{_three(line.obp)}/{_three(line.slg)}  "
        f"OPS {line.ops:5.3f}  wOBA {line.woba:5.3f}"
    )


def print_scouting_report(
    conn: sqlite3.Connection,
    batter: str,
    names: dict[str, str],
    year_range: tuple[int, int],
) -> None:
    """Print a multi-dimensional scouting report for a batter."""
    name = names.get(batter, batter)
    start, end = year_range
    print(f"\n── {name} ({batter}) — scouting report  {start}-{end}")
    for label, filters in SCOUTING_SPLITS:
        line = batter_line(conn, batter, year_range=year_range, **filters)
        if line.total == 0:
            continue
        print(f"  {label:24}  {_slash_line(line)}")


def _print_matchup(
    matchup: Matchup,
    names: dict[str, str],
    conn: sqlite3.Connection | None = None,
    year_range: tuple[int, int] | None = None,
) -> None:
    """Print one matchup — the prediction beside the rates that produced it.

    If ``conn`` and ``year_range`` are given and the pitcher has Statcast
    data, the pitch mix and average velocities are appended.
    """
    batter = names.get(matchup.batter, matchup.batter)
    pitcher = names.get(matchup.pitcher, matchup.pitcher)
    print(f"\n{batter} ({matchup.bats}HB)  vs  {pitcher} ({matchup.throws}HP)")
    print(f"  {matchup.batter_rates.total:,} PA vs {matchup.throws}HP   |   "
          f"{matchup.pitcher_rates.total:,} batters faced vs {matchup.bats}HB")
    print(f"  {'':9}{'batter':>9}{'pitcher':>9}{'league':>9}{'PREDICT':>9}")
    for outcome in OUTCOMES:
        print(f"  {outcome:<9}"
              f"{100 * matchup.batter_rates.rate(outcome):8.1f}%"
              f"{100 * matchup.pitcher_rates.rate(outcome):8.1f}%"
              f"{100 * matchup.league.rate(outcome):8.1f}%"
              f"{100 * matchup.chance(outcome):8.1f}%")

    pitcher_mlbam = PITCHER_MLBAM.get(matchup.pitcher)
    if pitcher_mlbam is None or conn is None or year_range is None:
        return
    mix = pitcher_pitch_mix(conn, pitcher_mlbam, year_range, bats=matchup.bats)
    if not mix:
        return
    velos = pitcher_velocity(conn, pitcher_mlbam, year_range)
    total = sum(mix.values())
    print(f"\n  Pitch mix vs {matchup.bats}HB (Statcast, {total:,} pitches):")
    for name, cnt in mix.items():
        share = 100 * cnt / total
        vel = velos.get(name, 0)
        velo_text = f"   {vel:5.1f} mph avg" if vel else ""
        print(f"    {name:25} {share:5.1f}%{velo_text}")


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

    print(f"\n┃ Scouting reports, {demo_start}-{high}")
    for batter in DEMO_BATTERS:
        print_scouting_report(conn, batter, names, (demo_start, high))

    print(f"\n┃ Predicted plate-appearance outcomes, {demo_start}-{high}")
    pitch_low, pitch_high, _ = stored_pitch_years(conn)
    statcast_range = (
        (max(demo_start, pitch_low), min(high, pitch_high))
        if pitch_low and pitch_high else None
    )
    for batter, pitcher in DEMO_MATCHUPS:
        matchup = predict_matchup(conn, batter, pitcher, demo_start, high)
        _print_matchup(matchup, names, conn=conn, year_range=statcast_range)

    conn.close()


if __name__ == "__main__":
    main()
