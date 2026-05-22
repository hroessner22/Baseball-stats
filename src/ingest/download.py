"""Download Retrosheet game-log files.

Retrosheet publishes one game-log file per season — a CSV with one row per
game. See https://www.retrosheet.org/gamelogs/ and the field definitions in
``glfields.txt``.
"""
from __future__ import annotations

import urllib.request
import zipfile
from pathlib import Path

GAMELOG_URL = "https://www.retrosheet.org/gamelogs/gl{year}.zip"


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
    with urllib.request.urlopen(request) as response:
        zip_path.write_bytes(response.read())

    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(raw_dir)

    if not txt_path.exists():
        raise FileNotFoundError(
            f"Expected {txt_path.name} inside {zip_path.name}, but it was not "
            f"found after extraction."
        )
    return txt_path
