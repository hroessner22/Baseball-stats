"""Build the season-WPA leaderboard from daily_pa rows.

Win Probability Added (WPA) is the sum of per-PA home-WP swings,
signed for the player's team's perspective. It's the answer to "who
has actually moved games this season?" — every PA is a tug at the
WE; this script tallies up who did the tugging.

Pipeline:
  1. Load the v2 WE table from the generated Workers JS file. The
     table is keyed by (inning, half, outs, bases, home_lead) and
     came from 15M historical PAs.
  2. Pull every 2026 daily_pa row in chronological order, grouped by
     game.
  3. For each game, walk PAs in pa_index order:
       - Reconstruct pre-PA state (outs, bases, score) by replaying
         postPAState from inning start
       - Look up pre_we from v2 table
       - Apply outcome via postPAState to compute post-PA state
       - Look up post_we from v2 table
       - delta_home_we = post_we - pre_we
       - batter_wpa  += delta_home_we * (batter_team == "home" ? +1 : -1)
       - pitcher_wpa += delta_home_we * (pitcher_team == "home" ? +1 : -1)
         Note: pitcher_team is the OPPOSITE of batter_team, so the
         pitcher's sign is naturally opposite — a hit by the batter
         (home_we up if batter is home) is bad for the pitcher (who's
         on the away team there), so pitcher_wpa for that PA is
         negative.
  4. Aggregate per (player_mlbam, role) and upsert into wpa_season.

Run locally (needs the service role key — anon can't write):
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
        python -m src.build_wpa_season --season 2026

GitHub Actions cron: .github/workflows/build-wpa.yml — runs nightly
after the daily PA ingest finishes.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

import certifi


WE_TABLE_V2_PATH = Path("web/functions/api/games/_we_table_v2.js")


# ── load WE table ──────────────────────────────────────────────────

def load_we_table_v2() -> dict[str, float]:
    """Parse the generated Workers JS module to extract WE_TABLE_V2.

    The file is JS but its only value is a literal object — we slice
    out the JSON portion and json.loads it. No JS runtime needed.
    """
    text = WE_TABLE_V2_PATH.read_text()
    m = re.search(r"WE_TABLE_V2\s*=\s*(\{.*?\});", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"Couldn't parse WE_TABLE_V2 out of {WE_TABLE_V2_PATH}")
    return json.loads(m.group(1))


def lookup_we(table: dict[str, float], inning: int, half: str,
              outs: int, bases: int, home_lead: int) -> float | None:
    inn_c  = max(1, min(9, inning))
    lead_c = max(-10, min(10, home_lead))
    k = f"{inn_c}|{half}|{outs}|{bases}|{lead_c}"
    return table.get(k)


# ── state transition (Python port of the JS postPAState) ───────────

OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"]


def popcount(n: int) -> int:
    return ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1)


def post_pa_state(state: dict, outcome: str) -> dict:
    """Mirror of postPAState in we-projected.js / we-forward.js.

    Returns the post-PA state. If the PA ends the game, sets
    `terminal` to 1.0 (home wins) or 0.0 (home loses).
    """
    inning       = state["inning"]
    half         = state["half"]
    outs         = state["outs"]
    bases        = state["bases"]
    home_lead    = state["home_lead"]
    batting_team = state["batting_team"]

    on1 = (bases & 1) != 0
    on2 = (bases & 2) != 0
    on3 = (bases & 4) != 0
    runs = 0
    new_bases = bases
    outs_change = 0

    if outcome in ("K", "OUT", "OTHER"):
        outs_change = 1
    elif outcome in ("BB", "HBP"):
        new_bases = 1
        if on1:
            new_bases |= 2
            if on2:
                new_bases |= 4
                if on3: runs = 1
        if not on1:
            if on2: new_bases |= 2
            if on3: new_bases |= 4
    elif outcome == "1B":
        new_bases = 1
        if on1: new_bases |= 2
        if on2: runs += 1
        if on3: runs += 1
    elif outcome == "2B":
        new_bases = 2
        if on1: new_bases |= 4
        if on2: runs += 1
        if on3: runs += 1
    elif outcome == "3B":
        new_bases = 4
        runs += popcount(bases)
    elif outcome == "HR":
        new_bases = 0
        runs += popcount(bases) + 1

    if batting_team == "home":
        home_lead += runs
    else:
        home_lead -= runs

    # Walk-off — game ends as soon as the run scores.
    if inning >= 9 and half == "bottom" and home_lead > 0:
        return {**state, "outs": outs + outs_change, "bases": new_bases,
                "home_lead": home_lead, "terminal": 1.0}

    outs += outs_change
    if outs >= 3:
        if inning >= 9 and half == "bottom" and home_lead < 0:
            return {**state, "outs": 3, "bases": new_bases,
                    "home_lead": home_lead, "terminal": 0.0}
        if inning >= 9 and half == "top" and home_lead > 0:
            return {**state, "outs": 3, "bases": new_bases,
                    "home_lead": home_lead, "terminal": 1.0}
        # Normal half-flip — ghost runner on 2nd in extras.
        if half == "bottom": inning += 1
        half = "top" if half == "bottom" else "bottom"
        outs = 0
        new_bases = 2 if inning >= 10 else 0
        batting_team = "away" if batting_team == "home" else "home"

    return {"inning": inning, "half": half, "outs": outs, "bases": new_bases,
            "home_lead": home_lead, "batting_team": batting_team}


# ── Supabase REST helpers ──────────────────────────────────────────

def _ssl_ctx():
    return ssl.create_default_context(cafile=certifi.where())


def sb_select(url: str, key: str, table: str, params: dict) -> list:
    """Stream all rows from a Supabase table with pagination. The REST
    API caps a single page at 1000 rows by default; we follow until we
    get a short page.
    """
    rows = []
    offset = 0
    page = 1000
    while True:
        q = urllib.parse.urlencode({**params, "offset": offset, "limit": page})
        req = urllib.request.Request(
            f"{url}/rest/v1/{table}?{q}",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
            },
        )
        with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return rows


def sb_upsert(url: str, key: str, table: str, rows: list) -> int:
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}",
        data=body,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=120) as r:
        if r.status not in (200, 201):
            raise RuntimeError(f"HTTP {r.status}")
    return len(rows)


# ── main loop ──────────────────────────────────────────────────────

import urllib.parse  # noqa: E402  (placed after stdlib block for clarity)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, default=2026)
    p.add_argument("--limit-games", type=int, default=None,
                   help="(debug) only process the first N games")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.", file=sys.stderr)
        return 2

    print(f"Loading WE table from {WE_TABLE_V2_PATH}...")
    we_table = load_we_table_v2()
    print(f"  {len(we_table):,} cells loaded")

    print(f"\nFetching {args.season} daily_pa rows from Supabase...")
    t0 = time.time()
    rows = sb_select(url, key, "daily_pa", {
        "game_date":  f"gte.{args.season}-01-01",
        "select":     ",".join([
            "game_pk", "game_date", "inning", "half", "pa_index",
            "batter_mlbam", "pitcher_mlbam", "outcome",
        ]),
        "order": "game_pk.asc,pa_index.asc",
    })
    print(f"  {len(rows):,} PAs in {time.time() - t0:.1f}s")

    # Group by game_pk; PAs are already sorted by pa_index within game.
    games: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        games[r["game_pk"]].append(r)

    if args.limit_games:
        keys = sorted(games.keys())[:args.limit_games]
        games = {k: games[k] for k in keys}

    print(f"\nProcessing {len(games):,} games...")
    batter_wpa:  dict[int, float] = defaultdict(float)
    pitcher_wpa: dict[int, float] = defaultdict(float)
    batter_pa:   dict[int, int]   = defaultdict(int)
    pitcher_pa:  dict[int, int]   = defaultdict(int)
    skipped_pas = 0
    t0 = time.time()

    for game_pk, plays in games.items():
        # Initialize game state. The first PA of each game is top of 1,
        # 0 outs, no runners, 0-0.
        state = {
            "inning":       1,
            "half":         "top",
            "outs":         0,
            "bases":        0,
            "home_lead":    0,
            "batting_team": "away",
        }
        for play in plays:
            outcome = play["outcome"]
            if outcome not in OUTCOMES:
                skipped_pas += 1
                continue

            # The PA's stored (inning, half) is authoritative — if our
            # reconstruction disagrees (e.g. a mid-game PA we missed
            # in the chain), reset to match. This handles ingest gaps
            # gracefully.
            if state["inning"] != play["inning"] or state["half"] != play["half"]:
                state = {
                    **state,
                    "inning":       play["inning"],
                    "half":         play["half"],
                    "outs":         0,
                    "bases":        2 if play["inning"] >= 10 else 0,
                    "batting_team": "away" if play["half"] == "top" else "home",
                }

            pre_we = lookup_we(we_table, state["inning"], state["half"],
                               state["outs"], state["bases"], state["home_lead"])

            post = post_pa_state(state, outcome)
            post_we = (post.get("terminal")
                       if "terminal" in post
                       else lookup_we(we_table, post["inning"], post["half"],
                                      post["outs"], post["bases"], post["home_lead"]))

            if pre_we is None or post_we is None:
                skipped_pas += 1
                state = post
                continue

            delta_home = post_we - pre_we

            # Sign attribution. Home batter: their team's WE went up
            # → +delta. Away batter: home's WE went up means THEIR team
            # went down → -delta. Pitcher: opposite of the batter.
            batter_sign  = +1 if state["batting_team"] == "home" else -1
            pitcher_sign = -batter_sign

            batter_mlbam  = play["batter_mlbam"]
            pitcher_mlbam = play["pitcher_mlbam"]
            batter_wpa[batter_mlbam]   += delta_home * batter_sign
            pitcher_wpa[pitcher_mlbam] += delta_home * pitcher_sign
            batter_pa[batter_mlbam]    += 1
            pitcher_pa[pitcher_mlbam]  += 1

            state = post

    print(f"  done in {time.time() - t0:.1f}s · skipped {skipped_pas:,} PAs (no WE cell)")
    print(f"  {len(batter_wpa):,} unique batters · {len(pitcher_wpa):,} unique pitchers")

    # Upload to Supabase. Batch — wpa_season has ~1500 batters + 1500 pitchers
    # so a single POST works comfortably.
    upload_rows = []
    for pid, wpa in batter_wpa.items():
        upload_rows.append({
            "player_mlbam": pid, "role": "batter",
            "season": args.season,
            "wpa": round(wpa, 6),
            "pa_count": batter_pa[pid],
        })
    for pid, wpa in pitcher_wpa.items():
        upload_rows.append({
            "player_mlbam": pid, "role": "pitcher",
            "season": args.season,
            "wpa": round(wpa, 6),
            "pa_count": pitcher_pa[pid],
        })

    print(f"\nUploading {len(upload_rows):,} rows to wpa_season ({args.season})...")
    t0 = time.time()
    sb_upsert(url, key, "wpa_season", upload_rows)
    print(f"  done in {time.time() - t0:.1f}s")

    # Spot-check: print the top 10 batters and top 10 pitchers.
    print()
    print(f"Top 10 batters by WPA ({args.season}):")
    sorted_b = sorted(batter_wpa.items(), key=lambda x: -x[1])[:10]
    for pid, wpa in sorted_b:
        print(f"  {pid}: WPA {wpa:+.3f}  ({batter_pa[pid]} PA)")
    print()
    print(f"Top 10 pitchers by WPA ({args.season}):")
    sorted_p = sorted(pitcher_wpa.items(), key=lambda x: -x[1])[:10]
    for pid, wpa in sorted_p:
        print(f"  {pid}: WPA {wpa:+.3f}  ({pitcher_pa[pid]} BF)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
