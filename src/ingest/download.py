"""Download Retrosheet game-log files.

Retrosheet publishes one game-log file per season — a CSV with one row per
game. See https://www.retrosheet.org/gamelogs/ and the field definitions in
``glfields.txt``.
"""
from __future__ import annotations

import ssl
import urllib.request
import zipfile
from pathlib import Path

import certifi

GAMELOG_URL = "https://www.retrosheet.org/gamelogs/gl{year}.zip"

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
