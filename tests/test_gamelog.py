"""Tests for Retrosheet game-log parsing."""
from src.ingest.gamelog import _game_states, parse_line_score


def test_parse_line_score_basic():
    assert parse_line_score("000030001") == [0, 0, 0, 0, 3, 0, 0, 0, 1]


def test_parse_line_score_multi_digit_inning():
    assert parse_line_score("00(10)0") == [0, 0, 10, 0]


def test_parse_line_score_team_did_not_bat():
    # The home team led after the top of the 9th and did not bat ("x").
    assert parse_line_score("10000200x") == [1, 0, 0, 0, 0, 2, 0, 0, None]


def test_parse_line_score_empty():
    assert parse_line_score("") == []


def _row(date, visitor_score, home_score, visitor_line, home_line):
    """Build a minimal game-log row with only the fields the parser reads."""
    row = [""] * 21
    row[0] = date
    row[9] = visitor_score
    row[10] = home_score
    row[19] = visitor_line
    row[20] = home_line
    return row


def test_game_states_tags_year_and_outcome():
    # Home wins 9-0; every state should be tagged 2025 with home_won True.
    states = _game_states(_row("20250612", "0", "9", "000000000", "333000000"))
    assert states
    assert all(s.year == 2025 and s.home_won for s in states)


def test_game_states_tracks_the_lead():
    states = _game_states(_row("20240401", "2", "1", "100000001", "000100000"))
    # End of the top of the 1st: the visitor scored 1, the home team is down 1.
    top_1 = next(s for s in states if s.inning == 1 and s.half == "top")
    assert top_1.home_lead == -1
    # End of the bottom of the 4th: the home team has tied it at 1-1.
    bottom_4 = next(s for s in states if s.inning == 4 and s.half == "bottom")
    assert bottom_4.home_lead == 0


def test_game_states_skips_a_tie():
    assert _game_states(_row("20250612", "4", "4", "000000004", "000000004")) == []


def test_game_states_skips_inconsistent_line_score():
    # The line score sums to 5, but the recorded final score is 9.
    assert _game_states(_row("20250612", "0", "9", "000000000", "000000005")) == []
