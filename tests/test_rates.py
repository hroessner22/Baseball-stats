"""Tests for the at-bats store and queries."""
from src.engine.rates import (
    batter_line,
    league_line,
    open_rate_store,
    pitcher_line,
    query_outcomes,
    stored_game_years,
    stored_rate_years,
    write_at_bats,
    write_games,
)
from src.ingest.events import AtBat, Game


def _ab(batter="bttr", bats="R", pitcher="ptch", throws="R", outcome="OUT",
        year=2024, inning=1, outs=0, bases=0, balls=0, strikes=0,
        home_lead=0, half="top", sh_fl=False, sf_fl=False,
        game_id="TST202404010", date=20240401,
        batter_days_rest=0, pitcher_days_rest=0,
        batter_games_last_7=0, pitcher_games_last_7=0):
    """An AtBat with sensible defaults; tests override only what they need."""
    return AtBat(
        year=year, date=date, game_id=game_id,
        batter=batter, bats=bats, pitcher=pitcher, throws=throws,
        outcome=outcome, inning=inning, half=half,
        outs=outs, bases=bases, home_lead=home_lead,
        balls=balls, strikes=strikes, sh_fl=sh_fl, sf_fl=sf_fl,
        batter_days_rest=batter_days_rest,
        pitcher_days_rest=pitcher_days_rest,
        batter_games_last_7=batter_games_last_7,
        pitcher_games_last_7=pitcher_games_last_7,
    )


def _game(game_id="TST202404010", year=2024, date=20240401,
          daynight="D", home_team="HOM", away_team="AWY", park_id="PARK01",
          temp=72, wind_speed=5, attendance=30000, sky=1,
          day_of_week="Monday", innings=9):
    """A Game with sensible defaults; tests override only what they need."""
    return Game(
        game_id=game_id, year=year, date=date,
        day_of_week=day_of_week, start_time=1900, daynight=daynight,
        away_team=away_team, home_team=home_team, park_id=park_id,
        attendance=attendance, temp=temp, wind_dir=0, wind_speed=wind_speed,
        field_cond=0, precip=0, sky=sky, game_minutes=180, innings=innings,
        away_score=0, home_score=0,
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


# ── Game-level filters (Stage 2) ────────────────────────────────────────


def test_write_and_read_games(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_games(conn, 2024, [_game(game_id="HOM202404010", daynight="N", temp=68)])
    assert stored_game_years(conn) == (2024, 2024, 1)
    conn.close()


def test_filter_by_daynight(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_games(conn, 2024, [
        _game(game_id="HOM202404010", daynight="D"),
        _game(game_id="HOM202404020", daynight="N"),
    ])
    write_at_bats(conn, 2024, [
        _ab(game_id="HOM202404010", outcome="HR"),
        _ab(game_id="HOM202404020", outcome="K"),
        _ab(game_id="HOM202404020", outcome="K"),
    ])
    assert query_outcomes(conn, daynight="D").counts == {"HR": 1}
    assert query_outcomes(conn, daynight="N").counts == {"K": 2}
    conn.close()


def test_filter_by_temperature_range(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_games(conn, 2024, [
        _game(game_id="HOT202404010", temp=92),
        _game(game_id="COLD202404020", temp=45),
    ])
    write_at_bats(conn, 2024, [
        _ab(game_id="HOT202404010", outcome="HR"),
        _ab(game_id="COLD202404020", outcome="OUT"),
    ])
    hot = query_outcomes(conn, temp_range=(80, 100))
    cold = query_outcomes(conn, temp_range=(0, 60))
    assert hot.counts == {"HR": 1}
    assert cold.counts == {"OUT": 1}
    conn.close()


def test_filter_by_home_team(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_games(conn, 2024, [
        _game(game_id="NYA202404010", home_team="NYA"),
        _game(game_id="LAN202404020", home_team="LAN"),
    ])
    write_at_bats(conn, 2024, [
        _ab(game_id="NYA202404010", batter="judge", outcome="HR"),
        _ab(game_id="LAN202404020", batter="judge", outcome="K"),
    ])
    judge_at_yankee = batter_line(conn, "judge", home_team="NYA")
    assert judge_at_yankee.counts == {"HR": 1}
    conn.close()


def test_at_bats_without_games_still_work(tmp_path):
    # If games are not yet ingested, at-bat-only queries still work — the
    # LEFT JOIN supplies NULLs that non-game filters don't constrain.
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [_ab(batter="judge", outcome="HR")])
    assert batter_line(conn, "judge").counts == {"HR": 1}
    conn.close()


def test_write_games_is_idempotent(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_games(conn, 2024, [_game(game_id="X1")])
    write_games(conn, 2024, [_game(game_id="X1")])
    assert stored_game_years(conn) == (2024, 2024, 1)
    conn.close()


# ── Schedule density (Stage 3) ──────────────────────────────────────────


def test_filter_by_days_rest(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(batter="judge", outcome="HR", batter_days_rest=4),
        _ab(batter="judge", outcome="K", batter_days_rest=1),
        _ab(batter="judge", outcome="K", batter_days_rest=0),
    ])
    rested = batter_line(conn, "judge", batter_days_rest_range=(3, 7))
    tired = batter_line(conn, "judge", batter_days_rest_range=(0, 1))
    assert rested.counts == {"HR": 1}
    assert tired.total == 2


def test_filter_by_games_last_7(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(batter="judge", outcome="HR", batter_games_last_7=0),
        _ab(batter="judge", outcome="OUT", batter_games_last_7=5),
        _ab(batter="judge", outcome="OUT", batter_games_last_7=6),
    ])
    busy = batter_line(conn, "judge", batter_games_last_7_range=(5, 7))
    fresh = batter_line(conn, "judge", batter_games_last_7=0)
    assert busy.total == 2
    assert fresh.counts == {"HR": 1}


def test_filter_by_pitcher_days_rest(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    write_at_bats(conn, 2024, [
        _ab(pitcher="sale", outcome="K", pitcher_days_rest=4),
        _ab(pitcher="sale", outcome="HR", pitcher_days_rest=0),
    ])
    rested = pitcher_line(conn, "sale", pitcher_days_rest_range=(3, 10))
    assert rested.counts == {"K": 1}
