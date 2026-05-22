"""Plate-appearance store and queries.

Every parsed plate appearance is kept in a SQLite table (``at_bats``) with all
of its situational fields — handedness, count, base-out state, inning, score
margin, and the sacrifice flags. Queries roll up outcome counts under any
combination of filters; the matchup engine builds on these.

Filters accepted by ``query_outcomes`` / ``batter_line`` / ``pitcher_line`` /
``league_line``:

  exact match    batter, pitcher, bats, throws, half, inning, outs, balls,
                 strikes
  bases          int or tuple of ints (0-7 — the base-out code)
  risp           True → bases in {2, 3, 4, 5, 6, 7} (runner on 2B or 3B)
  count          (balls, strikes) — e.g. (3, 1) for a 3-1 count
  year_range     (low, high) — inclusive
  date_range     (low, high) — YYYYMMDD ints
  home_lead_range  (low, high) — score margin from the home team's view
  sh_fl, sf_fl   bool — sacrifice hit / fly
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from src.ingest.events import AtBat

_SCHEMA = """
CREATE TABLE IF NOT EXISTS at_bats (
    year      INTEGER NOT NULL,
    date      INTEGER NOT NULL,
    game_id   TEXT    NOT NULL,
    batter    TEXT    NOT NULL,
    bats      TEXT    NOT NULL,
    pitcher   TEXT    NOT NULL,
    throws    TEXT    NOT NULL,
    outcome   TEXT    NOT NULL,
    inning    INTEGER NOT NULL,
    half      TEXT    NOT NULL,
    outs      INTEGER NOT NULL,
    bases     INTEGER NOT NULL,
    home_lead INTEGER NOT NULL,
    balls     INTEGER NOT NULL,
    strikes   INTEGER NOT NULL,
    sh_fl     INTEGER NOT NULL,
    sf_fl     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_at_bats_batter  ON at_bats (batter, year);
CREATE INDEX IF NOT EXISTS idx_at_bats_pitcher ON at_bats (pitcher, year);
CREATE INDEX IF NOT EXISTS idx_at_bats_game    ON at_bats (game_id);
"""


@dataclass
class RateLine:
    """Outcome counts for one player or split."""

    counts: dict[str, int]
    hand: str = ""  # the player's own hand within the filtered data

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def rate(self, outcome: str) -> float:
        """The share of plate appearances ending in ``outcome`` (0.0–1.0)."""
        return self.counts.get(outcome, 0) / self.total if self.total else 0.0


def open_rate_store(path: Path) -> sqlite3.Connection:
    """Open the at-bats store, creating the file, table, and indexes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    return conn


def write_at_bats(
    conn: sqlite3.Connection, year: int, at_bats: list[AtBat]
) -> None:
    """Persist one season's plate appearances.

    Existing rows for the year are deleted first, so re-ingesting a season is
    idempotent.
    """
    conn.execute("DELETE FROM at_bats WHERE year = ?", (year,))
    conn.executemany(
        "INSERT INTO at_bats "
        "(year, date, game_id, batter, bats, pitcher, throws, outcome, "
        " inning, half, outs, bases, home_lead, balls, strikes, sh_fl, sf_fl) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                year, ab.date, ab.game_id, ab.batter, ab.bats, ab.pitcher,
                ab.throws, ab.outcome, ab.inning, ab.half, ab.outs, ab.bases,
                ab.home_lead, ab.balls, ab.strikes,
                int(ab.sh_fl), int(ab.sf_fl),
            )
            for ab in at_bats
        ],
    )
    conn.commit()


def stored_rate_years(
    conn: sqlite3.Connection,
) -> tuple[int | None, int | None, int]:
    """Return (earliest year, latest year, distinct year count) in the store."""
    low, high, count = conn.execute(
        "SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM at_bats"
    ).fetchone()
    return low, high, count


# Filter keys that translate to ``column = ?``.
_EXACT_FILTERS = (
    "batter", "pitcher", "bats", "throws", "half",
    "inning", "outs", "balls", "strikes",
)


def _build_where(filters: dict) -> tuple[list[str], list]:
    """Translate a filter dict into a list of SQL conditions plus parameters."""
    parts: list[str] = []
    params: list = []
    for key, value in filters.items():
        if value is None:
            continue
        if key in _EXACT_FILTERS:
            parts.append(f"{key} = ?")
            params.append(value)
        elif key == "bases":
            if isinstance(value, int):
                parts.append("bases = ?")
                params.append(value)
            else:
                placeholders = ",".join("?" * len(value))
                parts.append(f"bases IN ({placeholders})")
                params.extend(value)
        elif key == "risp" and value:
            # Runner in scoring position — any base-out code with 2B or 3B set.
            parts.append("bases >= 2")
        elif key == "count":
            balls, strikes = value
            parts.append("balls = ?")
            params.append(balls)
            parts.append("strikes = ?")
            params.append(strikes)
        elif key == "year_range":
            lo, hi = value
            parts.append("year BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "date_range":
            lo, hi = value
            parts.append("date BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "home_lead_range":
            lo, hi = value
            parts.append("home_lead BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key in ("sh_fl", "sf_fl"):
            parts.append(f"{key} = ?")
            params.append(1 if value else 0)
        else:
            raise ValueError(f"unknown filter: {key!r}")
    return parts, params


def _one_hand(hands: set[str]) -> str:
    """Collapse the hands seen in a query result to a single code.

    One hand for an ordinary player; "B" when both appear (a switch hitter
    spanning both pitcher hands); "" when there is no data.
    """
    if len(hands) == 1:
        return next(iter(hands))
    return "B" if hands else ""


def query_outcomes(conn: sqlite3.Connection, **filters) -> RateLine:
    """Sum outcomes across every at-bat that matches the given filters.

    See the module docstring for the accepted filter keys. Returns a
    ``RateLine`` without a player hand (use ``batter_line``/``pitcher_line``
    when that matters).
    """
    where_parts, params = _build_where(filters)
    sql = "SELECT outcome, COUNT(*) FROM at_bats"
    if where_parts:
        sql += " WHERE " + " AND ".join(where_parts)
    sql += " GROUP BY outcome"
    counts: dict[str, int] = {}
    for outcome, total in conn.execute(sql, params):
        counts[outcome] = total
    return RateLine(counts=counts)


def batter_line(
    conn: sqlite3.Connection, batter: str, **filters,
) -> RateLine:
    """A batter's outcome counts, with any additional filters.

    The returned ``RateLine.hand`` is the batter's batting side seen in the
    filtered data — one of "L", "R", "B" (switch spanning both), or "".
    """
    where_parts, params = _build_where({**filters, "batter": batter})
    sql = (
        "SELECT bats, outcome, COUNT(*) FROM at_bats "
        f"WHERE {' AND '.join(where_parts)} "
        "GROUP BY bats, outcome"
    )
    counts: dict[str, int] = {}
    hands: set[str] = set()
    for bats, outcome, total in conn.execute(sql, params):
        counts[outcome] = counts.get(outcome, 0) + total
        hands.add(bats)
    return RateLine(counts=counts, hand=_one_hand(hands))


def pitcher_line(
    conn: sqlite3.Connection, pitcher: str, **filters,
) -> RateLine:
    """A pitcher's outcome counts, with any additional filters."""
    where_parts, params = _build_where({**filters, "pitcher": pitcher})
    sql = (
        "SELECT throws, outcome, COUNT(*) FROM at_bats "
        f"WHERE {' AND '.join(where_parts)} "
        "GROUP BY throws, outcome"
    )
    counts: dict[str, int] = {}
    hands: set[str] = set()
    for throws, outcome, total in conn.execute(sql, params):
        counts[outcome] = counts.get(outcome, 0) + total
        hands.add(throws)
    return RateLine(counts=counts, hand=_one_hand(hands))


def league_line(conn: sqlite3.Connection, **filters) -> RateLine:
    """The league baseline for the given filters.

    Pass ``bats=`` and/or ``throws=`` for a handedness-matchup baseline.
    """
    return query_outcomes(conn, **filters)
