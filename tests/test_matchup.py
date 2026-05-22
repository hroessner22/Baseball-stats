"""Tests for the batter-versus-pitcher matchup engine."""
from src.engine.matchup import _regressed, predict, predict_matchup
from src.engine.rates import RateLine, open_rate_store, tally_season, write_season
from src.ingest.events import AtBat


def _line(**counts):
    """A RateLine from outcome=count keyword arguments."""
    return RateLine(counts=dict(counts))


def _ab(batter, bats, pitcher, throws, outcome):
    """An AtBat carrying only the fields the rate tables read."""
    return AtBat(
        year=2024, batter=batter, bats=bats, pitcher=pitcher, throws=throws,
        outcome=outcome, inning=1, half="top", outs=0, bases=0, home_lead=0,
    )


def test_predict_sums_to_one():
    predicted = predict(
        _line(K=20, BB=10, HR=5, OUT=65),
        _line(K=30, BB=5, HR=2, OUT=63),
        _line(K=22, BB=8, HR=3, OUT=67),
    )
    assert abs(sum(predicted.values()) - 1.0) < 1e-9


def test_predict_collapses_to_pitcher_for_average_batter():
    # A batter whose rates equal the league's yields the pitcher's rates.
    league = _line(K=20, BB=10, HR=10, OUT=60)
    batter = _line(K=20, BB=10, HR=10, OUT=60)
    pitcher = _line(K=40, BB=5, HR=5, OUT=50)
    predicted = predict(batter, pitcher, league, regression_pa=0)
    assert abs(predicted["K"] - 0.40) < 1e-9
    assert abs(predicted["HR"] - 0.05) < 1e-9


def test_predict_collapses_to_batter_for_average_pitcher():
    league = _line(K=20, BB=10, HR=10, OUT=60)
    pitcher = _line(K=20, BB=10, HR=10, OUT=60)
    batter = _line(K=5, BB=25, HR=20, OUT=50)
    predicted = predict(batter, pitcher, league, regression_pa=0)
    assert abs(predicted["HR"] - 0.20) < 1e-9


def test_predict_compounds_shared_tendencies():
    # Both batter and pitcher above the league on strikeouts: the prediction
    # exceeds both — the odds-ratio multiplies, it does not average.
    league = _line(K=20, BB=20, HR=20, OUT=40)
    batter = _line(K=30, BB=20, HR=10, OUT=40)
    pitcher = _line(K=30, BB=20, HR=10, OUT=40)
    predicted = predict(batter, pitcher, league, regression_pa=0)
    assert predicted["K"] > 0.30


def test_regressed_blends_toward_the_league():
    league = _line(K=20, BB=10, HR=10, OUT=60)
    player = _line(K=100)  # 100 plate appearances, all strikeouts
    blended = _regressed(player, league, regression_pa=100)
    # 100 own PA plus 100 of league ballast — halfway to the league rate.
    assert abs(blended["K"] - 0.60) < 1e-9


def test_regressed_with_no_data_is_the_league():
    league = _line(K=22, BB=8, OUT=70)
    blended = _regressed(RateLine(counts={}), league, regression_pa=100)
    assert abs(blended["K"] - 0.22) < 1e-9


def test_predict_matchup_uses_handedness_splits(tmp_path):
    conn = open_rate_store(tmp_path / "rates.db")
    # "slug" bats right; he homers off lefties but strikes out against righties.
    write_season(conn, 2024, tally_season(
        [_ab("slug", "R", "lefty", "L", "HR")] * 40
        + [_ab("slug", "R", "lefty", "L", "OUT")] * 10
        + [_ab("slug", "R", "righty", "R", "K")] * 50
        + [_ab("filler", "L", "lefty", "L", "OUT")] * 50
        + [_ab("filler", "R", "lefty", "L", "K")] * 50
    ))
    matchup = predict_matchup(conn, "slug", "lefty", 2024, 2024, regression_pa=0)
    assert matchup.bats == "R"
    assert matchup.throws == "L"
    # It must use slug's record versus left-handers — 40 homers, no strikeouts.
    assert matchup.batter_rates.counts.get("HR", 0) == 40
    assert matchup.batter_rates.counts.get("K", 0) == 0
    assert matchup.chance("HR") > matchup.chance("K")
    conn.close()
