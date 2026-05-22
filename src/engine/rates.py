"""Handedness-split rate tables — the at-bat outcome data.

Aggregates plate appearances into outcome counts and stores them in SQLite:

  * ``batting``  — per batter, split by the pitcher's throwing hand
  * ``pitching`` — per pitcher, split by the batter's batting side
  * ``league``   — the baseline, by the handedness matchup

Counts are kept per season, so any year range is a ``SUM`` over the matching
rows. The matchup engine (``matchup.py``) reads these tables to predict a
batter-versus-pitcher outcome distribution.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from src.ingest.events import AtBat

_SCHEMA = """
CREATE TABLE IF NOT EXISTS batting (
    year     INTEGER NOT NULL,
    batter   TEXT    NOT NULL,
    bats     TEXT    NOT NULL,
    vs_hand  TEXT    NOT NULL,
    outcome  TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    PRIMARY KEY (year, batter, bats, vs_hand, outcome)
);
CREATE TABLE IF NOT EXISTS pitching (
    year     INTEGER NOT NULL,
    pitcher  TEXT    NOT NULL,
    throws   TEXT    NOT NULL,
    vs_hand  TEXT    NOT NULL,
    outcome  TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    PRIMARY KEY (year, pitcher, throws, vs_hand, outcome)
);
CREATE TABLE IF NOT EXISTS league (
    year     INTEGER NOT NULL,
    bats     TEXT    NOT NULL,
    throws   TEXT    NOT NULL,
    outcome  TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    PRIMARY KEY (year, bats, throws, outcome)
);
CREATE INDEX IF NOT EXISTS idx_batting_batter ON batting (batter, vs_hand);
CREATE INDEX IF NOT EXISTS idx_pitching_pitcher ON pitching (pitcher, vs_hand);
"""


@dataclass
class SeasonTally:
    """One season's outcome counts, keyed and ready to persist."""

    batting: dict[tuple[str, str, str, str], int]   # (batter, bats, vs_hand, outcome)
    pitching: dict[tuple[str, str, str, str], int]  # (pitcher, throws, vs_hand, outcome)
    league: dict[tuple[str, str, str], int]         # (bats, throws, outcome)


@dataclass
class RateLine:
    """Outcome counts for one player, or the league, within one split."""

    counts: dict[str, int]
    hand: str = ""  # the player's own hand; "" for a league line

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def rate(self, outcome: str) -> float:
        """The share of plate appearances ending in ``outcome`` (0.0-1.0)."""
        return self.counts.get(outcome, 0) / self.total if self.total else 0.0


def tally_season(at_bats: list[AtBat]) -> SeasonTally:
    """Aggregate one season's plate appearances into outcome counts."""
    batting: dict[tuple[str, str, str, str], int] = defaultdict(int)
    pitching: dict[tuple[str, str, str, str], int] = defaultdict(int)
    league: dict[tuple[str, str, str], int] = defaultdict(int)
    for ab in at_bats:
        batting[(ab.batter, ab.bats, ab.throws, ab.outcome)] += 1
        pitching[(ab.pitcher, ab.throws, ab.bats, ab.outcome)] += 1
        league[(ab.bats, ab.throws, ab.outcome)] += 1
    return SeasonTally(dict(batting), dict(pitching), dict(league))


def open_rate_store(path: Path) -> sqlite3.Connection:
    """Open the rate store, creating the file, tables, and indexes if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    return conn


def write_season(conn: sqlite3.Connection, year: int, tally: SeasonTally) -> None:
    """Persist one season's tally.

    Existing rows for the year are replaced first, so re-ingesting a season is
    idempotent.
    """
    for table in ("batting", "pitching", "league"):
        conn.execute(f"DELETE FROM {table} WHERE year = ?", (year,))
    conn.executemany(
        "INSERT INTO batting (year, batter, bats, vs_hand, outcome, count) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(year, *key, count) for key, count in tally.batting.items()],
    )
    conn.executemany(
        "INSERT INTO pitching (year, pitcher, throws, vs_hand, outcome, count) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(year, *key, count) for key, count in tally.pitching.items()],
    )
    conn.executemany(
        "INSERT INTO league (year, bats, throws, outcome, count) "
        "VALUES (?, ?, ?, ?, ?)",
        [(year, *key, count) for key, count in tally.league.items()],
    )
    conn.commit()


def batter_line(
    conn: sqlite3.Connection,
    batter: str,
    start_year: int,
    end_year: int,
    vs_hand: str | None = None,
) -> RateLine:
    """A batter's outcome counts over [start_year, end_year].

    With ``vs_hand`` ("L" or "R"), restricts to plate appearances against
    pitchers of that throwing hand.
    """
    sql = (
        "SELECT bats, outcome, SUM(count) FROM batting "
        "WHERE batter = ? AND year BETWEEN ? AND ?"
    )
    params: list = [batter, start_year, end_year]
    if vs_hand is not None:
        sql += " AND vs_hand = ?"
        params.append(vs_hand)
    sql += " GROUP BY bats, outcome"

    counts: dict[str, int] = {}
    hands: set[str] = set()
    for bats, outcome, total in conn.execute(sql, params):
        counts[outcome] = counts.get(outcome, 0) + total
        hands.add(bats)
    return RateLine(counts=counts, hand=_one_hand(hands))


def pitcher_line(
    conn: sqlite3.Connection,
    pitcher: str,
    start_year: int,
    end_year: int,
    vs_hand: str | None = None,
) -> RateLine:
    """A pitcher's outcome counts over [start_year, end_year].

    With ``vs_hand`` ("L" or "R"), restricts to plate appearances against
    batters batting from that side.
    """
    sql = (
        "SELECT throws, outcome, SUM(count) FROM pitching "
        "WHERE pitcher = ? AND year BETWEEN ? AND ?"
    )
    params: list = [pitcher, start_year, end_year]
    if vs_hand is not None:
        sql += " AND vs_hand = ?"
        params.append(vs_hand)
    sql += " GROUP BY throws, outcome"

    counts: dict[str, int] = {}
    hands: set[str] = set()
    for throws, outcome, total in conn.execute(sql, params):
        counts[outcome] = counts.get(outcome, 0) + total
        hands.add(throws)
    return RateLine(counts=counts, hand=_one_hand(hands))


def league_line(
    conn: sqlite3.Connection,
    bats: str,
    throws: str,
    start_year: int,
    end_year: int,
) -> RateLine:
    """The league baseline for one handedness matchup over a year range."""
    counts: dict[str, int] = {}
    for outcome, total in conn.execute(
        "SELECT outcome, SUM(count) FROM league "
        "WHERE bats = ? AND throws = ? AND year BETWEEN ? AND ? "
        "GROUP BY outcome",
        (bats, throws, start_year, end_year),
    ):
        counts[outcome] = total
    return RateLine(counts=counts, hand="")


def stored_rate_years(conn: sqlite3.Connection) -> tuple[int | None, int | None, int]:
    """Return (earliest year, latest year, distinct year count) in the store."""
    low, high, count = conn.execute(
        "SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM league"
    ).fetchone()
    return low, high, count


def _one_hand(hands: set[str]) -> str:
    """Collapse the hands seen in a query to a single code.

    One hand for an ordinary player; "B" when both appear (a switch hitter
    queried across both pitcher hands); "" when there is no data.
    """
    if len(hands) == 1:
        return next(iter(hands))
    return "B" if hands else ""
