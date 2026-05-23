"""Download Statcast pitch-level data from Baseball Savant via pybaseball.

Statcast is the MLB-provided system that has tracked every pitch and batted
ball since the 2015 season. Each pitch carries the pitch type, release
velocity and spin, movement, and (for batted balls) launch speed and angle.

We use the ``pybaseball`` library to handle the download — it walks
Baseball Savant's CSV endpoint in week-sized chunks and stitches the result
into a single pandas DataFrame.
"""
from __future__ import annotations


def fetch_season(year: int):
    """Download every regular-season Statcast pitch for one year.

    Returns the raw pybaseball DataFrame (118 columns). The caller persists
    it via ``rates.write_pitches``.

    ``pybaseball`` is imported lazily — its first import triggers a slow
    matplotlib font-cache build and we want the cost paid only when actually
    downloading, not at module-load time.
    """
    from pybaseball import statcast

    return statcast(
        start_dt=f"{year}-03-15",
        end_dt=f"{year}-11-15",
        verbose=False,
    )
