"""The batter-versus-pitcher matchup engine.

Predicts the outcome distribution for a plate appearance by combining three
rate lines — the batter's, the pitcher's, and the league baseline — with the
odds-ratio method (Bill James's log5, generalised to many outcomes):

    predicted[o]  is proportional to  batter[o] * pitcher[o] / league[o]

normalised so the probabilities sum to one. When the batter is league-average
the prediction collapses to the pitcher's rates, and vice versa. Small samples
are first regressed toward the league baseline, so a handful of plate
appearances cannot dominate the estimate.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from src.engine.rates import RateLine, batter_line, league_line, pitcher_line
from src.ingest.events import OUTCOMES

# League-average plate appearances mixed into each player's record before the
# matchup. A player with this many PA is weighted half-and-half with the
# league; with far more, his own record dominates. Tunable.
REGRESSION_PA = 100


@dataclass
class Matchup:
    """A predicted plate-appearance outcome distribution, with its inputs."""

    batter: str
    pitcher: str
    bats: str                     # the batter's side for this matchup
    throws: str                   # the pitcher's throwing hand
    predicted: dict[str, float]   # outcome -> probability, sums to 1
    batter_rates: RateLine        # the batter's record vs this pitcher's hand
    pitcher_rates: RateLine       # the pitcher's record vs this batter's side
    league: RateLine              # the baseline for this handedness matchup

    def chance(self, outcome: str) -> float:
        """The predicted probability of ``outcome`` (0.0-1.0)."""
        return self.predicted.get(outcome, 0.0)


def _regressed(
    line: RateLine, league: RateLine, regression_pa: float
) -> dict[str, float]:
    """A player's outcome rates, padded with league-average plate appearances."""
    total = line.total + regression_pa
    if total <= 0:
        return {o: league.rate(o) for o in OUTCOMES}
    return {
        o: (line.counts.get(o, 0) + regression_pa * league.rate(o)) / total
        for o in OUTCOMES
    }


def predict(
    batter_rates: RateLine,
    pitcher_rates: RateLine,
    league: RateLine,
    regression_pa: float = REGRESSION_PA,
) -> dict[str, float]:
    """Combine three rate lines into a normalised outcome distribution.

    Uses the odds-ratio method. ``regression_pa`` of league-average ballast is
    blended into each player's rates first; pass 0 for the unregressed result.
    """
    bat = _regressed(batter_rates, league, regression_pa)
    pit = _regressed(pitcher_rates, league, regression_pa)

    raw: dict[str, float] = {}
    for outcome in OUTCOMES:
        lg = league.rate(outcome)
        raw[outcome] = bat[outcome] * pit[outcome] / lg if lg > 0 else 0.0

    total = sum(raw.values())
    if total <= 0:
        return {o: league.rate(o) for o in OUTCOMES}
    return {o: raw[o] / total for o in OUTCOMES}


def predict_matchup(
    conn: sqlite3.Connection,
    batter: str,
    pitcher: str,
    start_year: int,
    end_year: int,
    regression_pa: float = REGRESSION_PA,
) -> Matchup:
    """Look up both players over [start_year, end_year] and predict the matchup.

    The pitcher's throwing hand selects which of the batter's platoon splits to
    use, and the batter's side selects the pitcher's — so the prediction always
    rests on the handedness-appropriate records.
    """
    throws = pitcher_line(conn, pitcher, start_year, end_year).hand
    batter_rates = batter_line(conn, batter, start_year, end_year, vs_hand=throws)
    bats = batter_rates.hand
    pitcher_rates = pitcher_line(conn, pitcher, start_year, end_year, vs_hand=bats)
    league = league_line(conn, bats, throws, start_year, end_year)

    predicted = predict(batter_rates, pitcher_rates, league, regression_pa)
    return Matchup(
        batter=batter,
        pitcher=pitcher,
        bats=bats,
        throws=throws,
        predicted=predicted,
        batter_rates=batter_rates,
        pitcher_rates=pitcher_rates,
        league=league,
    )
