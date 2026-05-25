"""Backfill ``daily_pa`` for a date range — one-off catch-up for seasons
that pre-date the daily cron.

The daily ingest cron started writing rows on 2026-05-17. Anything between
the Retrosheet play-by-play coverage (which ends 2024-12-31) and 2026-05-16
is a true gap — there's no batter_rates row, no daily_pa row, nothing. This
script walks a date range day-by-day, reuses the daily_ingest fetch/upsert
plumbing, and lands rows in ``daily_pa`` exactly like the cron would have
done if it had been running back then.

Idempotent: ``daily_pa`` has UNIQUE (game_pk, pa_index) + we send
``Prefer: resolution=ignore-duplicates``, so re-runs are safe.

Local run (needs both env vars):
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
        python -m src.backfill_history --start-date 2025-03-27 --end-date 2025-11-02

GitHub Actions: see ``.github/workflows/backfill-ingest.yml`` —
workflow_dispatch with start/end date inputs, runs with the same secrets
the daily cron uses.

Days with no MLB games (off-season, all-star break) are no-ops — the
schedule endpoint returns an empty list and we move on without making
any per-game calls.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
import urllib.error

from src.daily_ingest import (
    UpsertError,
    fetch_plate_appearances,
    list_finals_for,
    upsert,
)


def _daterange(start: dt.date, end: dt.date):
    cur = start
    while cur <= end:
        yield cur
        cur += dt.timedelta(days=1)


def _parse_date(s: str) -> dt.date:
    try:
        return dt.datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"bad date {s!r} (want YYYY-MM-DD)") from e


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start-date", type=_parse_date, required=True,
                   help="First date to ingest (YYYY-MM-DD), inclusive.")
    p.add_argument("--end-date",   type=_parse_date, required=True,
                   help="Last date to ingest (YYYY-MM-DD), inclusive.")
    p.add_argument("--game-delay-ms", type=int, default=100,
                   help="Sleep between per-game MLB Stats API calls. "
                        "Default 100ms — polite for an unauthenticated public feed.")
    args = p.parse_args()

    if args.end_date < args.start_date:
        print("--end-date is before --start-date.", file=sys.stderr)
        return 2

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    # Backfill requires service role (we're inserting at high volume, and
    # the anon key won't have write grants on daily_pa). Refuse to start
    # if only the anon key is set — it would just 401 on the first POST.
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment. "
            "Backfill needs the service_role key (not anon/publishable).",
            file=sys.stderr,
        )
        return 2

    total_days = (args.end_date - args.start_date).days + 1
    print(
        f"Backfilling daily_pa from {args.start_date} to {args.end_date} "
        f"({total_days} day{'s' if total_days != 1 else ''}).",
        flush=True,
    )

    delay = max(0, args.game_delay_ms) / 1000.0
    grand_games = 0
    grand_pas = 0
    grand_failed = 0
    started = time.time()

    for d in _daterange(args.start_date, args.end_date):
        ds = d.strftime("%Y-%m-%d")
        try:
            game_pks = list_finals_for(ds)
        except urllib.error.URLError as e:
            print(f"{ds}: schedule fetch failed — {e}", file=sys.stderr, flush=True)
            continue
        if not game_pks:
            # Off-season day / all-star break / scheduled-but-not-final
            # — nothing to do, move on.
            continue

        day_pas = 0
        day_failed = 0
        for pk in game_pks:
            try:
                pas = fetch_plate_appearances(pk)
            except Exception as e:
                print(f"  {ds} game {pk}: fetch failed — {e}",
                      file=sys.stderr, flush=True)
                day_failed += 1
                continue
            try:
                upsert(pas, url, key)
            except UpsertError as e:
                # Hard fail: auth/schema problems will hit every subsequent
                # upsert the same way. Bail loudly so we don't burn an hour
                # banging on a wall.
                print(
                    f"  {ds} game {pk}: upsert failed — {e}\n"
                    f"Aborting. Verify SUPABASE_SERVICE_KEY is the "
                    f"service_role secret (not anon).",
                    file=sys.stderr,
                    flush=True,
                )
                return 4
            day_pas += len(pas)
            if delay:
                time.sleep(delay)

        grand_games += len(game_pks)
        grand_pas += day_pas
        grand_failed += day_failed
        elapsed = int(time.time() - started)
        print(
            f"{ds}: {len(game_pks):>3} games, {day_pas:>4} PAs"
            + (f", {day_failed} failed" if day_failed else "")
            + f"   [{elapsed//60}m{elapsed%60:02d}s elapsed,"
              f" {grand_pas:,} PAs total]",
            flush=True,
        )

    print(
        f"\nDone. {grand_games} games, {grand_pas:,} PAs across {total_days} days"
        + (f", {grand_failed} games failed" if grand_failed else "")
        + "."
    )
    return 0 if grand_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
