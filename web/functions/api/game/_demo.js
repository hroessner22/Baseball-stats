// Synthetic high-leverage scenario for testing live-only UI without
// waiting for a real game. Reachable at #game/demo. Every game-scoped
// endpoint (/api/game/{id}, .../plays, .../we-trace, .../we-projected,
// .../recap) checks the id and returns demo shapes when it's "demo".
//
// The scenario: bottom 9th, 1 out, bases loaded, NYY (home) trailing
// LAD 4-3. Aaron Judge at the plate vs Clayton Kershaw. This is a
// canonical walk-off-or-bust state — high leverage, dramatic WE
// swings between possible outcomes, and both players are in our
// 2020-2024 Chadwick map so the matchup engine has real data.

export const DEMO_GAME_PK = "demo";

export const DEMO_GAME = {
    game_pk: DEMO_GAME_PK,
    status: "Live",
    detail: "Bottom 9th",
    teams: {
        away: { id: 119, name: "Dodgers", abbr: "LAD" },
        home: { id: 147, name: "Yankees", abbr: "NYY" },
    },
    score:    { away: 4, home: 3 },
    inning:   9,
    half:     "bottom",
    outs:     1,
    balls:    1,
    strikes:  1,
    runners: {
        first:  "Anthony Volpe",
        second: "Juan Soto",
        third:  "Jasson Domínguez",
    },
    batter: {
        id:    592450,   // Aaron Judge
        name:  "Aaron Judge",
        bats:  "R",
    },
    pitcher: {
        id:    477132,   // Clayton Kershaw
        name:  "Clayton Kershaw",
        throws: "L",
    },
    win_expectancy: null, // filled in by the endpoint via the v2 table
    venue:      "Yankee Stadium (demo)",
    start_time: null,
};

// Synthetic play log used by the plays + we-trace endpoints. Light on
// volume but representative — enough plays to draw a real-looking WE
// curve and populate the Gamecast.
export const DEMO_PLAYS = [
    // Top 1st through middle innings, normal-looking events
    { pi:  0, inning: 1, half: "top",    away: 0, home: 0, batter: "Mookie Betts",      pitcher: "Carlos Rodón",  outcome: "OUT", event: "Groundout",  description: "Mookie Betts grounds out, shortstop Anthony Volpe to first baseman Anthony Rizzo.", pitches: [{number:1,type:"Sinker",type_code:"SI",velo:94.3,result:"Called Strike",result_code:"C",count_after:{balls:0,strikes:1}}, {number:2,type:"Slider",type_code:"SL",velo:86.1,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:1}}] },
    { pi:  1, inning: 1, half: "top",    away: 1, home: 0, batter: "Shohei Ohtani",     pitcher: "Carlos Rodón",  outcome: "HR",  event: "Home Run",   description: "Shohei Ohtani homers (15) on a line drive to right field.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:96.4,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Four-Seam",type_code:"FF",velo:97.1,result:"In play, run(s)",result_code:"X",count_after:{balls:1,strikes:0}}] },
    { pi:  2, inning: 1, half: "top",    away: 1, home: 0, batter: "Freddie Freeman",   pitcher: "Carlos Rodón",  outcome: "K",   event: "Strikeout",  description: "Freddie Freeman strikes out swinging.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:85.8,result:"Foul",result_code:"F",count_after:{balls:0,strikes:1}}, {number:2,type:"Four-Seam",type_code:"FF",velo:96.7,result:"Swinging Strike",result_code:"S",count_after:{balls:0,strikes:2}}, {number:3,type:"Slider",type_code:"SL",velo:85.2,result:"Swinging Strike",result_code:"S",count_after:{balls:0,strikes:3}}] },
    { pi:  3, inning: 1, half: "top",    away: 1, home: 0, batter: "Will Smith",        pitcher: "Carlos Rodón",  outcome: "OUT", event: "Flyout",     description: "Will Smith flies out to center fielder Aaron Judge.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:96.0,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    { pi:  4, inning: 1, half: "bottom", away: 1, home: 0, batter: "Anthony Volpe",     pitcher: "Clayton Kershaw", outcome: "OUT", event: "Flyout",     description: "Anthony Volpe flies out to left fielder Teoscar Hernández.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:85.5,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    { pi:  5, inning: 1, half: "bottom", away: 1, home: 0, batter: "Aaron Judge",       pitcher: "Clayton Kershaw", outcome: "BB",  event: "Walk",       description: "Aaron Judge walks.", pitches: [{number:1,type:"Curveball",type_code:"CU",velo:74.2,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Four-Seam",type_code:"FF",velo:91.3,result:"Ball",result_code:"B",count_after:{balls:2,strikes:0}}, {number:3,type:"Slider",type_code:"SL",velo:84.8,result:"Foul",result_code:"F",count_after:{balls:2,strikes:1}}, {number:4,type:"Four-Seam",type_code:"FF",velo:91.8,result:"Ball",result_code:"B",count_after:{balls:3,strikes:1}}, {number:5,type:"Curveball",type_code:"CU",velo:73.9,result:"Ball",result_code:"B",count_after:{balls:4,strikes:1}}] },
    { pi:  6, inning: 1, half: "bottom", away: 1, home: 0, batter: "Juan Soto",         pitcher: "Clayton Kershaw", outcome: "OUT", event: "Lineout",    description: "Juan Soto lines out to right fielder Mookie Betts.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:85.0,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    { pi:  7, inning: 1, half: "bottom", away: 1, home: 0, batter: "Giancarlo Stanton", pitcher: "Clayton Kershaw", outcome: "K",   event: "Strikeout",  description: "Giancarlo Stanton called out on strikes.", pitches: [{number:1,type:"Curveball",type_code:"CU",velo:74.5,result:"Called Strike",result_code:"C",count_after:{balls:0,strikes:1}}, {number:2,type:"Slider",type_code:"SL",velo:85.3,result:"Foul",result_code:"F",count_after:{balls:0,strikes:2}}, {number:3,type:"Slider",type_code:"SL",velo:85.0,result:"Called Strike",result_code:"C",count_after:{balls:0,strikes:3}}] },
    // 3rd inning — NYY ties it
    { pi:  8, inning: 3, half: "bottom", away: 1, home: 1, batter: "Jasson Domínguez",  pitcher: "Clayton Kershaw", outcome: "HR",  event: "Home Run",   description: "Jasson Domínguez homers (8) on a fly ball to right-center.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:92.1,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Slider",type_code:"SL",velo:85.7,result:"In play, run(s)",result_code:"X",count_after:{balls:1,strikes:0}}] },
    // 5th — LAD scratches one
    { pi:  9, inning: 5, half: "top",    away: 2, home: 1, batter: "Teoscar Hernández", pitcher: "Carlos Rodón",  outcome: "1B",  event: "Single",     description: "Teoscar Hernández singles on a line drive to left field. Mookie Betts scores.", pitches: [{number:1,type:"Sinker",type_code:"SI",velo:93.8,result:"In play, run(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    // 6th — NYY ties again
    { pi: 10, inning: 6, half: "bottom", away: 2, home: 2, batter: "Aaron Judge",       pitcher: "Brent Honeywell", outcome: "HR",  event: "Home Run",   description: "Aaron Judge homers (32) on a fly ball to left-center field.", pitches: [{number:1,type:"Splitter",type_code:"FS",velo:87.2,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Four-Seam",type_code:"FF",velo:94.6,result:"In play, run(s)",result_code:"X",count_after:{balls:1,strikes:0}}] },
    // 8th — LAD goes up by 2
    { pi: 11, inning: 8, half: "top",    away: 4, home: 2, batter: "Will Smith",        pitcher: "Luke Weaver",   outcome: "2B",  event: "Double",     description: "Will Smith doubles (12) on a line drive to right field. Shohei Ohtani scores. Freddie Freeman scores.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:95.4,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Changeup",type_code:"CH",velo:84.9,result:"In play, run(s)",result_code:"X",count_after:{balls:1,strikes:0}}] },
    // 8th bottom — NYY scratches one back
    { pi: 12, inning: 8, half: "bottom", away: 4, home: 3, batter: "Anthony Rizzo",     pitcher: "Anthony Banda", outcome: "1B",  event: "Single",     description: "Anthony Rizzo singles on a ground ball to right field. Anthony Volpe scores.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:84.1,result:"In play, run(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    // Top 9 — LAD goes down quick
    { pi: 13, inning: 9, half: "top",    away: 4, home: 3, batter: "Mookie Betts",      pitcher: "Clay Holmes",   outcome: "OUT", event: "Groundout",  description: "Mookie Betts grounds out, second baseman Gleyber Torres to first baseman Anthony Rizzo.", pitches: [{number:1,type:"Sinker",type_code:"SI",velo:96.2,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    { pi: 14, inning: 9, half: "top",    away: 4, home: 3, batter: "Shohei Ohtani",     pitcher: "Clay Holmes",   outcome: "K",   event: "Strikeout",  description: "Shohei Ohtani strikes out swinging.", pitches: [{number:1,type:"Sinker",type_code:"SI",velo:96.0,result:"Foul",result_code:"F",count_after:{balls:0,strikes:1}}, {number:2,type:"Slider",type_code:"SL",velo:87.4,result:"Swinging Strike",result_code:"S",count_after:{balls:0,strikes:2}}, {number:3,type:"Sinker",type_code:"SI",velo:96.3,result:"Swinging Strike",result_code:"S",count_after:{balls:0,strikes:3}}] },
    { pi: 15, inning: 9, half: "top",    away: 4, home: 3, batter: "Freddie Freeman",   pitcher: "Clay Holmes",   outcome: "OUT", event: "Flyout",     description: "Freddie Freeman flies out to center fielder Aaron Judge.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:87.6,result:"In play, out(s)",result_code:"X",count_after:{balls:0,strikes:0}}] },
    // Bottom 9 — Volpe walks, Soto doubles, Domínguez HBP → bases loaded for Judge vs Kershaw (who came in for this AB)
    { pi: 16, inning: 9, half: "bottom", away: 4, home: 3, batter: "Anthony Volpe",     pitcher: "Evan Phillips",  outcome: "BB",  event: "Walk",       description: "Anthony Volpe walks.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:96.7,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Slider",type_code:"SL",velo:87.1,result:"Ball",result_code:"B",count_after:{balls:2,strikes:0}}, {number:3,type:"Four-Seam",type_code:"FF",velo:96.5,result:"Foul",result_code:"F",count_after:{balls:2,strikes:1}}, {number:4,type:"Slider",type_code:"SL",velo:87.0,result:"Ball",result_code:"B",count_after:{balls:3,strikes:1}}, {number:5,type:"Four-Seam",type_code:"FF",velo:96.8,result:"Ball",result_code:"B",count_after:{balls:4,strikes:1}}] },
    { pi: 17, inning: 9, half: "bottom", away: 4, home: 3, batter: "Juan Soto",         pitcher: "Evan Phillips",  outcome: "2B",  event: "Double",     description: "Juan Soto doubles (24) on a line drive to right field. Anthony Volpe to third.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:97.1,result:"In play, no out",result_code:"X",count_after:{balls:0,strikes:0}}] },
    { pi: 18, inning: 9, half: "bottom", away: 4, home: 3, batter: "Jasson Domínguez",  pitcher: "Evan Phillips",  outcome: "HBP", event: "Hit By Pitch", description: "Jasson Domínguez hit by pitch.", pitches: [{number:1,type:"Slider",type_code:"SL",velo:87.5,result:"Hit By Pitch",result_code:"H",count_after:{balls:1,strikes:0}}] },
    // 1 out — Stanton flies to right, runners hold
    { pi: 19, inning: 9, half: "bottom", away: 4, home: 3, batter: "Giancarlo Stanton", pitcher: "Clayton Kershaw", outcome: "OUT", event: "Flyout",     description: "Giancarlo Stanton flies out to right fielder Teoscar Hernández. Runners hold.", pitches: [{number:1,type:"Four-Seam",type_code:"FF",velo:91.7,result:"Ball",result_code:"B",count_after:{balls:1,strikes:0}}, {number:2,type:"Curveball",type_code:"CU",velo:74.3,result:"In play, out(s)",result_code:"X",count_after:{balls:1,strikes:0}}] },
    // Now Judge at the plate vs Kershaw, bases loaded 1 out. THIS is the in-progress PA — NOT included in plays (we never include the current PA).
];

// Trace data — one point per completed half-inning + the pre-game
// point. Lookup happens in the consumer; here we just expose the
// state at each half-end so the trace endpoint computes WE from it.
export const DEMO_TRACE_RAW = [
    { inning: 1, half: "top",    away: 1, home: 0, event: "Home Run",   description: "Shohei Ohtani homers (15)." },
    { inning: 1, half: "bottom", away: 1, home: 0, event: "Strikeout",  description: "Giancarlo Stanton called out on strikes." },
    { inning: 2, half: "top",    away: 1, home: 0, event: "Groundout",  description: "Side retired, top 2nd." },
    { inning: 2, half: "bottom", away: 1, home: 0, event: "Strikeout",  description: "Side retired, bottom 2nd." },
    { inning: 3, half: "top",    away: 1, home: 0, event: "Flyout",     description: "Side retired, top 3rd." },
    { inning: 3, half: "bottom", away: 1, home: 1, event: "Home Run",   description: "Jasson Domínguez homers — game tied 1-1." },
    { inning: 4, half: "top",    away: 1, home: 1, event: "Groundout",  description: "Side retired, top 4th." },
    { inning: 4, half: "bottom", away: 1, home: 1, event: "Flyout",     description: "Side retired, bottom 4th." },
    { inning: 5, half: "top",    away: 2, home: 1, event: "Single",     description: "Teoscar Hernández singles, Betts scores — LAD 2-1." },
    { inning: 5, half: "bottom", away: 2, home: 1, event: "Groundout",  description: "Side retired, bottom 5th." },
    { inning: 6, half: "top",    away: 2, home: 1, event: "Flyout",     description: "Side retired, top 6th." },
    { inning: 6, half: "bottom", away: 2, home: 2, event: "Home Run",   description: "Aaron Judge homers — game tied 2-2." },
    { inning: 7, half: "top",    away: 2, home: 2, event: "Strikeout",  description: "Side retired, top 7th." },
    { inning: 7, half: "bottom", away: 2, home: 2, event: "Lineout",    description: "Side retired, bottom 7th." },
    { inning: 8, half: "top",    away: 4, home: 2, event: "Double",     description: "Will Smith doubles, Ohtani + Freeman score — LAD 4-2." },
    { inning: 8, half: "bottom", away: 4, home: 3, event: "Single",     description: "Anthony Rizzo singles, Volpe scores — LAD 4-3." },
    { inning: 9, half: "top",    away: 4, home: 3, event: "Flyout",     description: "Side retired, top 9th." },
    // bottom 9 in progress — no end-of-half point yet
];
