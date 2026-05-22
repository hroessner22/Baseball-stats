"""Aggregate game states into the win-expectancy table.

The table answers one question: given the inning, the half-inning, and the
home team's lead, what share of games did the home team go on to win?
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from src.ingest.gamelog import GameState


@dataclass
class Cell:
    """One cell of the win-expectancy table — a running tally."""

    wins: int = 0
    total: int = 0

    @property
    def win_pct(self) -> float:
        return 100.0 * self.wins / self.total if self.total else 0.0


# A table key is (inning, half, home_lead).
Table = dict[tuple[int, str, int], Cell]


def build_table(states: list[GameState]) -> Table:
    """Aggregate game states into the win-expectancy table."""
    table: Table = defaultdict(Cell)
    for state in states:
        cell = table[(state.inning, state.half, state.home_lead)]
        cell.total += 1
        if state.home_won:
            cell.wins += 1
    return table


def format_table(table: Table, max_inning: int = 9, lead_range: int = 6) -> str:
    """Render the win-expectancy table as a readable grid.

    Rows are (inning, half); columns are the home team's lead in runs; each
    cell is the home team's win percentage. A ``.`` marks a cell with no data.
    """
    leads = list(range(-lead_range, lead_range + 1))
    width = 5
    out = [
        "Home win % by inning/half and home lead "
        "(columns = home runs ahead):",
        "",
        "inning/half".ljust(13) + "".join(f"{lead:>{width}d}" for lead in leads),
        "-" * (13 + width * len(leads)),
    ]
    for inning in range(1, max_inning + 1):
        for half in ("top", "bottom"):
            row = f"{inning} {half}".ljust(13)
            for lead in leads:
                cell = table.get((inning, half, lead))
                if cell and cell.total:
                    row += f"{cell.win_pct:>{width}.0f}"
                else:
                    row += f"{'.':>{width}}"
            out.append(row)
    return "\n".join(out)
