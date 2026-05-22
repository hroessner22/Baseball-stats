"""Tests for win-expectancy aggregation."""
from src.engine.win_expectancy import Cell, build_table
from src.ingest.gamelog import GameState


def test_build_table_counts_wins_and_totals():
    states = [
        GameState(2025, 7, "top", 2, True),
        GameState(2025, 7, "top", 2, True),
        GameState(2025, 7, "top", 2, False),
        GameState(2024, 7, "top", 2, True),
    ]
    cell = build_table(states)[(7, "top", 2)]
    assert cell.wins == 3
    assert cell.total == 4
    assert cell.win_pct == 75.0


def test_build_table_separates_distinct_states():
    states = [
        GameState(2025, 1, "top", 0, True),
        GameState(2025, 9, "bottom", -3, False),
    ]
    table = build_table(states)
    assert table[(1, "top", 0)].total == 1
    assert table[(9, "bottom", -3)].total == 1


def test_cell_win_pct_handles_empty():
    assert Cell().win_pct == 0.0
