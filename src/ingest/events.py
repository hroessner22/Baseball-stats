"""Parse Retrosheet event files into per-plate-appearance records.

Retrosheet publishes play-by-play "event files" — one per team's home games
per season (e.g. ``2024ANA.EVA``), written in a dense shorthand. Rather than
parse that shorthand directly — it is intricate and easy to get subtly wrong —
this module runs the files through Chadwick's ``cwevent`` tool, which expands
every play into a wide, well-defined CSV. We keep one record per plate
appearance.

``cwevent`` must be installed and on the PATH (or in a standard Homebrew
location): ``brew install chadwick`` on macOS. See https://chadwick.readthedocs.io.
"""
from __future__ import annotations

import csv
import shutil
import subprocess
from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path

# cwevent output columns we read, by index. The ingestion requests fields
# 0-39 (``cwevent -f 0-39``), so a column's index is its cwevent field number.
_GAME_ID = 0           # e.g. "ANA202404050" — the date is chars 3-10
_INNING = 2
_BAT_HOME_ID = 3       # "0" = visitor batting, "1" = home team batting
_OUTS = 4
_BALLS = 5             # balls in the count when the play ended
_STRIKES = 6           # strikes in the count when the play ended
_AWAY_SCORE = 8        # running score, before the play
_HOME_SCORE = 9
_BAT_ID = 10
_BAT_HAND = 11         # "L"/"R" — switch-hitters resolved to the side used
_PIT_ID = 14
_PIT_HAND = 15         # "L"/"R"
_BASE1_RUN = 26        # runner ids; an empty string means the base is empty
_BASE2_RUN = 27
_BASE3_RUN = 28
_EVENT_CD = 34         # the play's outcome code (see _OUTCOME_BY_EVENT_CD)
_BAT_EVENT_FL = 35     # "T" on the play that ends a plate appearance
_SH_FL = 38            # sacrifice hit flag — separates sac bunts from outs
_SF_FL = 39            # sacrifice fly flag — separates sac flies from outs
_FIELD_RANGE = "0-39"

# cwevent EVENT_CD values mapped to the plate-appearance outcome we record.
# Codes not listed never end a plate appearance (stolen bases, balks, ...).
_OUTCOME_BY_EVENT_CD = {
    2: "OUT",     # ball in play, batter out
    3: "K",       # strikeout
    14: "BB",     # walk
    15: "BB",     # intentional walk — folded in with walks
    16: "HBP",    # hit by pitch
    17: "OTHER",  # interference
    18: "OTHER",  # reached on error
    19: "OTHER",  # fielder's choice
    20: "1B",     # single
    21: "2B",     # double
    22: "3B",     # triple
    23: "HR",     # home run
}

# Every plate-appearance outcome the engine recognises, in display order.
OUTCOMES: tuple[str, ...] = ("K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER")


@dataclass(frozen=True)
class AtBat:
    """One completed plate appearance, from the play-by-play record."""

    year: int
    date: int         # YYYYMMDD, derived from the game id (for date filters)
    game_id: str      # Retrosheet game id — joins to game-level data
    batter: str       # Retrosheet player id
    bats: str         # "L" or "R" — the side actually batted from
    pitcher: str
    throws: str       # "L" or "R"
    outcome: str      # one of OUTCOMES
    inning: int
    half: str         # "top" or "bottom"
    outs: int         # outs before the plate appearance (0-2)
    bases: int        # runners on base, 0-7 (bit 0 = 1B, 1 = 2B, 2 = 3B)
    home_lead: int    # home score minus visitor score, before the play
    balls: int        # balls in the count when the plate appearance ended
    strikes: int      # strikes in the count when the plate appearance ended
    sh_fl: bool       # sacrifice hit (separates sac bunts from in-play outs)
    sf_fl: bool       # sacrifice fly (separates sac flies from in-play outs)
    # Schedule-density fields — populated by ``compute_rest`` after parsing.
    # Within-season only: 0 means "no prior in-season game" (the very first
    # game of the season, or a same-day prior game — a doubleheader's
    # second leg).
    batter_days_rest: int = 0
    pitcher_days_rest: int = 0
    batter_games_last_7: int = 0
    pitcher_games_last_7: int = 0


def _chadwick_tool(name: str) -> str:
    """Locate a Chadwick executable (``cwevent``, ``cwgame``, …).

    Looks on the PATH first, then in the usual Homebrew locations. Raises a
    clear error — naming the install command — when it cannot be found.
    """
    found = shutil.which(name)
    if found:
        return found
    for candidate in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}"):
        if Path(candidate).exists():
            return candidate
    raise FileNotFoundError(
        f"{name} (Chadwick) not found. Install it with 'brew install chadwick' "
        "on macOS, or see https://chadwick.readthedocs.io."
    )


def _at_bat(row: list[str], year: int) -> AtBat | None:
    """Build an ``AtBat`` from one cwevent row.

    Returns ``None`` when the row is not a completed plate appearance, or when
    the batter or pitcher hand is unknown so it cannot be placed in a split.
    """
    if len(row) <= _SF_FL or row[_BAT_EVENT_FL] != "T":
        return None  # not the play that ends a plate appearance
    outcome = _OUTCOME_BY_EVENT_CD.get(int(row[_EVENT_CD]))
    if outcome is None:
        return None  # a batting event we do not categorise
    bats, throws = row[_BAT_HAND], row[_PIT_HAND]
    if bats not in ("L", "R") or throws not in ("L", "R"):
        return None  # handedness unknown — cannot assign it to a split
    bases = (
        (1 if row[_BASE1_RUN] else 0)
        | (2 if row[_BASE2_RUN] else 0)
        | (4 if row[_BASE3_RUN] else 0)
    )
    game_id = row[_GAME_ID]
    # Retrosheet game ids embed the date — "ANA202404050" → 2024-04-05.
    date = int(game_id[3:11]) if len(game_id) >= 11 else year * 10000
    return AtBat(
        year=year,
        date=date,
        game_id=game_id,
        batter=row[_BAT_ID],
        bats=bats,
        pitcher=row[_PIT_ID],
        throws=throws,
        outcome=outcome,
        inning=int(row[_INNING]),
        half="bottom" if row[_BAT_HOME_ID] == "1" else "top",
        outs=int(row[_OUTS]),
        bases=bases,
        home_lead=int(row[_HOME_SCORE]) - int(row[_AWAY_SCORE]),
        balls=int(row[_BALLS]),
        strikes=int(row[_STRIKES]),
        sh_fl=row[_SH_FL] == "T",
        sf_fl=row[_SF_FL] == "T",
    )


def parse_events(events_dir: Path, year: int) -> list[AtBat]:
    """Parse one season's Retrosheet event files into plate-appearance records.

    ``events_dir`` holds the extracted event (``.EVA`` / ``.EVN``) and roster
    (``.ROS``) files for ``year``. Returns one ``AtBat`` per plate appearance;
    an empty list if the directory holds no event files.
    """
    event_files = sorted(
        path.name
        for path in events_dir.iterdir()
        if path.suffix.upper().startswith(".EV")
    )
    if not event_files:
        return []

    # cwevent reads the roster files from its working directory, so it must be
    # run there. -f 0-35 selects the columns indexed by the constants above.
    result = subprocess.run(
        [_chadwick_tool("cwevent"), "-y", str(year), "-f", _FIELD_RANGE, *event_files],
        cwd=events_dir,
        capture_output=True,
        text=True,
        check=True,
    )
    at_bats: list[AtBat] = []
    for row in csv.reader(result.stdout.splitlines()):
        at_bat = _at_bat(row, year)
        if at_bat is not None:
            at_bats.append(at_bat)
    return at_bats


def _ordinal(d: int) -> int:
    """Convert a YYYYMMDD integer to a serial day number."""
    return date(d // 10000, (d // 100) % 100, d % 100).toordinal()


def _rest_for(
    appearances: list[tuple[int, str]],
    current: tuple[int, str],
    ordinals: dict[int, int],
) -> tuple[int, int]:
    """For a sorted list of ``(date, game_id)`` tuples a player appeared in,
    return ``(days_rest, games_in_last_7_days)`` for the current appearance.

    Same-day prior games (doubleheaders) give ``days_rest = 0``; the very
    first appearance of the season also reports 0 (no in-season prior).
    """
    idx = bisect_left(appearances, current)
    if idx == 0:
        return (0, 0)
    prior = appearances[:idx]
    last_date = prior[-1][0]
    current_ord = ordinals[current[0]]
    days_rest = current_ord - ordinals[last_date]
    cutoff = current_ord - 6   # the 7-day window: today and the prior 6 days
    games_7 = sum(1 for d, _ in prior if ordinals[d] >= cutoff)
    return (days_rest, games_7)


def compute_rest(at_bats: list[AtBat]) -> list[AtBat]:
    """Populate the schedule-density fields on each plate appearance.

    Returns a new list of ``AtBat`` records with ``batter_days_rest``,
    ``pitcher_days_rest``, ``batter_games_last_7``, and
    ``pitcher_games_last_7`` filled in. Within-season only — prior seasons
    are not consulted, so the very first games of each year carry rest = 0.
    """
    if not at_bats:
        return []

    unique_dates = {ab.date for ab in at_bats}
    ordinals = {d: _ordinal(d) for d in unique_dates}

    appearances: dict[str, set[tuple[int, str]]] = defaultdict(set)
    for ab in at_bats:
        appearances[ab.batter].add((ab.date, ab.game_id))
        appearances[ab.pitcher].add((ab.date, ab.game_id))
    sorted_app = {player: sorted(games) for player, games in appearances.items()}

    enriched: list[AtBat] = []
    for ab in at_bats:
        key = (ab.date, ab.game_id)
        b_rest, b_g7 = _rest_for(sorted_app[ab.batter], key, ordinals)
        p_rest, p_g7 = _rest_for(sorted_app[ab.pitcher], key, ordinals)
        enriched.append(replace(
            ab,
            batter_days_rest=b_rest,
            pitcher_days_rest=p_rest,
            batter_games_last_7=b_g7,
            pitcher_games_last_7=p_g7,
        ))
    return enriched


def load_rosters(events_dir: Path) -> dict[str, str]:
    """Map Retrosheet player ids to "First Last" names.

    Reads the roster (``.ROS``) files in ``events_dir`` — one per team — each a
    CSV of ``id,last,first,bats,throws,team,position``.
    """
    names: dict[str, str] = {}
    for roster in sorted(events_dir.glob("*.ROS")):
        with open(roster, newline="", encoding="latin-1") as handle:
            for row in csv.reader(handle):
                if len(row) >= 3:
                    names[row[0]] = f"{row[2]} {row[1]}"
    return names


# ──────────────────────────────────────────────────────────────────────────
# Game-level data (cwgame) — weather, day/night, park, attendance, scores.
# ──────────────────────────────────────────────────────────────────────────

# cwgame output columns we read, by index.
_G_GAME_ID = 0
_G_DATE = 1             # "YYYYMMDD"
_G_DAY_OF_WEEK = 3      # "Monday" .. "Sunday"
_G_START_TIME = 4       # HHMM (0 = unknown)
_G_DAYNIGHT = 6         # "D" / "N" / "" (unknown)
_G_AWAY_TEAM = 7
_G_HOME_TEAM = 8
_G_PARK_ID = 9          # stadium id (e.g. "ANA01")
_G_ATTENDANCE = 18
_G_TEMP = 26            # F, 0 = unknown
_G_WIND_DIR = 27        # code 0-8 (0 = unknown)
_G_WIND_SPEED = 28      # mph
_G_FIELD_COND = 29      # code 0-4
_G_PRECIP = 30          # code 0-5
_G_SKY = 31             # code 0-5
_G_GAME_MINUTES = 32
_G_INNINGS = 33
_G_AWAY_SCORE = 34
_G_HOME_SCORE = 35
_G_FIELD_RANGE = "0-35"


@dataclass(frozen=True)
class Game:
    """One game's metadata — schedule, park, weather, summary scores."""

    game_id: str
    year: int
    date: int           # YYYYMMDD
    day_of_week: str    # "Monday" through "Sunday"
    start_time: int     # HHMM; 0 = unknown
    daynight: str       # "D", "N", or "" (unknown)
    away_team: str
    home_team: str
    park_id: str        # the stadium id (e.g. "ANA01")
    attendance: int
    temp: int           # F; 0 = unknown
    wind_dir: int       # code 0-8
    wind_speed: int     # mph
    field_cond: int     # code 0-4
    precip: int         # code 0-5
    sky: int            # code 0-5
    game_minutes: int
    innings: int
    away_score: int
    home_score: int


def _maybe_int(value: str) -> int:
    """Parse ``value`` as int, returning 0 on empty or malformed input."""
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


def parse_games(events_dir: Path, year: int) -> list[Game]:
    """Parse one season's Retrosheet event files into game records.

    Runs Chadwick's ``cwgame`` over the .EV* files in ``events_dir``; one row
    per game, carrying the schedule, park, weather, and final score.
    """
    event_files = sorted(
        path.name for path in events_dir.iterdir()
        if path.suffix.upper().startswith(".EV")
    )
    if not event_files:
        return []

    result = subprocess.run(
        [_chadwick_tool("cwgame"), "-y", str(year),
         "-f", _G_FIELD_RANGE, *event_files],
        cwd=events_dir,
        capture_output=True,
        text=True,
        check=True,
    )
    games: list[Game] = []
    for row in csv.reader(result.stdout.splitlines()):
        if len(row) <= _G_HOME_SCORE:
            continue
        games.append(Game(
            game_id=row[_G_GAME_ID],
            year=year,
            date=_maybe_int(row[_G_DATE]),
            day_of_week=row[_G_DAY_OF_WEEK],
            start_time=_maybe_int(row[_G_START_TIME]),
            daynight=row[_G_DAYNIGHT],
            away_team=row[_G_AWAY_TEAM],
            home_team=row[_G_HOME_TEAM],
            park_id=row[_G_PARK_ID],
            attendance=_maybe_int(row[_G_ATTENDANCE]),
            temp=_maybe_int(row[_G_TEMP]),
            wind_dir=_maybe_int(row[_G_WIND_DIR]),
            wind_speed=_maybe_int(row[_G_WIND_SPEED]),
            field_cond=_maybe_int(row[_G_FIELD_COND]),
            precip=_maybe_int(row[_G_PRECIP]),
            sky=_maybe_int(row[_G_SKY]),
            game_minutes=_maybe_int(row[_G_GAME_MINUTES]),
            innings=_maybe_int(row[_G_INNINGS]),
            away_score=_maybe_int(row[_G_AWAY_SCORE]),
            home_score=_maybe_int(row[_G_HOME_SCORE]),
        ))
    return games
