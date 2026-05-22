"""Tests for the handedness-split rate tables."""
from src.engine.rates import (
    batter_line,
    league_line,
    open_rate_store,
    pitcher_line,
    tally_season,
    write_season,
)
from src.ingest.events import AtBat


def _ab(batter, bats, pitcher, throws, outcome):
    """An AtBat with the fields the rate tables use; the rest is filler."""
    return AtBat(
        year=2024, batter=batter, bats=bats, pitcher=pitcher, throws=throws,
        outcome=outcome, inning=1, half="top", outs=0, bases=0, home_lead=0,
    )


def test_tally_season_counts_each_table():
    tally = tally_season([
        _ab("judge", "R", "sale", "L", "HR"),
        _ab("judge", "R", "sale", "L", "K"),
        _ab("judge", "R", "cole", "R", "HR"),
    ])
    assert tally.batting[("judge", "R", "L", "HR")] == 1
    assert tally.batting[("judge", "R", "R", "HR")] == 1
    assert tally.pitching[("sale", "L", "R", "K")] == 1
    assert tally.league[("R", "L", "HR")] == 1


def test_rate_store_round_trip(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    at_bats = [_ab("judge", "R", "sale", "L", "HR")] * 3 \
        + [_ab("judge", "R", "sale", "L", "K")] * 2
    write_season(conn, 2024, tally_season(at_bats))

    line = batter_line(conn, "judge", 2024, 2024)
    assert line.total == 5
    assert line.counts["HR"] == 3
    assert line.hand == "R"
    assert line.rate("HR") == 0.6
    conn.close()


def test_batter_line_filters_by_pitcher_hand(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_season(conn, 2024, tally_season([
        _ab("judge", "R", "sale", "L", "HR"),
        _ab("judge", "R", "cole", "R", "K"),
        _ab("judge", "R", "cole", "R", "K"),
    ]))
    assert batter_line(conn, "judge", 2024, 2024, vs_hand="L").counts["HR"] == 1
    assert batter_line(conn, "judge", 2024, 2024, vs_hand="R").counts["K"] == 2
    conn.close()


def test_pitcher_line_and_league_line(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_season(conn, 2024, tally_season([
        _ab("lhb", "L", "sale", "L", "K"),
        _ab("rhb", "R", "sale", "L", "OUT"),
    ]))
    pitcher = pitcher_line(conn, "sale", 2024, 2024)
    assert pitcher.total == 2
    assert pitcher.hand == "L"
    assert pitcher_line(conn, "sale", 2024, 2024, vs_hand="L").counts["K"] == 1
    assert league_line(conn, "L", "L", 2024, 2024).counts["K"] == 1
    conn.close()


def test_batter_line_sums_a_year_range(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_season(conn, 2023, tally_season([_ab("judge", "R", "sale", "L", "HR")]))
    write_season(conn, 2024, tally_season([_ab("judge", "R", "sale", "L", "HR")]))
    assert batter_line(conn, "judge", 2023, 2024).counts["HR"] == 2
    assert batter_line(conn, "judge", 2024, 2024).counts["HR"] == 1
    conn.close()


def test_write_season_is_idempotent(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    tally = tally_season([_ab("judge", "R", "sale", "L", "HR")])
    write_season(conn, 2024, tally)
    write_season(conn, 2024, tally)
    # Re-writing a season replaces it rather than appending.
    assert batter_line(conn, "judge", 2024, 2024).total == 1
    conn.close()
