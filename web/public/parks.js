// MLB ballpark geometry — fieldInfo dimensions for every active home park.
//
// Source: statsapi.mlb.com /api/v1/venues/{id}?hydrate=fieldInfo,location.
// Numbers are feet from home plate along the noted direction. `null` means
// MLB doesn't publish a value for that point (parks that don't have a
// distinct "left" or "right" power-alley posting — most don't).
//
// Angle convention used by drawParkOutfield():
//   LL = -45°    (left-field foul line)
//   L  = -33.75° (between LL and LC)
//   LC = -22.5°
//   C  =   0°    (straight CF)
//   RC = +22.5°
//   R  = +33.75°
//   RL = +45°
//
// The renderer plots each posted distance at its angle and connects them
// into the actual outfield silhouette. Parks with the deepest CF (Coors,
// Fenway, Comerica) push the wall back; parks with short porches (Yankee
// RF, Fenway RF) pull it in.
//
// Also embedded: park orientation (azimuth, compass degrees from N that
// CF axis points), elevation (Coors's altitude flag), roof type, turf.
//
// Loaded as a plain script (not a module) — attaches to `window.MLB_PARKS`
// + helpers so the non-module app.js can read it after this loads.

(function (root) {
"use strict";

const MLB_PARKS = {
    1:    { name: "Angel Stadium",              tri: "LAA", LL: 330, L: 347,  LC: 389, C: 396, RC: 365, R: 348,  RL: 330, roof: "Open",        turf: "Grass",           azimuth: 43.6,  elev: 151  },
    2:    { name: "Camden Yards",               tri: "BAL", LL: 333, L: 363,  LC: 376, C: 410, RC: 373, R: null, RL: 318, roof: "Open",        turf: "Grass",           azimuth: 31.0,  elev: 33   },
    3:    { name: "Fenway Park",                tri: "BOS", LL: 310, L: 379,  LC: 390, C: 420, RC: 380, R: null, RL: 302, roof: "Open",        turf: "Grass",           azimuth: 45.0,  elev: 21,   landmark: "monster" },
    4:    { name: "Rate Field",                 tri: "CWS", LL: 330, L: null, LC: 377, C: 400, RC: 372, R: null, RL: 335, roof: "Open",        turf: "Grass",           azimuth: 127.0, elev: 595  },
    5:    { name: "Progressive Field",          tri: "CLE", LL: 325, L: 370,  LC: 410, C: 405, RC: 375, R: null, RL: 325, roof: "Open",        turf: "Grass",           azimuth: 0.0,   elev: 653  },
    7:    { name: "Kauffman Stadium",           tri: "KC",  LL: 347, L: 364,  LC: 379, C: 410, RC: 379, R: 364,  RL: 344, roof: "Open",        turf: "Grass",           azimuth: 46.0,  elev: 856  },
    12:   { name: "Tropicana Field",            tri: "TB",  LL: 315, L: 370,  LC: 410, C: 404, RC: 404, R: 370,  RL: 322, roof: "Dome",        turf: "Artificial Turf", azimuth: 359.0, elev: 15   },
    14:   { name: "Rogers Centre",              tri: "TOR", LL: 328, L: null, LC: 375, C: 404, RC: 375, R: null, RL: 328, roof: "Retractable", turf: "Artificial Turf", azimuth: 345.0, elev: 270  },
    15:   { name: "Chase Field",                tri: "AZ",  LL: 328, L: 376,  LC: 412, C: 407, RC: 414, R: 376,  RL: 335, roof: "Retractable", turf: "Artificial Turf", azimuth: 0.0,   elev: 1086 },
    17:   { name: "Wrigley Field",              tri: "CHC", LL: 355, L: null, LC: 368, C: 400, RC: 368, R: null, RL: 353, roof: "Open",        turf: "Grass",           azimuth: 37.0,  elev: 595, landmark: "ivy" },
    19:   { name: "Coors Field",                tri: "COL", LL: 347, L: 390,  LC: 420, C: 415, RC: 424, R: 375,  RL: 350, roof: "Open",        turf: "Grass",           azimuth: 4.0,   elev: 5190, landmark: "mile_high" },
    22:   { name: "Dodger Stadium",             tri: "LAD", LL: 330, L: null, LC: 385, C: 395, RC: 385, R: null, RL: 330, roof: "Open",        turf: "Grass",           azimuth: 26.0,  elev: 515  },
    31:   { name: "PNC Park",                   tri: "PIT", LL: 325, L: 389,  LC: 410, C: 399, RC: 375, R: null, RL: 320, roof: "Open",        turf: "Grass",           azimuth: 116.0, elev: 780  },
    32:   { name: "American Family Field",      tri: "MIL", LL: 344, L: null, LC: 371, C: 400, RC: 374, R: null, RL: 345, roof: "Retractable", turf: "Grass",           azimuth: 129.0, elev: 597  },
    680:  { name: "T-Mobile Park",              tri: "SEA", LL: 331, L: null, LC: 390, C: 405, RC: 387, R: null, RL: 327, roof: "Retractable", turf: "Grass",           azimuth: 49.0,  elev: 10   },
    2392: { name: "Daikin Park",                tri: "HOU", LL: 315, L: null, LC: 362, C: 409, RC: 373, R: null, RL: 326, roof: "Retractable", turf: "Grass",           azimuth: 343.0, elev: 45   },
    2394: { name: "Comerica Park",              tri: "DET", LL: 345, L: null, LC: 370, C: 420, RC: 365, R: null, RL: 330, roof: "Open",        turf: "Grass",           azimuth: 150.0, elev: 600  },
    2395: { name: "Oracle Park",                tri: "SF",  LL: 339, L: null, LC: 399, C: 391, RC: 415, R: null, RL: 309, roof: "Open",        turf: "Grass",           azimuth: 85.0,  elev: 0,   landmark: "cove" },
    2529: { name: "Sutter Health Park",         tri: "ATH", LL: 330, L: null, LC: 380, C: 403, RC: 380, R: null, RL: 325, roof: "Open",        turf: "Grass",           azimuth: 46.0,  elev: 24   },
    2602: { name: "Great American Ball Park",   tri: "CIN", LL: 328, L: null, LC: 379, C: 404, RC: 370, R: null, RL: 325, roof: "Open",        turf: "Grass",           azimuth: 122.0, elev: 535  },
    2680: { name: "Petco Park",                 tri: "SD",  LL: 336, L: null, LC: 386, C: 396, RC: 391, R: null, RL: 322, roof: "Open",        turf: "Grass",           azimuth: 0.0,   elev: 23   },
    2681: { name: "Citizens Bank Park",         tri: "PHI", LL: 329, L: 369,  LC: 381, C: 401, RC: 398, R: 369,  RL: 330, roof: "Open",        turf: "Grass",           azimuth: 9.0,   elev: 20   },
    2889: { name: "Busch Stadium",              tri: "STL", LL: 336, L: null, LC: 375, C: 400, RC: 375, R: null, RL: 335, roof: "Open",        turf: "Grass",           azimuth: 62.0,  elev: 460  },
    3289: { name: "Citi Field",                 tri: "NYM", LL: 335, L: 358,  LC: 370, C: 408, RC: 380, R: 370,  RL: 330, roof: "Open",        turf: "Grass",           azimuth: 13.0,  elev: 10   },
    3309: { name: "Nationals Park",             tri: "WSH", LL: 336, L: null, LC: 377, C: 402, RC: 370, R: null, RL: 335, roof: "Open",        turf: "Grass",           azimuth: 28.0,  elev: 35   },
    3312: { name: "Target Field",               tri: "MIN", LL: 339, L: null, LC: 377, C: 404, RC: 367, R: null, RL: 328, roof: "Open",        turf: "Grass",           azimuth: 129.0, elev: 828  },
    3313: { name: "Yankee Stadium",             tri: "NYY", LL: 318, L: null, LC: 399, C: 408, RC: 385, R: null, RL: 314, roof: "Open",        turf: "Grass",           azimuth: 75.0,  elev: 55,   landmark: "short_porch" },
    4169: { name: "loanDepot park",             tri: "MIA", LL: 344, L: null, LC: 386, C: 407, RC: 392, R: null, RL: 335, roof: "Retractable", turf: "Artificial Turf", azimuth: 128.0, elev: 10   },
    4705: { name: "Truist Park",                tri: "ATL", LL: 335, L: 375,  LC: 385, C: 400, RC: 375, R: null, RL: 325, roof: "Open",        turf: "Grass",           azimuth: 145.0, elev: 1001 },
    5325: { name: "Globe Life Field",           tri: "TEX", LL: 329, L: null, LC: 372, C: 407, RC: 374, R: null, RL: 326, roof: "Retractable", turf: "Artificial Turf", azimuth: 30.0,  elev: 545  },
};

// Park name → id, used when the API returns only the venue name string
// (older endpoints, fallback path). All 30 active MLB home parks plus
// a few common aliases.
const PARK_NAME_TO_ID = {
    "Angel Stadium":                 1,
    "Camden Yards":                  2,
    "Oriole Park at Camden Yards":   2,
    "Fenway Park":                   3,
    "Rate Field":                    4,
    "Guaranteed Rate Field":         4,
    "Progressive Field":             5,
    "Kauffman Stadium":              7,
    "Tropicana Field":               12,
    "Rogers Centre":                 14,
    "Chase Field":                   15,
    "Wrigley Field":                 17,
    "Coors Field":                   19,
    "Dodger Stadium":                22,
    "UNIQLO Field at Dodger Stadium": 22,
    "PNC Park":                      31,
    "American Family Field":         32,
    "T-Mobile Park":                 680,
    "Daikin Park":                   2392,
    "Minute Maid Park":              2392,
    "Comerica Park":                 2394,
    "Oracle Park":                   2395,
    "Sutter Health Park":            2529,
    "Great American Ball Park":      2602,
    "Petco Park":                    2680,
    "Citizens Bank Park":            2681,
    "Busch Stadium":                 2889,
    "Citi Field":                    3289,
    "Nationals Park":                3309,
    "Target Field":                  3312,
    "Yankee Stadium":                3313,
    "loanDepot park":                4169,
    "LoanDepot park":                4169,
    "Truist Park":                   4705,
    "Globe Life Field":              5325,
};

// ── Geometry: distance + angle → SVG (x, y) ──────────────────────
//
// Angles relative to the CF axis (degrees, left negative). The field
// SVG places home plate at (HOME_X, HOME_Y) with CF straight up.
//
// Scale: 1 foot ≈ 1 SVG unit. Coors's 424 ft RC at angle +22.5° lands
// at (250 + 162, 460 - 392) = (412, 68) — well inside the 500×500
// viewBox. Most parks's deepest gaps are 390-415 ft, well-fitting.

const HOME_X = 250;
const HOME_Y = 460;
const ANGLE_OF = {
    LL: -45.0,
    L:  -33.75,
    LC: -22.5,
    C:    0.0,
    RC:  22.5,
    R:   33.75,
    RL:  45.0,
};
const POINT_ORDER = ["LL", "L", "LC", "C", "RC", "R", "RL"];

function dirToXY(distFt, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    const x = HOME_X + distFt * Math.sin(rad);
    const y = HOME_Y - distFt * Math.cos(rad);
    return { x, y };
}

// Build the array of {x, y, key, d} points around the outfield wall for a
// park. Skips null reference points; the renderer interpolates through
// what remains.
function parkWallPoints(park) {
    if (!park) return null;
    const pts = [];
    for (const key of POINT_ORDER) {
        const d = park[key];
        if (d == null) continue;
        pts.push({ key, d, ...dirToXY(d, ANGLE_OF[key]) });
    }
    return pts.length >= 3 ? pts : null;
}

// SVG path string for the outfield wall as a smoothed curve through the
// posted reference points. Catmull-Rom converted to cubic Bézier — the
// path stays accurate at each posted-distance point but flows smoothly
// between them so the wall doesn't look like a polygon.
//
// `closeAtHome` true ⇒ path ends back at home plate (for grass fill);
// false ⇒ path is the wall stroke only (foul pole to foul pole).
function parkWallPath(park, opts) {
    opts = opts || {};
    const closeAtHome = !!opts.closeAtHome;
    const pts = parkWallPoints(park);
    if (!pts) return null;

    const ext = [pts[0]].concat(pts).concat([pts[pts.length - 1]]);
    const parts = [`M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = ext[i];
        const p1 = ext[i + 1];
        const p2 = ext[i + 2];
        const p3 = ext[i + 3];
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        parts.push(
            `C ${c1x.toFixed(1)},${c1y.toFixed(1)} `
          + `${c2x.toFixed(1)},${c2y.toFixed(1)} `
          + `${p2.x.toFixed(1)},${p2.y.toFixed(1)}`,
        );
    }
    if (closeAtHome) {
        parts.push(`L ${HOME_X},${HOME_Y} Z`);
    }
    return parts.join(" ");
}

// Same Catmull-Rom path but inset toward the infield by `insetFt` feet —
// used to draw the warning track (the dirt ring inside the wall).
function parkWarningTrackPath(park, insetFt) {
    if (!park) return null;
    const inset = insetFt || 12;
    const pts = [];
    for (const key of POINT_ORDER) {
        const d = park[key];
        if (d == null) continue;
        pts.push({ key, ...dirToXY(d - inset, ANGLE_OF[key]) });
    }
    if (pts.length < 3) return null;
    const ext = [pts[0]].concat(pts).concat([pts[pts.length - 1]]);
    const parts = [`M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = ext[i], p1 = ext[i + 1], p2 = ext[i + 2], p3 = ext[i + 3];
        parts.push(
            `C ${(p1.x + (p2.x - p0.x) / 6).toFixed(1)},${(p1.y + (p2.y - p0.y) / 6).toFixed(1)} `
          + `${(p2.x - (p3.x - p1.x) / 6).toFixed(1)},${(p2.y - (p3.y - p1.y) / 6).toFixed(1)} `
          + `${p2.x.toFixed(1)},${p2.y.toFixed(1)}`,
        );
    }
    return parts.join(" ");
}

// Foul pole positions for a park (LL/RL distances along the foul lines).
function parkFoulPoles(park) {
    if (!park) return null;
    return {
        left:  dirToXY(park.LL, ANGLE_OF.LL),
        right: dirToXY(park.RL, ANGLE_OF.RL),
    };
}

// Resolve a park by venue id (preferred) or by venue name (fallback for
// game payloads that haven't been backfilled with venue_id yet).
function resolvePark(g) {
    if (!g) return null;
    if (g.venue_id != null && MLB_PARKS[g.venue_id]) return MLB_PARKS[g.venue_id];
    if (g.venue && PARK_NAME_TO_ID[g.venue]) return MLB_PARKS[PARK_NAME_TO_ID[g.venue]];
    return null;
}

// Human-readable "open / dome / retractable + turf + elev" caption used
// as a flavor chip near the field. Only emits an elevation chip if the
// park is >= 1500 ft (Coors, Chase, Truist, Daikin Spring Training).
function parkFlavorChips(park) {
    if (!park) return [];
    const chips = [];
    if (park.roof === "Dome")             chips.push({ kind: "dome",        text: "Domed" });
    else if (park.roof === "Retractable") chips.push({ kind: "retractable", text: "Retractable Roof" });
    if (park.turf === "Artificial Turf")  chips.push({ kind: "turf",        text: "Turf" });
    if (park.elev >= 1500)                chips.push({ kind: "elev",        text: `${park.elev.toLocaleString()} ft` });
    if (park.landmark === "monster")      chips.push({ kind: "landmark",    text: "Green Monster" });
    if (park.landmark === "ivy")          chips.push({ kind: "landmark",    text: "Ivy Walls" });
    if (park.landmark === "short_porch")  chips.push({ kind: "landmark",    text: "Short Porch" });
    if (park.landmark === "cove")         chips.push({ kind: "landmark",    text: "McCovey Cove" });
    if (park.landmark === "mile_high")    chips.push({ kind: "landmark",    text: "Mile-High" });
    return chips;
}

root.MLB_PARKS         = MLB_PARKS;
root.PARK_NAME_TO_ID   = PARK_NAME_TO_ID;
root.resolvePark       = resolvePark;
root.parkWallPath      = parkWallPath;
root.parkWarningTrackPath = parkWarningTrackPath;
root.parkFoulPoles     = parkFoulPoles;
root.parkFlavorChips   = parkFlavorChips;

})(typeof window !== "undefined" ? window : globalThis);
