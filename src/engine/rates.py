"""Plate-appearance store and queries.

Every parsed plate appearance is kept in a SQLite table (``at_bats``) with all
of its situational fields — handedness, count, base-out state, inning, score
margin, and the sacrifice flags. A parallel ``games`` table carries one row
per game — schedule, park, weather, attendance, summary score — joined to
``at_bats`` by ``game_id``. Queries roll up outcome counts under any
combination of filters; the matchup engine builds on these.

Filters accepted by ``query_outcomes`` / ``batter_line`` / ``pitcher_line`` /
``league_line``:

  at-bat exact   batter, pitcher, bats, throws, half, inning, outs, balls,
                 strikes
  at-bat bases   int or tuple of ints (0-7 — the base-out code)
  at-bat risp    True → bases in {2, 3, 4, 5, 6, 7} (runner on 2B or 3B)
  at-bat count   (balls, strikes) — e.g. (3, 1) for a 3-1 count
  at-bat ranges  year_range, date_range, home_lead_range
  at-bat sacs    sh_fl, sf_fl (bool)

  game exact     daynight ("D"/"N"), home_team, away_team, park_id,
                 day_of_week, sky, precip, field_cond, wind_dir
  game ranges    temp_range, wind_speed_range, attendance_range,
                 innings_range, start_time_range, game_minutes_range
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from src.ingest.events import AtBat, Game

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
    sf_fl     INTEGER NOT NULL,
    batter_days_rest     INTEGER NOT NULL DEFAULT 0,
    pitcher_days_rest    INTEGER NOT NULL DEFAULT 0,
    batter_games_last_7  INTEGER NOT NULL DEFAULT 0,
    pitcher_games_last_7 INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_at_bats_batter  ON at_bats (batter, year);
CREATE INDEX IF NOT EXISTS idx_at_bats_pitcher ON at_bats (pitcher, year);
CREATE INDEX IF NOT EXISTS idx_at_bats_game    ON at_bats (game_id);

CREATE TABLE IF NOT EXISTS games (
    game_id       TEXT    PRIMARY KEY,
    year          INTEGER NOT NULL,
    date          INTEGER NOT NULL,
    day_of_week   TEXT,
    start_time    INTEGER,
    daynight      TEXT,
    away_team     TEXT,
    home_team     TEXT,
    park_id       TEXT,
    attendance    INTEGER,
    temp          INTEGER,
    wind_dir      INTEGER,
    wind_speed    INTEGER,
    field_cond    INTEGER,
    precip        INTEGER,
    sky           INTEGER,
    game_minutes  INTEGER,
    innings       INTEGER,
    away_score    INTEGER,
    home_score    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_games_year      ON games (year);
CREATE INDEX IF NOT EXISTS idx_games_date      ON games (date);
CREATE INDEX IF NOT EXISTS idx_games_home_team ON games (home_team);
CREATE INDEX IF NOT EXISTS idx_games_park      ON games (park_id);
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
    """Open the store, creating the file, tables, and indexes.

    Enables WAL journal mode so a reader (a status check, a query) can run
    while the ingest is writing — without WAL, SQLite serialises and the
    writer errors out on any concurrent read lock.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.executescript(_SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after a database was first created.

    SQLite's ``CREATE TABLE IF NOT EXISTS`` leaves an existing table untouched,
    so new columns must be added separately. Each ``ALTER TABLE ADD COLUMN``
    here is idempotent — already-present columns raise ``OperationalError``
    which we swallow.
    """
    additions = [
        ("at_bats", "batter_days_rest",     "INTEGER NOT NULL DEFAULT 0"),
        ("at_bats", "pitcher_days_rest",    "INTEGER NOT NULL DEFAULT 0"),
        ("at_bats", "batter_games_last_7",  "INTEGER NOT NULL DEFAULT 0"),
        ("at_bats", "pitcher_games_last_7", "INTEGER NOT NULL DEFAULT 0"),
    ]
    for table, column, definition in additions:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError:
            pass  # column already exists


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
        " inning, half, outs, bases, home_lead, balls, strikes, sh_fl, sf_fl, "
        " batter_days_rest, pitcher_days_rest, "
        " batter_games_last_7, pitcher_games_last_7) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                year, ab.date, ab.game_id, ab.batter, ab.bats, ab.pitcher,
                ab.throws, ab.outcome, ab.inning, ab.half, ab.outs, ab.bases,
                ab.home_lead, ab.balls, ab.strikes,
                int(ab.sh_fl), int(ab.sf_fl),
                ab.batter_days_rest, ab.pitcher_days_rest,
                ab.batter_games_last_7, ab.pitcher_games_last_7,
            )
            for ab in at_bats
        ],
    )
    conn.commit()


def write_games(
    conn: sqlite3.Connection, year: int, games: list[Game]
) -> None:
    """Persist one season's game records.

    Existing rows for the year are deleted first, so re-ingesting a season is
    idempotent.
    """
    conn.execute("DELETE FROM games WHERE year = ?", (year,))
    conn.executemany(
        "INSERT OR REPLACE INTO games "
        "(game_id, year, date, day_of_week, start_time, daynight, "
        " away_team, home_team, park_id, attendance, "
        " temp, wind_dir, wind_speed, field_cond, precip, sky, "
        " game_minutes, innings, away_score, home_score) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                g.game_id, year, g.date, g.day_of_week, g.start_time,
                g.daynight, g.away_team, g.home_team, g.park_id, g.attendance,
                g.temp, g.wind_dir, g.wind_speed, g.field_cond, g.precip,
                g.sky, g.game_minutes, g.innings, g.away_score, g.home_score,
            )
            for g in games
        ],
    )
    conn.commit()


def stored_rate_years(
    conn: sqlite3.Connection,
) -> tuple[int | None, int | None, int]:
    """Return (earliest year, latest year, distinct year count) in ``at_bats``."""
    low, high, count = conn.execute(
        "SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM at_bats"
    ).fetchone()
    return low, high, count


def stored_game_years(
    conn: sqlite3.Connection,
) -> tuple[int | None, int | None, int]:
    """Return (earliest year, latest year, distinct year count) in ``games``."""
    low, high, count = conn.execute(
        "SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM games"
    ).fetchone()
    return low, high, count


# Filter keys that translate to ``at_bats.column = ?``.
_AT_BAT_EXACT = (
    "batter", "pitcher", "bats", "throws", "half",
    "inning", "outs", "balls", "strikes",
    "batter_days_rest", "pitcher_days_rest",
    "batter_games_last_7", "pitcher_games_last_7",
)
# Filter keys that translate to ``games.column = ?``.
_GAME_EXACT = (
    "daynight", "home_team", "away_team", "park_id", "day_of_week",
    "sky", "precip", "field_cond", "wind_dir",
)
# Game-level range filters: maps filter key → games column.
_GAME_RANGES = {
    "temp_range": "temp",
    "wind_speed_range": "wind_speed",
    "attendance_range": "attendance",
    "innings_range": "innings",
    "start_time_range": "start_time",
    "game_minutes_range": "game_minutes",
}


def _build_where(filters: dict) -> tuple[list[str], list]:
    """Translate a filter dict into a list of SQL conditions plus parameters."""
    parts: list[str] = []
    params: list = []
    for key, value in filters.items():
        if value is None:
            continue
        if key in _AT_BAT_EXACT:
            parts.append(f"at_bats.{key} = ?")
            params.append(value)
        elif key in _GAME_EXACT:
            parts.append(f"games.{key} = ?")
            params.append(value)
        elif key == "bases":
            if isinstance(value, int):
                parts.append("at_bats.bases = ?")
                params.append(value)
            else:
                placeholders = ",".join("?" * len(value))
                parts.append(f"at_bats.bases IN ({placeholders})")
                params.extend(value)
        elif key == "risp" and value:
            # Runner in scoring position — any base-out code with 2B or 3B set.
            parts.append("at_bats.bases >= 2")
        elif key == "count":
            balls, strikes = value
            parts.append("at_bats.balls = ?")
            params.append(balls)
            parts.append("at_bats.strikes = ?")
            params.append(strikes)
        elif key == "year_range":
            lo, hi = value
            parts.append("at_bats.year BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "date_range":
            lo, hi = value
            parts.append("at_bats.date BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "home_lead_range":
            lo, hi = value
            parts.append("at_bats.home_lead BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "batter_days_rest_range":
            lo, hi = value
            parts.append("at_bats.batter_days_rest BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "pitcher_days_rest_range":
            lo, hi = value
            parts.append("at_bats.pitcher_days_rest BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "batter_games_last_7_range":
            lo, hi = value
            parts.append("at_bats.batter_games_last_7 BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key == "pitcher_games_last_7_range":
            lo, hi = value
            parts.append("at_bats.pitcher_games_last_7 BETWEEN ? AND ?")
            params.extend([lo, hi])
        elif key in ("sh_fl", "sf_fl"):
            parts.append(f"at_bats.{key} = ?")
            params.append(1 if value else 0)
        elif key in _GAME_RANGES:
            lo, hi = value
            parts.append(f"games.{_GAME_RANGES[key]} BETWEEN ? AND ?")
            params.extend([lo, hi])
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


# Every query joins the at-bats to their games — LEFT JOIN, so at-bats without
# a corresponding game record (e.g. before games are ingested) still appear in
# results that don't filter on game fields.
_FROM = "FROM at_bats LEFT JOIN games ON at_bats.game_id = games.game_id"


def query_outcomes(conn: sqlite3.Connection, **filters) -> RateLine:
    """Sum outcomes across every at-bat that matches the given filters.

    See the module docstring for the accepted filter keys.
    """
    where_parts, params = _build_where(filters)
    sql = f"SELECT at_bats.outcome, COUNT(*) {_FROM}"
    if where_parts:
        sql += " WHERE " + " AND ".join(where_parts)
    sql += " GROUP BY at_bats.outcome"
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
        f"SELECT at_bats.bats, at_bats.outcome, COUNT(*) {_FROM} "
        f"WHERE {' AND '.join(where_parts)} "
        "GROUP BY at_bats.bats, at_bats.outcome"
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
        f"SELECT at_bats.throws, at_bats.outcome, COUNT(*) {_FROM} "
        f"WHERE {' AND '.join(where_parts)} "
        "GROUP BY at_bats.throws, at_bats.outcome"
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
