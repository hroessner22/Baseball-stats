// Park factors for all 30 MLB stadiums.
//
// EMPIRICALLY DERIVED from Retrosheet game logs — see
// scripts/derive_park_factors.py. Pulled 2018-2024 (7 most recent
// seasons, ~515 games per park) to balance recency with sample size.
//
// League per team-game over this window:
//   runs 4.525 · hits 8.313 · HR 1.200
//
// Factor = (rate at park) / (league rate). > 1.00 = batter-friendly,
// < 1.00 = pitcher-friendly. To regenerate after a season ends, edit
// YEARS in derive_park_factors.py and run `python scripts/derive_park_factors.py`.
//
// Lookup by current home-team tricode. Relocations are aliased.

export const PARK_FACTORS = {
    // AL East
    BAL: { runs: 1.045, hr: 1.128, hits: 1.046 },
    BOS: { runs: 1.128, hr: 0.995, hits: 1.104 },
    NYY: { runs: 0.997, hr: 1.198, hits: 0.952 },
    TB:  { runs: 0.906, hr: 0.890, hits: 0.932 },
    TOR: { runs: 0.997, hr: 1.096, hits: 1.006 },

    // AL Central
    CHW: { runs: 0.986, hr: 1.012, hits: 0.994 },
    CLE: { runs: 0.946, hr: 0.944, hits: 0.975 },
    DET: { runs: 0.958, hr: 0.851, hits: 0.998 },
    KC:  { runs: 1.052, hr: 0.835, hits: 1.077 },
    MIN: { runs: 1.018, hr: 1.042, hits: 1.018 },

    // AL West
    HOU: { runs: 0.974, hr: 1.060, hits: 0.973 },
    LAA: { runs: 1.032, hr: 1.124, hits: 0.986 },
    OAK: { runs: 0.932, hr: 0.880, hits: 0.956 },
    ATH: { runs: 0.932, hr: 0.880, hits: 0.956 },   // alias for OAK (2025 Sacramento)
    SEA: { runs: 0.901, hr: 0.995, hits: 0.915 },
    TEX: { runs: 1.088, hr: 1.106, hits: 1.031 },   // Globe Life Field

    // NL East
    ATL: { runs: 1.028, hr: 1.030, hits: 1.008 },
    MIA: { runs: 0.949, hr: 0.823, hits: 1.002 },
    NYM: { runs: 0.906, hr: 0.970, hits: 0.928 },
    PHI: { runs: 1.021, hr: 1.088, hits: 1.002 },
    WSH: { runs: 1.038, hr: 1.042, hits: 1.044 },

    // NL Central
    CHC: { runs: 0.969, hr: 0.962, hits: 0.976 },
    CIN: { runs: 1.069, hr: 1.210, hits: 1.014 },
    MIL: { runs: 0.962, hr: 1.062, hits: 0.924 },
    PIT: { runs: 1.004, hr: 0.824, hits: 1.019 },
    STL: { runs: 0.943, hr: 0.859, hits: 0.986 },

    // NL West
    ARI: { runs: 1.044, hr: 0.895, hits: 1.037 },
    COL: { runs: 1.259, hr: 1.121, hits: 1.190 },
    LAD: { runs: 0.959, hr: 1.168, hits: 0.943 },
    SD:  { runs: 0.920, hr: 0.963, hits: 0.951 },
    SF:  { runs: 0.922, hr: 0.780, hits: 0.989 },
};

const NEUTRAL = { runs: 1.00, hr: 1.00, hits: 1.00 };

export function parkFactor(teamAbbr) {
    if (!teamAbbr) return NEUTRAL;
    const key = String(teamAbbr).toUpperCase();
    return PARK_FACTORS[key] || NEUTRAL;
}
