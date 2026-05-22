"""Download Retrosheet game-log and event files.

Retrosheet publishes one game-log file per season — a CSV with one row per
game (https://www.retrosheet.org/gamelogs/) — and per-season event files
carrying full play-by-play (https://www.retrosheet.org/events/).
"""
from __future__ import annotations

import ssl
import urllib.request
import zipfile
from pathlib import Path

import certifi

GAMELOG_URL = "https://www.retrosheet.org/gamelogs/gl{year}.zip"
EVENTS_URL = "https://www.retrosheet.org/events/{year}eve.zip"

# Verify HTTPS certificates against certifi's CA bundle. The framework Python
# build on macOS does not expose usable system certificates to urllib.
_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def download_gamelog(year: int, raw_dir: Path) -> Path:
    """Download and extract the Retrosheet game log for ``year``.

    Returns the path to the extracted ``gl{year}.txt`` file. If that file is
    already present the download is skipped.
    """
    raw_dir.mkdir(parents=True, exist_ok=True)
    txt_path = raw_dir / f"gl{year}.txt"
    if txt_path.exists():
        return txt_path

    zip_path = raw_dir / f"gl{year}.zip"
    url = GAMELOG_URL.format(year=year)
    print(f"Downloading {url} ...")
    request = urllib.request.Request(
        url, headers={"User-Agent": "Baseball-stats/0.1"}
    )
    with urllib.request.urlopen(request, context=_SSL_CONTEXT) as response:
        zip_path.write_bytes(response.read())

    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(raw_dir)

    if not txt_path.exists():
        raise FileNotFoundError(
            f"Expected {txt_path.name} inside {zip_path.name}, but it was not "
            f"found after extraction."
        )
    return txt_path


def download_seasons(
    start_year: int, end_year: int, raw_dir: Path
) -> list[tuple[int, Path]]:
    """Download every Retrosheet game log from ``start_year`` to ``end_year``.

    Returns ``(year, path)`` pairs for the seasons obtained, in order. A season
    that cannot be downloaded is reported and skipped rather than aborting the
    whole run.
    """
    seasons: list[tuple[int, Path]] = []
    for year in range(start_year, end_year + 1):
        try:
            seasons.append((year, download_gamelog(year, raw_dir)))
        except Exception as error:  # skip one season, keep the run going
            print(f"  could not download {year}: {error}")
    return seasons


def download_events(year: int, raw_dir: Path) -> Path:
    """Download and extract the Retrosheet event files for ``year``.

    Returns the directory holding that season's extracted event (``.EVA`` /
    ``.EVN``) and roster (``.ROS``) files. An already-extracted season is
    reused rather than downloaded again.
    """
    season_dir = raw_dir / f"events{year}"
    if season_dir.exists() and any(season_dir.glob("*.EV*")):
        return season_dir
    season_dir.mkdir(parents=True, exist_ok=True)

    zip_path = raw_dir / f"{year}eve.zip"
    url = EVENTS_URL.format(year=year)
    print(f"Downloading {url} ...")
    request = urllib.request.Request(
        url, headers={"User-Agent": "Baseball-stats/0.1"}
    )
    with urllib.request.urlopen(request, context=_SSL_CONTEXT) as response:
        zip_path.write_bytes(response.read())

    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(season_dir)
    return season_dir


def download_event_seasons(
    start_year: int, end_year: int, raw_dir: Path
) -> list[tuple[int, Path]]:
    """Download every Retrosheet event season from ``start_year`` to ``end_year``.

    Returns ``(year, directory)`` pairs for the seasons obtained, in order. A
    season that cannot be downloaded is reported and skipped.
    """
    seasons: list[tuple[int, Path]] = []
    for year in range(start_year, end_year + 1):
        try:
            seasons.append((year, download_events(year, raw_dir)))
        except Exception as error:  # skip one season, keep the run going
            print(f"  could not download {year} events: {error}")
    return seasons
