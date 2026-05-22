"""Phase 1 — the proof-of-concept win-expectancy engine.

Downloads one season of Retrosheet game logs, parses it into end-of-half-
inning game states, builds the inning x score-difference win-expectancy
table, prints it, and runs a few sanity checks.

Run from the repository root:

    python -m src.run_phase1
"""
from __future__ import annotations

from pathlib import Path

from src.engine.win_expectancy import Table, build_table, format_table
from src.ingest.download import download_gamelog
from src.ingest.gamelog import parse_gamelog

SEASON = 2025
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"


def _home_win_rate(table: Table) -> tuple[float, int, int]:
    """The overall home win rate.

    Every game contributes exactly one "end of the top of the 1st" state, so
    summing that row covers every game in the season exactly once.
    """
    wins = sum(c.wins for (inn, half, _), c in table.items()
               if inn == 1 and half == "top")
    total = sum(c.total for (inn, half, _), c in table.items()
                if inn == 1 and half == "top")
    return (100.0 * wins / total if total else 0.0), wins, total


def _check(label: str, table: Table, key: tuple[int, str, int], expected: str) -> None:
    """Print one spot-check cell — its win rate, sample size, and what to expect."""
    inning, half, lead = key
    print(f"  {label}  (inning {inning}, end of {half}, home lead {lead:+d})")
    cell = table.get(key)
    if cell and cell.total:
        print(f"      home wins {cell.win_pct:.1f}%  ({cell.wins}/{cell.total} games)"
              f"  — expect {expected}")
    else:
        print("      no data")


def main() -> None:
    print(f"Phase 1 — win-expectancy engine, {SEASON} season\n")

    path = download_gamelog(SEASON, RAW_DIR)
    states = parse_gamelog(path)
    print(f"Parsed {len(states):,} game states from {path.name}.")
    table = build_table(states)

    print("\n" + format_table(table) + "\n")

    print("Sanity checks:\n")
    rate, wins, total = _home_win_rate(table)
    print("  overall home win rate")
    print(f"      home wins {rate:.1f}%  ({wins}/{total} games)"
          f"  — expect ~52-54% (home-field advantage)")
    _check("home cruising late", table, (8, "top", 5), "~99-100%")
    _check("home buried late", table, (8, "top", -5), "~0-2%")
    _check("tied, home batting in the 9th", table, (9, "top", 0),
           "well above 50% — the last-at-bat edge, ~two-thirds")


if __name__ == "__main__":
    main()
