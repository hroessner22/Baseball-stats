"""SQLite store for per-year win-expectancy aggregates.

The store keeps one row per (year, inning, half, home lead) with the home
team's win/total tally. Any year-range table is then a ``SUM`` over the
matching rows — a single season or all of history, in one query.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from src.engine.win_expectancy import Cell, Table

_SCHEMA = """
CREATE TABLE IF NOT EXISTS win_expectancy (
    year       INTEGER NOT NULL,
    inning     INTEGER NOT NULL,
    half       TEXT    NOT NULL,
    home_lead  INTEGER NOT NULL,
    wins       INTEGER NOT NULL,
    total      INTEGER NOT NULL,
    PRIMARY KEY (year, inning, half, home_lead)
);
"""


def open_store(path: Path) -> sqlite3.Connection:
    """Open the win-expectancy store, creating the file and schema if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    return conn


def write_year(conn: sqlite3.Connection, year: int, table: Table) -> None:
    """Persist one season's win-expectancy table.

    Any existing rows for that year are replaced first, so re-ingesting a
    season is idempotent.
    """
    conn.execute("DELETE FROM win_expectancy WHERE year = ?", (year,))
    conn.executemany(
        "INSERT INTO win_expectancy "
        "(year, inning, half, home_lead, wins, total) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (year, inning, half, home_lead, cell.wins, cell.total)
            for (inning, half, home_lead), cell in table.items()
        ],
    )
    conn.commit()


def query_range(conn: sqlite3.Connection, start_year: int, end_year: int) -> Table:
    """Build the win-expectancy table for the seasons in [start_year, end_year]."""
    rows = conn.execute(
        "SELECT inning, half, home_lead, SUM(wins), SUM(total) "
        "FROM win_expectancy WHERE year BETWEEN ? AND ? "
        "GROUP BY inning, half, home_lead",
        (start_year, end_year),
    )
    return {
        (inning, half, home_lead): Cell(wins=wins, total=total)
        for inning, half, home_lead, wins, total in rows
    }


def stored_years(conn: sqlite3.Connection) -> tuple[int | None, int | None, int]:
    """Return (earliest year, latest year, distinct year count) in the store."""
    low, high, count = conn.execute(
        "SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM win_expectancy"
    ).fetchone()
    return low, high, count
