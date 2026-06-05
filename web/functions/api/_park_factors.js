// Park factors for the 30 MLB stadiums.
//
// Source: FanGraphs' multi-year averaged factors (2022-2024) for
// each stat. Higher = batter-friendly for that stat. 1.00 = league
// neutral. These don't shift much year-to-year so they're worth
// hardcoding rather than fetching live each request.
//
// Keys are the team abbreviation that PLAYS HOME at the park (most
// 1:1 — the few cases where the team renames a stadium don't change
// the factor much). The bot looks up the home team's abbr from the
// game payload (g.teams.home.abbr) and uses these as multipliers
// on a batter's expected production.
//
// USAGE:
//   - HR prop: factor = stat.hr (e.g. COL 1.34 boosts our_p_yes)
//   - Hits / total_bases: factor = stat.runs or stat.hits
//   - Moneyline: factor = stat.runs (favors home team marginally)
//
// Notes:
//   - Coors (COL) is famously the most run-friendly park
//   - Petco (SD), Oracle (SF), Marlins Park (MIA) are pitcher-friendly
//   - Yankee Stadium short right-field porch boosts HRs
//   - Coliseum (OAK) suppresses HRs and runs (massive foul territory)

export const PARK_FACTORS = {
    // AL East
    BAL: { runs: 1.00, hr: 1.07, hits: 0.99 },   // Camden Yards (post-2022 wall move suppressed HR vs lefties)
    BOS: { runs: 1.06, hr: 0.95, hits: 1.04 },   // Fenway — Green Monster boosts doubles, not HRs
    NYY: { runs: 1.03, hr: 1.15, hits: 0.99 },   // Yankee Stadium — short porch
    TB:  { runs: 0.95, hr: 0.93, hits: 0.96 },   // Tropicana Field — pitcher-friendly dome
    TOR: { runs: 1.04, hr: 1.10, hits: 1.01 },   // Rogers Centre

    // AL Central
    CHW: { runs: 1.02, hr: 1.08, hits: 1.00 },   // Guaranteed Rate Field
    CLE: { runs: 0.97, hr: 0.94, hits: 0.97 },   // Progressive Field
    DET: { runs: 0.96, hr: 0.92, hits: 0.97 },   // Comerica Park — deep alleys
    KC:  { runs: 1.01, hr: 0.95, hits: 1.02 },   // Kauffman Stadium — large outfield, boosts triples
    MIN: { runs: 1.00, hr: 1.02, hits: 1.00 },   // Target Field

    // AL West
    HOU: { runs: 1.02, hr: 1.06, hits: 1.00 },   // Minute Maid — Crawford Boxes
    LAA: { runs: 0.98, hr: 0.97, hits: 0.98 },   // Angel Stadium
    OAK: { runs: 0.92, hr: 0.85, hits: 0.95 },   // Coliseum — huge foul territory
    ATH: { runs: 0.92, hr: 0.85, hits: 0.95 },   // alias for OAK (Athletics 2025 abbr)
    SEA: { runs: 0.94, hr: 0.92, hits: 0.96 },   // T-Mobile Park — marine air suppresses HR
    TEX: { runs: 1.02, hr: 1.05, hits: 1.01 },   // Globe Life Field

    // NL East
    ATL: { runs: 1.02, hr: 1.06, hits: 1.00 },   // Truist Park
    MIA: { runs: 0.92, hr: 0.88, hits: 0.96 },   // loanDepot park
    NYM: { runs: 0.97, hr: 0.95, hits: 0.97 },   // Citi Field
    PHI: { runs: 1.04, hr: 1.13, hits: 1.01 },   // Citizens Bank Park — HR-friendly
    WSH: { runs: 1.01, hr: 1.04, hits: 1.00 },   // Nationals Park

    // NL Central
    CHC: { runs: 1.02, hr: 1.04, hits: 1.01 },   // Wrigley Field — wind-dependent
    CIN: { runs: 1.06, hr: 1.18, hits: 1.02 },   // Great American — bandbox
    MIL: { runs: 1.02, hr: 1.07, hits: 1.00 },   // American Family Field
    PIT: { runs: 0.96, hr: 0.91, hits: 0.98 },   // PNC Park — deep alleys
    STL: { runs: 0.99, hr: 0.96, hits: 0.99 },   // Busch Stadium

    // NL West
    ARI: { runs: 1.04, hr: 1.07, hits: 1.01 },   // Chase Field
    COL: { runs: 1.18, hr: 1.28, hits: 1.06 },   // Coors Field — elevation
    LAD: { runs: 1.00, hr: 1.03, hits: 0.99 },   // Dodger Stadium
    SD:  { runs: 0.95, hr: 0.92, hits: 0.97 },   // Petco Park — pitcher-friendly
    SF:  { runs: 0.92, hr: 0.84, hits: 0.96 },   // Oracle Park — marine air, deep right
};

const NEUTRAL = { runs: 1.00, hr: 1.00, hits: 1.00 };

export function parkFactor(teamAbbr) {
    if (!teamAbbr) return NEUTRAL;
    const key = String(teamAbbr).toUpperCase();
    return PARK_FACTORS[key] || NEUTRAL;
}
