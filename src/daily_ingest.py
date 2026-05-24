"""Daily ingest of yesterday's plate appearances from the MLB Stats API
into the Supabase ``daily_pa`` event log.

This is the "self-learning" loop: each morning, run this script (via
GitHub Actions cron — see ``.github/workflows/daily-ingest.yml``) and
every completed plate appearance from the prior day's slate lands in
the event log. The matchup engine queries this log alongside the
frozen ``batter_rates`` / ``pitcher_rates`` baselines, so predictions
sharpen as the season's sample grows.

The script is idempotent — the ``daily_pa`` table has a
``UNIQUE (game_pk, pa_index)`` constraint and we send
``Prefer: resolution=ignore-duplicates`` so reruns are safe.

Run locally:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python -m src.daily_ingest

Pin a specific date:
    python -m src.daily_ingest --date 2026-05-23
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

import certifi


MLB_BASE = "https://statsapi.mlb.com/api/v1"
MLB_BASE_V11 = "https://statsapi.mlb.com/api/v1.1"
UA = "DIAMOND:CONTEXT/1.0 (+https://diamond-context.pages.dev)"

# Runner-only events that the MLB Stats API still classifies as
# ``result.type == "atBat"``. Silently skip; they aren't plate
# appearances. Anything not in this set AND not in OUTCOME_MAP gets a
# warning, so genuinely new outcomes don't slip through unmapped.
NON_PA_EVENT_TYPES: set[str] = {
    "caught_stealing_2b", "caught_stealing_3b", "caught_stealing_home",
    "pickoff_caught_stealing_2b", "pickoff_caught_stealing_3b",
    "pickoff_caught_stealing_home",
    "pickoff_1b", "pickoff_2b", "pickoff_3b",
    "stolen_base_2b", "stolen_base_3b", "stolen_base_home",
    "wild_pitch", "passed_ball",
    "balk", "defensive_indiff", "other_advance",
    "runner_double_play", "runner_placed",
    "game_advisory", "ejection",
}

# Map the MLB Stats API ``eventType`` enum onto our nine-bucket outcome
# space. The buckets line up with what the matchup engine already knows
# how to consume from the historical batter_rates / pitcher_rates tables.
OUTCOME_MAP: dict[str, str] = {
    "strikeout":                    "K",
    "strikeout_double_play":        "K",
    "strikeout_triple_play":        "K",
    "walk":                         "BB",
    "intent_walk":                  "BB",
    "hit_by_pitch":                 "HBP",
    "single":                       "1B",
    "double":                       "2B",
    "triple":                       "3B",
    "home_run":                     "HR",
    # Outs in play
    "field_out":                    "OUT",
    "force_out":                    "OUT",
    "grounded_into_double_play":    "OUT",
    "grounded_into_triple_play":    "OUT",
    "double_play":                  "OUT",
    "triple_play":                  "OUT",
    "sac_fly":                      "OUT",
    "sac_fly_double_play":          "OUT",
    "sac_bunt":                     "OUT",
    "sac_bunt_double_play":         "OUT",
    "fielders_choice_out":          "OUT",
    # Reach-on-error / catcher's interference / etc. — keep separate so
    # they don't pollute the OUT bucket.
    "field_error":                  "OTHER",
    "fielders_choice":              "OTHER",
    "catcher_interf":               "OTHER",
    "batter_interference":          "OTHER",
    "fan_interference":             "OTHER",
}


def _ssl_ctx() -> ssl.SSLContext:
    # macOS framework Python ships without CA certs; certifi works on every OS.
    return ssl.create_default_context(cafile=certifi.where())


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=30) as r:
        return json.load(r)


def list_finals_for(date: str) -> list[int]:
    """Return game_pk of every game on `date` that's already Final."""
    url = f"{MLB_BASE}/schedule?date={date}&sportId=1"
    data = _fetch_json(url)
    out: list[int] = []
    for day in data.get("dates", []):
        for g in day.get("games", []):
            status = (g.get("status") or {}).get("abstractGameState")
            if status == "Final":
                out.append(g["gamePk"])
    return out


def fetch_plate_appearances(game_pk: int) -> list[dict]:
    """Pull every PA from one game's live feed, shaped for daily_pa insert."""
    feed = _fetch_json(f"{MLB_BASE_V11}/game/{game_pk}/feed/live")
    game_date = ((feed.get("gameData") or {}).get("datetime") or {}).get("officialDate")
    plays = ((feed.get("liveData") or {}).get("plays") or {}).get("allPlays", [])

    out: list[dict] = []
    for i, play in enumerate(plays):
        result = play.get("result") or {}
        # Filter to plate appearances. Pickoffs, mound visits, pitching
        # changes etc. all show up in allPlays but aren't PAs.
        if result.get("type") != "atBat":
            continue
        event_type = result.get("eventType") or ""
        if event_type in NON_PA_EVENT_TYPES:
            # Runner event the API still tags as atBat. Silent skip.
            continue
        outcome = OUTCOME_MAP.get(event_type)
        if not outcome:
            # Unmapped eventType that LOOKS like a PA — log and skip rather
            # than guess. If this fires for a new outcome bucket, add it.
            print(
                f"  game {game_pk} PA {i}: unknown eventType "
                f"{event_type!r} ({result.get('event')!r})",
                file=sys.stderr,
            )
            continue

        matchup = play.get("matchup") or {}
        batter = matchup.get("batter") or {}
        pitcher = matchup.get("pitcher") or {}
        if not batter.get("id") or not pitcher.get("id"):
            continue

        about = play.get("about") or {}
        count = play.get("count") or {}

        # Base state at the END of the PA — runners standing after the play
        # resolved. (Pre-PA base state requires looking at the prior play;
        # for v0.1 we ship with post-PA bases and revisit when the splits
        # actually need pre-PA context.)
        bases = 0
        if matchup.get("postOnFirst"):  bases |= 1
        if matchup.get("postOnSecond"): bases |= 2
        if matchup.get("postOnThird"):  bases |= 4

        out.append({
            "game_pk":       game_pk,
            "game_date":     game_date,
            "inning":        about.get("inning"),
            "half":          "top" if about.get("isTopInning") else "bottom",
            "pa_index":      i,
            "batter_mlbam":  batter["id"],
            "batter_hand":   (matchup.get("batSide") or {}).get("code") or "R",
            "pitcher_mlbam": pitcher["id"],
            "pitcher_hand":  (matchup.get("pitchHand") or {}).get("code") or "R",
            "balls":         count.get("balls"),
            "strikes":       count.get("strikes"),
            "outs":          count.get("outs"),
            "bases_state":   bases,
            "outcome":       outcome,
        })
    return out


class UpsertError(RuntimeError):
    """Raised when the Supabase POST fails outright. The caller distinguishes
    this from "wrote zero rows" (which legitimately happens when every row
    in the batch was already in the table)."""


def upsert(rows: list[dict], supabase_url: str, supabase_key: str) -> int:
    """POST rows to the daily_pa table; the unique constraint dedupes.

    Returns the number of rows the server accepted. Raises UpsertError on
    any transport / auth / schema failure — the caller treats those very
    differently from "0 rows written because all were duplicates", which
    is a legitimate outcome on a re-run.
    """
    if not rows:
        return 0
    url = f"{supabase_url}/rest/v1/daily_pa"
    body = json.dumps(rows).encode("utf-8")
    # Ask Supabase to return the rows it actually inserted so we can count
    # truthfully. `return=minimal` swallowed the count and made every
    # duplicate look the same as every success.
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey":         supabase_key,
            "Authorization":  f"Bearer {supabase_key}",
            "Content-Type":   "application/json",
            "Prefer":         "resolution=ignore-duplicates,return=representation",
        },
    )
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=60) as r:
            if r.status not in (200, 201):
                raise UpsertError(f"HTTP {r.status}")
            body = r.read() or b"[]"
            inserted = json.loads(body)
            return len(inserted) if isinstance(inserted, list) else 0
    except urllib.error.HTTPError as e:
        msg = (e.read() or b"").decode("utf-8", errors="replace")[:500]
        raise UpsertError(f"HTTP {e.code}: {msg}") from e


def rows_to_sql(rows: list[dict]) -> str:
    """Render parsed rows as a single INSERT … ON CONFLICT DO NOTHING block.

    Used by --print-sql for one-off backfills run via the Supabase MCP /
    SQL editor. Each row's string fields are quoted with PostgreSQL's
    standard single-quote escaping (double the quote). Numeric fields go
    in bare; NULLs become the keyword.
    """
    if not rows:
        return "-- (no rows)"

    def q(v: object) -> str:
        if v is None:
            return "NULL"
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        if isinstance(v, (int, float)):
            return str(v)
        # string
        return "'" + str(v).replace("'", "''") + "'"

    cols = ["game_pk", "game_date", "inning", "half", "pa_index",
            "batter_mlbam", "batter_hand", "pitcher_mlbam", "pitcher_hand",
            "balls", "strikes", "outs", "bases_state", "outcome"]

    values = ",\n  ".join(
        "(" + ", ".join(q(r.get(c)) for c in cols) + ")"
        for r in rows
    )
    return (
        f"INSERT INTO daily_pa\n  ({', '.join(cols)})\nVALUES\n  "
        f"{values}\nON CONFLICT (game_pk, pa_index) DO NOTHING;"
    )


def _yesterday_eastern() -> str:
    # MLB's day boundary is roughly midnight Eastern. Run the ingest at
    # ~7 AM ET, ask for "yesterday" in ET terms. UTC-5 (EST) covers
    # winter; in summer UTC-4 (EDT) is correct but we don't need precision
    # better than a calendar day so UTC-5 is fine year-round here.
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)
    return (now.date() - dt.timedelta(days=1)).strftime("%Y-%m-%d")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--date",
        help="YYYY-MM-DD to ingest. Default: yesterday in Eastern time.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and parse but skip the Supabase upsert.",
    )
    parser.add_argument(
        "--print-sql",
        action="store_true",
        help="Emit a single INSERT … ON CONFLICT DO NOTHING statement on "
             "stdout instead of upserting via PostgREST. Useful for one-off "
             "backfills via the Supabase MCP / SQL editor.",
    )
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") \
                   or os.environ.get("SUPABASE_ANON_KEY", "")
    needs_creds = not (args.dry_run or args.print_sql)
    if needs_creds and (not supabase_url or not supabase_key):
        print(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment. "
            "Set both, or pass --dry-run / --print-sql to skip the upsert.",
            file=sys.stderr,
        )
        return 2

    date = args.date or _yesterday_eastern()
    # When --print-sql is active stdout is reserved for SQL; route the
    # progress lines through stderr so the SQL file stays clean.
    log_stream = sys.stderr if args.print_sql else sys.stdout
    print(f"Ingesting plate appearances for {date}…", file=log_stream)

    try:
        game_pks = list_finals_for(date)
    except urllib.error.URLError as e:
        print(f"Could not fetch schedule for {date}: {e}", file=sys.stderr)
        return 3
    print(f"  {len(game_pks)} final game(s) on the slate", file=log_stream)

    total_pas = 0
    total_inserted = 0
    failed = 0
    all_rows: list[dict] = []
    for pk in game_pks:
        try:
            pas = fetch_plate_appearances(pk)
            total_pas += len(pas)
        except Exception as e:
            print(f"  game {pk}: fetch failed — {e}", file=sys.stderr)
            failed += 1
            continue
        if args.print_sql:
            all_rows.extend(pas)
            print(f"  game {pk}: {len(pas)} PAs queued for SQL", file=sys.stderr)
            continue
        if args.dry_run:
            print(f"  game {pk}: {len(pas)} PAs (dry-run, not inserted)")
            continue
        try:
            n = upsert(pas, supabase_url, supabase_key)
        except UpsertError as e:
            # An auth / schema failure means every subsequent batch will
            # fail the same way — bail loudly rather than pretend each
            # game is "all duplicates".
            print(
                f"  game {pk}: upsert failed — {e}\n"
                f"Aborting. Check that SUPABASE_SERVICE_KEY is the "
                f"service_role secret (not the anon or publishable key).",
                file=sys.stderr,
            )
            return 4
        total_inserted += n
        marker = "" if n == len(pas) else f"  ← {len(pas) - n} skipped (already in DB)"
        print(f"  game {pk}: {n} of {len(pas)} PAs inserted{marker}")

    if args.print_sql:
        print(rows_to_sql(all_rows))
        print(
            f"\n-- {len(all_rows)} rows ready to insert (for {date}).",
            file=sys.stderr,
        )
        return 0 if failed == 0 else 1

    print(
        f"\nDone. {total_pas} PAs parsed from {len(game_pks)} games"
        + (f", {total_inserted} new rows inserted" if not args.dry_run else " (dry-run)")
        + (f", {failed} games failed" if failed else "")
        + "."
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
