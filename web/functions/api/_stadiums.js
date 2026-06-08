// Stadium coordinates + roof type for all 30 MLB venues. Used by the
// weather endpoint to look up the right forecast point and to
// short-circuit retractable / fixed-roof games where outside weather
// doesn't matter.
//
// Keyed by the team's standard tricode (matches teams.home.abbr
// served from /api/game/{id}). For relocations / rebrands (Athletics
// 2025 Sacramento etc.), keep both keys aliased to the same row so
// the lookup never fails on the abbr-of-the-moment.

export const STADIUMS = {
    // AL East
    BAL: { name: "Camden Yards",    lat: 39.2839, lng: -76.6217, roof: "open" },
    BOS: { name: "Fenway Park",     lat: 42.3467, lng: -71.0972, roof: "open" },
    NYY: { name: "Yankee Stadium",  lat: 40.8296, lng: -73.9262, roof: "open" },
    TB:  { name: "Tropicana Field", lat: 27.7682, lng: -82.6534, roof: "dome" },
    TOR: { name: "Rogers Centre",   lat: 43.6414, lng: -79.3894, roof: "retractable" },

    // AL Central
    CHW: { name: "Guaranteed Rate Field", lat: 41.8299, lng: -87.6338, roof: "open" },
    CLE: { name: "Progressive Field",     lat: 41.4962, lng: -81.6852, roof: "open" },
    DET: { name: "Comerica Park",         lat: 42.3390, lng: -83.0485, roof: "open" },
    KC:  { name: "Kauffman Stadium",      lat: 39.0517, lng: -94.4803, roof: "open" },
    MIN: { name: "Target Field",          lat: 44.9817, lng: -93.2776, roof: "open" },

    // AL West
    HOU: { name: "Minute Maid Park", lat: 29.7572, lng: -95.3556, roof: "retractable" },
    LAA: { name: "Angel Stadium",    lat: 33.8003, lng: -117.8827, roof: "open" },
    OAK: { name: "Sutter Health Park", lat: 38.5803, lng: -121.5114, roof: "open" },
    ATH: { name: "Sutter Health Park", lat: 38.5803, lng: -121.5114, roof: "open" },
    SEA: { name: "T-Mobile Park",    lat: 47.5914, lng: -122.3325, roof: "retractable" },
    TEX: { name: "Globe Life Field", lat: 32.7473, lng: -97.0817, roof: "retractable" },

    // NL East
    ATL: { name: "Truist Park",     lat: 33.8908, lng: -84.4678, roof: "open" },
    MIA: { name: "loanDepot park",  lat: 25.7781, lng: -80.2197, roof: "retractable" },
    NYM: { name: "Citi Field",      lat: 40.7571, lng: -73.8458, roof: "open" },
    PHI: { name: "Citizens Bank Park", lat: 39.9061, lng: -75.1665, roof: "open" },
    WSH: { name: "Nationals Park",  lat: 38.8730, lng: -77.0074, roof: "open" },

    // NL Central
    CHC: { name: "Wrigley Field",   lat: 41.9484, lng: -87.6553, roof: "open" },
    CIN: { name: "Great American Ball Park", lat: 39.0975, lng: -84.5072, roof: "open" },
    MIL: { name: "American Family Field", lat: 43.0280, lng: -87.9712, roof: "retractable" },
    PIT: { name: "PNC Park",        lat: 40.4469, lng: -80.0058, roof: "open" },
    STL: { name: "Busch Stadium",   lat: 38.6226, lng: -90.1928, roof: "open" },

    // NL West
    ARI: { name: "Chase Field",     lat: 33.4453, lng: -112.0667, roof: "retractable" },
    COL: { name: "Coors Field",     lat: 39.7559, lng: -104.9942, roof: "open" },
    LAD: { name: "Dodger Stadium",  lat: 34.0739, lng: -118.2400, roof: "open" },
    SD:  { name: "Petco Park",      lat: 32.7073, lng: -117.1566, roof: "open" },
    SF:  { name: "Oracle Park",     lat: 37.7786, lng: -122.3893, roof: "open" },
};

export function stadiumFor(teamAbbr) {
    if (!teamAbbr) return null;
    return STADIUMS[String(teamAbbr).toUpperCase()] || null;
}
