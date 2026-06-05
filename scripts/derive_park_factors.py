"""Derive empirical park factors from Retrosheet game logs.

We have 132 seasons of game-by-game data sitting in `data/raw/glYYYY.zip`.
Each row is one game with the park ID + offensive totals for both
teams. Park factor for a stat S at park P is:

    factor_S(P) = (S per team-game at P) / (S per team-game league-wide)

We pool the last N years (default 7) for stability — single-season
factors are noisy because home/away schedules don't perfectly balance.

Outputs `web/functions/api/_park_factors.json` with rows like
  { "park_id": "PHI13", "home_team": "PHI",
    "games": 612, "runs": 1.06, "hr": 1.13, "hits": 1.01 }
which `_park_factors.js` reads at request time.

Run:
    python scripts/derive_park_factors.py
"""

from __future__ import annotations

import collections
import csv
import io
import json
import pathlib
import sys
import zipfile


ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW  = ROOT / "data" / "raw"
OUT  = ROOT / "web" / "functions" / "api" / "_park_factors.json"

# Retrosheet gamelog field indices (0-based). Schema documented in
# data/raw/glfields.txt. We only need a handful.
F_HOME_TEAM = 6   # field 7
F_PARK_ID   = 16  # field 17
F_V_H       = 22  # field 23 — visitor hits
F_V_HR      = 25  # field 26 — visitor HR
F_V_RUNS_LS = 9   # field 10 — visitor final runs
F_H_H       = 50  # field 51 — home hits
F_H_HR      = 53  # field 54 — home HR
F_H_RUNS_LS = 10  # field 11 — home final runs

YEARS = list(range(2018, 2025))   # 2018-2024 = 7 most recent seasons
MIN_GAMES_FOR_PARK = 50           # ignore parks with too-small sample

# Retrosheet park ID → current MLB team tricode. Built from
# 2024 schedule data + manual lookups for the relocations.
# When a park hosts multiple teams (legacy or temporary), we
# attribute the factor to whoever plays there most recently.
PARK_TO_TEAM = {
    # AL East
    "BAL12": "BAL",   # Camden Yards
    "BOS07": "BOS",   # Fenway
    "NYC21": "NYY",   # Yankee Stadium (current)
    "STP01": "TB",    # Tropicana Field
    "TOR02": "TOR",   # Rogers Centre
    # AL Central
    "CHI12": "CHW",   # Guaranteed Rate
    "CLE08": "CLE",   # Progressive
    "DET05": "DET",   # Comerica
    "KAN06": "KC",    # Kauffman
    "MIN04": "MIN",   # Target Field
    # AL West
    "HOU03": "HOU",   # Minute Maid
    "ANA01": "LAA",   # Angel Stadium
    "OAK01": "OAK",   # Oakland Coliseum (through 2024)
    "WSAC01": "OAK",  # West Sac (Athletics 2025 temp) — counted to OAK row
    "SEA03": "SEA",   # T-Mobile
    "ARL02": "TEX",   # Globe Life Field (pre-2020 home — kept for alias)
    "ARL03": "TEX",   # Globe Life Field (Retrosheet's current ID)
    # NL East
    "ATL03": "ATL",   # Truist
    "MIA02": "MIA",   # loanDepot
    "NYC20": "NYM",   # Citi Field
    "PHI13": "PHI",   # Citizens Bank
    "WAS11": "WSH",   # Nationals Park
    # NL Central
    "CHI11": "CHC",   # Wrigley
    "CIN09": "CIN",   # Great American
    "MIL06": "MIL",   # American Family
    "PIT08": "PIT",   # PNC
    "STL10": "STL",   # Busch
    # NL West
    "PHO01": "ARI",   # Chase
    "DEN02": "COL",   # Coors
    "LOS03": "LAD",   # Dodger Stadium
    "SAN02": "SD",    # Petco
    "SFO03": "SF",    # Oracle
}


def parse_int(s: str) -> int:
    if not s or s == "(none)":
        return 0
    try:
        return int(s)
    except ValueError:
        return 0


def iter_rows(year: int):
    """Yield CSV rows from glYYYY.zip → glYYYY.txt."""
    zip_path = RAW / f"gl{year}.zip"
    if not zip_path.exists():
        # Fall back to unzipped .txt if user already extracted.
        txt_path = RAW / f"gl{year}.txt"
        if txt_path.exists():
            with open(txt_path) as f:
                yield from csv.reader(f)
            return
        print(f"  missing data/raw/gl{year}.zip", file=sys.stderr)
        return
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith(".txt")]
        for name in names:
            with zf.open(name) as f:
                wrap = io.TextIOWrapper(f, encoding="latin-1", newline="")
                yield from csv.reader(wrap)


def main() -> int:
    by_park = collections.defaultdict(lambda: {"games": 0, "runs": 0, "hits": 0, "hr": 0})
    league  = {"games": 0, "runs": 0, "hits": 0, "hr": 0}

    for year in YEARS:
        n = 0
        for row in iter_rows(year):
            if len(row) < max(F_H_HR, F_H_RUNS_LS, F_PARK_ID) + 1:
                continue
            park = row[F_PARK_ID].strip('"').strip()
            if not park:
                continue
            v_runs = parse_int(row[F_V_RUNS_LS])
            h_runs = parse_int(row[F_H_RUNS_LS])
            v_h    = parse_int(row[F_V_H])
            h_h    = parse_int(row[F_H_H])
            v_hr   = parse_int(row[F_V_HR])
            h_hr   = parse_int(row[F_H_HR])

            # Each game contributes 2 team-games (home + visitor).
            by_park[park]["games"] += 2
            by_park[park]["runs"]  += v_runs + h_runs
            by_park[park]["hits"]  += v_h + h_h
            by_park[park]["hr"]    += v_hr + h_hr

            league["games"] += 2
            league["runs"]  += v_runs + h_runs
            league["hits"]  += v_h + h_h
            league["hr"]    += v_hr + h_hr
            n += 1
        print(f"  {year}: {n} games", file=sys.stderr)

    # League per-team-game rates.
    lg_runs = league["runs"] / league["games"]
    lg_hits = league["hits"] / league["games"]
    lg_hr   = league["hr"]   / league["games"]
    print(
        f"\nLeague per team-game ({YEARS[0]}-{YEARS[-1]}):\n"
        f"  runs {lg_runs:.3f} · hits {lg_hits:.3f} · HR {lg_hr:.3f}\n",
        file=sys.stderr,
    )

    out_rows = []
    by_team = {}
    for park, agg in sorted(by_park.items()):
        if agg["games"] < MIN_GAMES_FOR_PARK:
            continue
        team = PARK_TO_TEAM.get(park)
        if not team:
            # Unknown park — could be Williamsport, Field of Dreams,
            # Mexico City, Seoul Series, etc. Skip silently.
            continue
        runs = (agg["runs"] / agg["games"]) / lg_runs
        hits = (agg["hits"] / agg["games"]) / lg_hits
        hr   = (agg["hr"]   / agg["games"]) / lg_hr
        out_rows.append({
            "park_id":   park,
            "home_team": team,
            "games":     agg["games"] // 2,    # back to games (not team-games)
            "runs":      round(runs, 3),
            "hits":      round(hits, 3),
            "hr":        round(hr,   3),
        })
        # If multiple parks map to the same team (relocation),
        # weighted-average them.
        prev = by_team.get(team)
        if prev is None:
            by_team[team] = {**out_rows[-1]}
        else:
            tg  = prev["games"] + out_rows[-1]["games"]
            for k in ("runs", "hits", "hr"):
                prev[k] = round((prev[k] * prev["games"] + out_rows[-1][k] * out_rows[-1]["games"]) / tg, 3)
            prev["games"] = tg
            prev["park_id"] = f"{prev['park_id']},{out_rows[-1]['park_id']}"

    final = {
        "source":      "Retrosheet game logs",
        "seasons":     f"{YEARS[0]}-{YEARS[-1]}",
        "league_per_team_game": {
            "runs": round(lg_runs, 3),
            "hits": round(lg_hits, 3),
            "hr":   round(lg_hr, 3),
        },
        "factors":     by_team,
        "parks_seen":  out_rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(final, indent=2))

    # Pretty-print the team-level summary.
    print(f"Wrote {OUT.relative_to(ROOT)}\n", file=sys.stderr)
    print(f"{'TEAM':<5} {'GAMES':>6} {'RUNS':>6} {'HITS':>6} {'HR':>6}", file=sys.stderr)
    for team in sorted(by_team):
        r = by_team[team]
        print(f"{team:<5} {r['games']:>6} {r['runs']:>6} {r['hits']:>6} {r['hr']:>6}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
