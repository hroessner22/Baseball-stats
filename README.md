# Baseball-stats

A learning project that builds baseball statistics tables from Retrosheet
play-by-play data.

## Milestone 1

Build a win-probability lookup table: for every combination of inning and
score difference, compute the historical percentage of games that the team
in that situation went on to win, using the 2024 MLB season.

## Project layout

- `data/` — downloaded Retrosheet CSV data files
- `src/` — Python source code
- `venv/` — the project's private Python sandbox (not uploaded to GitHub)

## Setup

1. Create the sandbox:  `python3 -m venv venv`
2. Activate it:         `source venv/bin/activate`
3. Install libraries:   `pip install -r requirements.txt`
