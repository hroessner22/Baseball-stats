"""Tests for the at-bats store and queries."""
from src.engine.rates import (
    batter_line,
    league_line,
    open_rate_store,
    pitcher_line,
    query_outcomes,
    stored_rate_years,
    write_at_bats,
)
from src.ingest.events import AtBat


def _ab(batter="bttr", bats="R", pitcher="ptch", throws="R", outcome="OUT",
        year=2024, inning=1, outs=0, bases=0, balls=0, strikes=0,
        home_lead=0, half="top", sh_fl=False, sf_fl=False,
        game_id="TST202404010", date=20240401):
    """An AtBat with sensible defaults; tests override only what they need."""
    return AtBat(
        year=year, date=date, game_id=game_id,
        batter=batter, bats=bats, pitcher=pitcher, throws=throws,
        outcome=outcome, inning=inning, half=half,
        outs=outs, bases=bases, home_lead=home_lead,
        balls=balls, strikes=strikes, sh_fl=sh_fl, sf_fl=sf_fl,
    )


def test_write_at_bats_and_read_back(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(batter="judge", bats="R", pitcher="sale", throws="L", outcome="HR"),
        _ab(batter="judge", bats="R", pitcher="sale", throws="L", outcome="HR"),
        _ab(batter="judge", bats="R", pitcher="sale", throws="L", outcome="K"),
    ])
    line = batter_line(conn, "judge")
    assert line.total == 3
    assert line.counts["HR"] == 2
    assert line.counts["K"] == 1
    assert line.hand == "R"
    conn.close()


def test_batter_line_filters_by_pitcher_hand(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(batter="judge", bats="R", pitcher="lhp", throws="L", outcome="HR"),
        _ab(batter="judge", bats="R", pitcher="rhp", throws="R", outcome="K"),
        _ab(batter="judge", bats="R", pitcher="rhp", throws="R", outcome="K"),
    ])
    vs_l = batter_line(conn, "judge", throws="L")
    vs_r = batter_line(conn, "judge", throws="R")
    assert vs_l.counts["HR"] == 1 and vs_l.total == 1
    assert vs_r.counts["K"] == 2 and vs_r.total == 2
    conn.close()


def test_pitcher_line_filters_by_batter_hand(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(batter="a", bats="L", pitcher="sale", throws="L", outcome="K"),
        _ab(batter="b", bats="R", pitcher="sale", throws="L", outcome="OUT"),
    ])
    assert pitcher_line(conn, "sale", bats="L").counts["K"] == 1
    assert pitcher_line(conn, "sale", bats="R").counts["OUT"] == 1
    conn.close()


def test_league_line_with_handedness(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(bats="L", throws="R", outcome="HR"),
        _ab(bats="L", throws="R", outcome="HR"),
        _ab(bats="R", throws="L", outcome="K"),
    ])
    lr = league_line(conn, bats="L", throws="R")
    rl = league_line(conn, bats="R", throws="L")
    assert lr.counts["HR"] == 2
    assert rl.counts["K"] == 1
    conn.close()


def test_filter_by_outs(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(outs=0, outcome="OUT"),
        _ab(outs=2, outcome="HR"),
        _ab(outs=2, outcome="K"),
    ])
    two_out = query_outcomes(conn, outs=2)
    assert two_out.total == 2
    assert two_out.counts["HR"] == 1 and two_out.counts["K"] == 1
    conn.close()


def test_filter_by_risp(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(bases=0, outcome="OUT"),    # empty
        _ab(bases=1, outcome="K"),      # 1B only — not RISP
        _ab(bases=2, outcome="HR"),     # 2B only — RISP
        _ab(bases=4, outcome="1B"),     # 3B only — RISP
        _ab(bases=6, outcome="2B"),     # 2B + 3B — RISP
    ])
    risp = query_outcomes(conn, risp=True)
    assert risp.total == 3
    assert risp.counts["HR"] == 1
    assert risp.counts["1B"] == 1
    assert risp.counts["2B"] == 1
    conn.close()


def test_filter_by_count(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(balls=0, strikes=2, outcome="K"),
        _ab(balls=0, strikes=2, outcome="OUT"),
        _ab(balls=3, strikes=1, outcome="BB"),
    ])
    oh_two = query_outcomes(conn, count=(0, 2))
    three_one = query_outcomes(conn, count=(3, 1))
    assert oh_two.total == 2
    assert three_one.counts["BB"] == 1
    conn.close()


def test_year_range_filter_and_sum(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2023, [_ab(batter="judge", outcome="HR")])
    write_at_bats(conn, 2024, [_ab(batter="judge", outcome="HR")])
    assert batter_line(conn, "judge", year_range=(2023, 2024)).counts["HR"] == 2
    assert batter_line(conn, "judge", year_range=(2024, 2024)).counts["HR"] == 1
    conn.close()


def test_write_at_bats_is_idempotent(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [_ab(batter="judge", outcome="HR")])
    write_at_bats(conn, 2024, [_ab(batter="judge", outcome="HR")])
    # Re-writing a season replaces it rather than appending.
    assert batter_line(conn, "judge").total == 1
    conn.close()


def test_stored_rate_years(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2022, [_ab()])
    write_at_bats(conn, 2024, [_ab()])
    assert stored_rate_years(conn) == (2022, 2024, 2)
    conn.close()
