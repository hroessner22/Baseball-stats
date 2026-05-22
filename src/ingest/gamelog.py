"""Parse Retrosheet game logs into end-of-half-inning game states.

A game log is a CSV with one row per game. The fields used here (1-indexed,
per ``glfields.txt``):

      1   date ("yyyymmdd" — the season year is the first four digits)
      4   visiting team
      7   home team
     10   visiting team final score
     11   home team final score
     20   visiting team line score
     21   home team line score

A line score is a string of per-inning run totals, e.g. ``"000030001"``.
Multi-run innings appear in parentheses (``"(10)"``); an ``"x"`` marks a
half-inning the team did not bat (the home team leading after the top of the
final inning).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

# Zero-based field indices into a game-log row.
_DATE = 0
_VISITOR_SCORE = 9
_HOME_SCORE = 10
_VISITOR_LINE = 19
_HOME_LINE = 20


@dataclass(frozen=True)
class GameState:
    """The game at the end of one half-inning, from the home team's view."""

    year: int
    inning: int
    half: str  # "top" or "bottom"
    home_lead: int  # home score minus visitor score
    home_won: bool


def parse_line_score(line: str) -> list[int | None]:
    """Parse a Retrosheet line score into per-inning run totals.

    Each element is the runs scored that inning, or ``None`` if the team did
    not bat that inning (an ``"x"`` in the line score).
    """
    innings: list[int | None] = []
    i = 0
    while i < len(line):
        char = line[i]
        if char == "(":
            close = line.index(")", i)
            innings.append(int(line[i + 1 : close]))
            i = close + 1
        elif char in "xX":
            innings.append(None)
            i += 1
        elif char.isdigit():
            innings.append(int(char))
            i += 1
        else:
            i += 1  # unexpected character; the run-total check will catch it
    return innings


def _game_states(row: list[str]) -> list[GameState]:
    """End-of-half-inning states for one game-log row.

    Returns an empty list for any game that cannot be trusted — too few
    fields, a tie, malformed numbers, or a line score whose runs do not sum
    to the recorded final score.
    """
    if len(row) <= _HOME_LINE:
        return []
    try:
        year = int(row[_DATE][:4])
        visitor_final = int(row[_VISITOR_SCORE])
        home_final = int(row[_HOME_SCORE])
        visitor_line = parse_line_score(row[_VISITOR_LINE])
        home_line = parse_line_score(row[_HOME_LINE])
    except ValueError:
        return []

    if visitor_final == home_final:
        return []  # ties / suspended games
    if sum(r for r in visitor_line if r is not None) != visitor_final:
        return []
    if sum(r for r in home_line if r is not None) != home_final:
        return []

    home_won = home_final > visitor_final
    states: list[GameState] = []
    visitor_cum = 0
    home_cum = 0
    for inning in range(1, max(len(visitor_line), len(home_line)) + 1):
        idx = inning - 1
        # Top of the inning — the visitor bats.
        if idx < len(visitor_line) and visitor_line[idx] is not None:
            visitor_cum += visitor_line[idx]
        states.append(
            GameState(year, inning, "top", home_cum - visitor_cum, home_won)
        )
        # Bottom of the inning — the home team bats, unless it did not.
        if idx < len(home_line) and home_line[idx] is not None:
            home_cum += home_line[idx]
            states.append(
                GameState(year, inning, "bottom", home_cum - visitor_cum, home_won)
            )
    return states


def parse_gamelog(path: Path) -> list[GameState]:
    """Parse every game in a Retrosheet game-log file into game states.

    Games that cannot be trusted are dropped (see ``_game_states``). A file
    with no usable line scores — as in some 19th-century seasons, where
    Retrosheet has only final scores — yields an empty list.
    """
    states: list[GameState] = []
    with open(path, newline="", encoding="latin-1") as handle:
        for row in csv.reader(handle):
            if row:
                states.extend(_game_states(row))
    return states
