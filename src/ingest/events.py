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
from dataclasses import dataclass
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


def _cwevent_path() -> str:
    """Locate the Chadwick ``cwevent`` executable.

    Looks on the PATH first, then in the usual Homebrew locations. Raises a
    clear error — naming the install command — when it cannot be found.
    """
    found = shutil.which("cwevent")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/cwevent", "/usr/local/bin/cwevent"):
        if Path(candidate).exists():
            return candidate
    raise FileNotFoundError(
        "cwevent (Chadwick) not found. Install it with 'brew install chadwick' "
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
        [_cwevent_path(), "-y", str(year), "-f", _FIELD_RANGE, *event_files],
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
