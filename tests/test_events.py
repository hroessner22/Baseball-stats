"""Tests for Retrosheet event (play-by-play) parsing."""
from src.ingest.events import _at_bat


def _row(event_cd, bat_event_fl="T", bat_hand="R", pit_hand="R",
         inning="3", bat_home="0", outs="1", away="2", home="5",
         base1="", base2="", base3="",
         balls="0", strikes="0", sh_fl="F", sf_fl="F",
         game_id="ANA202404050"):
    """Build a 40-field cwevent row with only the columns ``_at_bat`` reads."""
    row = [""] * 40
    row[0] = game_id
    row[2] = inning
    row[3] = bat_home
    row[4] = outs
    row[5] = balls
    row[6] = strikes
    row[8] = away
    row[9] = home
    row[10] = "battr001"
    row[11] = bat_hand
    row[14] = "ptchr001"
    row[15] = pit_hand
    row[26] = base1
    row[27] = base2
    row[28] = base3
    row[34] = str(event_cd)
    row[35] = bat_event_fl
    row[38] = sh_fl
    row[39] = sf_fl
    return row


def test_at_bat_reads_a_strikeout():
    at_bat = _at_bat(_row(3), 2024)
    assert at_bat is not None
    assert at_bat.outcome == "K"
    assert at_bat.batter == "battr001"
    assert at_bat.pitcher == "ptchr001"
    assert at_bat.year == 2024


def test_at_bat_outcome_mapping():
    # cwevent EVENT_CD values mapped to the outcomes the engine records.
    assert _at_bat(_row(2), 2024).outcome == "OUT"
    assert _at_bat(_row(14), 2024).outcome == "BB"
    assert _at_bat(_row(15), 2024).outcome == "BB"     # intentional walk folds in
    assert _at_bat(_row(16), 2024).outcome == "HBP"
    assert _at_bat(_row(18), 2024).outcome == "OTHER"  # reached on error
    assert _at_bat(_row(20), 2024).outcome == "1B"
    assert _at_bat(_row(23), 2024).outcome == "HR"


def test_at_bat_skips_non_plate_appearance():
    # A stolen base mid-at-bat does not end a plate appearance (BAT_EVENT_FL "F").
    assert _at_bat(_row(4, bat_event_fl="F"), 2024) is None


def test_at_bat_skips_unknown_handedness():
    # A plate appearance with no known hand cannot be placed in a split.
    assert _at_bat(_row(3, bat_hand="?"), 2024) is None
    assert _at_bat(_row(3, pit_hand=""), 2024) is None


def test_at_bat_reads_the_situation():
    at_bat = _at_bat(
        _row(3, inning="7", bat_home="1", outs="2", away="1", home="4",
             base1="runr001", base3="runr003"),
        2024,
    )
    assert at_bat.inning == 7
    assert at_bat.half == "bottom"     # the home team is batting
    assert at_bat.outs == 2
    assert at_bat.home_lead == 3       # home 4 minus away 1
    assert at_bat.bases == 5           # runners on first (1) and third (4)


def test_at_bat_top_of_inning():
    assert _at_bat(_row(3, bat_home="0"), 2024).half == "top"


def test_at_bat_captures_the_count():
    at_bat = _at_bat(_row(3, balls="3", strikes="1"), 2024)
    assert at_bat.balls == 3
    assert at_bat.strikes == 1


def test_at_bat_captures_sacrifice_flags():
    sac_fly = _at_bat(_row(2, sf_fl="T"), 2024)
    sac_bunt = _at_bat(_row(2, sh_fl="T"), 2024)
    plain_out = _at_bat(_row(2), 2024)
    assert sac_fly.sf_fl is True and sac_fly.sh_fl is False
    assert sac_bunt.sh_fl is True and sac_bunt.sf_fl is False
    assert plain_out.sf_fl is False and plain_out.sh_fl is False


def test_at_bat_captures_game_id_and_date():
    at_bat = _at_bat(_row(3, game_id="NYA202405150"), 2024)
    assert at_bat.game_id == "NYA202405150"
    assert at_bat.date == 20240515
