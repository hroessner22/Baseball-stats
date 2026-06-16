"""Fetch Kalshi MLB slate markets and cache them in Supabase.

WHY THIS EXISTS
---------------
Kalshi rate-limits requests per source IP, and Cloudflare's shared worker
egress IP is throttled hard — even a valid per-key signature 429s from a
Cloudflare Worker (proven 2026-06-15). So the Cloudflare Pages Functions
backend cannot fetch Kalshi market lists reliably.

This script runs in GitHub Actions, whose runner IPs are NOT throttled. It
fetches the slate series (moneyline / spread / total), signs each request
with the service API key, and upserts the raw market lists into the Supabase
table `kalshi_series_cache`. The worker then reads that table instead of
hitting Kalshi (see web/functions/api/_markets.js listKalshiMlbMarkets).

Live PRICES still hydrate client-side from the orderbook; this only supplies
the slate STRUCTURE (which games/markets exist + a fallback mid price), which
changes slowly, so a ~5-minute refresh is plenty.

Run locally:
    KALSHI_API_KEY_ID=... KALSHI_PRIVATE_KEY="$(cat key.pem)" \\
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
        python -m src.kalshi_markets
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

import certifi
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

KALSHI_HOST = "https://api.elections.kalshi.com"
MARKETS_PATH = "/trade-api/v2/markets"

# The slate dashboard (/api/markets?scope=game_day) renders only
# moneyline / spread / total, which come from exactly these three series.
SLATE_SERIES = ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"]

PAGE_LIMIT = 400          # Kalshi max page size
MAX_PAGES = 6             # safety cap: 6 * 400 = 2400 markets/series


def _ssl_ctx() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _load_key(pem: str):
    return serialization.load_pem_private_key(pem.encode("utf-8"), password=None)


def _sign(private_key, method: str, path: str) -> tuple[str, str]:
    """Kalshi RSA-PSS signature over `timestamp + METHOD + path` (path has
    no query string). Returns (timestamp_ms, base64_signature). salt_length
    = digest length (32 for SHA-256), matching the browser/worker client."""
    timestamp = str(int(time.time() * 1000))
    msg = (timestamp + method.upper() + path).encode("utf-8")
    sig = private_key.sign(
        msg,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=hashes.SHA256().digest_size,
        ),
        hashes.SHA256(),
    )
    return timestamp, base64.b64encode(sig).decode("ascii")


def _auth_headers(private_key, key_id: str, method: str, path: str) -> dict:
    timestamp, signature = _sign(private_key, method, path)
    return {
        "KALSHI-ACCESS-KEY":       key_id,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "User-Agent":              "diamond-context-markets-ingest/1.0",
    }


def fetch_series(private_key, key_id: str, series: str) -> list[dict]:
    """Fetch all open markets for one series, paginating via cursor."""
    out: list[dict] = []
    cursor = ""
    for _ in range(MAX_PAGES):
        query = f"?series_ticker={series}&status=open&limit={PAGE_LIMIT}"
        if cursor:
            query += f"&cursor={cursor}"
        # Sign the PATH ONLY (no query) — Kalshi signs the bare path.
        headers = _auth_headers(private_key, key_id, "GET", MARKETS_PATH)
        req = urllib.request.Request(
            f"{KALSHI_HOST}{MARKETS_PATH}{query}", method="GET", headers=headers,
        )
        with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        markets = data.get("markets") or []
        out.extend(markets)
        cursor = data.get("cursor") or ""
        if not cursor or not markets:
            break
    return out


def upsert_series(url: str, key: str, series: str, markets: list[dict]) -> None:
    """Upsert one row (series_ticker PK) into kalshi_series_cache."""
    row = {
        "series_ticker": series,
        "markets":       markets,
        "market_count":  len(markets),
        # PostgREST encodes this straight into timestamptz.
        "fetched_at":    time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }
    body = json.dumps([row]).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/kalshi_series_cache",
        data=body,
        method="POST",
        headers={
            "apikey":        key,
            "Authorization": f"Bearer {key}",
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=60) as r:
        if r.status not in (200, 201, 204):
            raise RuntimeError(f"Supabase upsert HTTP {r.status}")


def main() -> int:
    key_id = os.environ.get("KALSHI_API_KEY_ID")
    pem    = os.environ.get("KALSHI_PRIVATE_KEY")
    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_KEY")
    missing = [n for n, v in [
        ("KALSHI_API_KEY_ID", key_id), ("KALSHI_PRIVATE_KEY", pem),
        ("SUPABASE_URL", sb_url), ("SUPABASE_SERVICE_KEY", sb_key),
    ] if not v]
    if missing:
        print(f"ERROR: missing env: {', '.join(missing)}", file=sys.stderr)
        return 2

    private_key = _load_key(pem)
    failures = 0
    for series in SLATE_SERIES:
        try:
            markets = fetch_series(private_key, key_id, series)
        except urllib.error.HTTPError as e:
            print(f"  {series}: Kalshi HTTP {e.code} — {e.reason}", file=sys.stderr)
            failures += 1
            continue
        except Exception as e:  # noqa: BLE001
            print(f"  {series}: fetch failed — {e}", file=sys.stderr)
            failures += 1
            continue
        try:
            upsert_series(sb_url, sb_key, series, markets)
        except Exception as e:  # noqa: BLE001
            print(f"  {series}: Supabase upsert failed — {e}", file=sys.stderr)
            failures += 1
            continue
        print(f"  {series}: {len(markets)} markets cached")

    if failures:
        print(f"Completed with {failures}/{len(SLATE_SERIES)} series failing",
              file=sys.stderr)
        # Partial success is still useful (the worker reads whatever landed),
        # but exit non-zero if EVERYTHING failed so the Action surfaces it.
        return 1 if failures == len(SLATE_SERIES) else 0
    print("All slate series cached.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
