"""Tests for the SQLite win-expectancy store."""
from src.engine.store import open_store, query_range, stored_years, write_year
from src.engine.win_expectancy import Cell


def test_store_round_trip(tmp_path):
    conn = open_store(tmp_path / "we.db")
    write_year(conn, 2025, {(7, "top", 2): Cell(wins=9, total=10)})
    write_year(conn, 2024, {(7, "top", 2): Cell(wins=5, total=10)})

    # A single season.
    one = query_range(conn, 2025, 2025)
    assert one[(7, "top", 2)].wins == 9
    assert one[(7, "top", 2)].total == 10

    # Two seasons together — the counts sum.
    both = query_range(conn, 2024, 2025)
    assert both[(7, "top", 2)].wins == 14
    assert both[(7, "top", 2)].total == 20

    assert stored_years(conn) == (2024, 2025, 2)
    conn.close()


def test_write_year_is_idempotent(tmp_path):
    conn = open_store(tmp_path / "we.db")
    write_year(conn, 2025, {(1, "top", 0): Cell(wins=1, total=2)})
    write_year(conn, 2025, {(1, "top", 0): Cell(wins=3, total=4)})
    # Re-writing a season replaces it rather than appending.
    assert query_range(conn, 2025, 2025)[(1, "top", 0)].total == 4
    conn.close()
