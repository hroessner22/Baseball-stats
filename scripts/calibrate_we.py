"""Recent-era calibration of a moneyline win-probability model.

Builds LEAK-FREE per-game features from:
  - MLB schedule API   -> outcomes + team runs scored/allowed to-date
  - daily_pa (Supabase, anon) -> each starter's run-value-allowed to-date

Fits a logistic regression (home win ~ offense/defense/starter differentials),
reports calibration (Brier, reliability) and the learned factor weights, and
sanity-checks against the over-extreme multiplicative model.

Run:  python scripts/calibrate_we.py
"""
from __future__ import annotations
import json, ssl, urllib.request, bisect
from collections import defaultdict
import certifi, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_predict

CTX = ssl.create_default_context(cafile=certifi.where())
SB_URL = "https://jnobopyhciheyheqxrmy.supabase.co"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6"
        "Impub2JvcHloY2loZXloZXF4cm15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1OTM3"
        "NjAsImV4cCI6MjA5NTE2OTc2MH0.qQ7J0YYOSyrtL09Qsx6G5X6NBmQFo_3i0shlUybSDDg")
LG_R = 4.5
# Linear weights (runs above average per event) for pitcher allowed-quality.
RV = {"BB":0.31,"HBP":0.33,"1B":0.45,"2B":0.76,"3B":1.04,"HR":1.40,
      "K":-0.27,"OUT":-0.27,"OTHER":0.0}

def jget(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent":"dc-cal/1.0"})
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=60))

# ---- 1. Outcomes + team run env from the MLB schedule -----------------------
def load_schedule(seasons):
    games = {}  # game_pk -> dict
    for yr in seasons:
        url = (f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R"
               f"&startDate={yr}-03-01&endDate={yr}-11-30")
        d = jget(url)
        for day in d.get("dates", []):
            for g in day.get("games", []):
                if g.get("status",{}).get("codedGameState") != "F":  # finished only
                    continue
                h, a = g["teams"]["home"], g["teams"]["away"]
                if "score" not in h or "score" not in a:
                    continue
                pk = g["gamePk"]
                games[pk] = {
                    "date": g["officialDate"], "home": h["team"]["id"],
                    "away": a["team"]["id"], "hs": h["score"], "as": a["score"],
                    "home_win": 1 if h["score"] > a["score"] else 0,
                }
    return games

# ---- 2. daily_pa pull (anon, paginated) -------------------------------------
def load_daily_pa():
    rows, off, PAGE = [], 0, 1000
    cols = "game_pk,game_date,inning,half,pa_index,pitcher_mlbam,outcome"
    while True:
        url = (f"{SB_URL}/rest/v1/daily_pa?select={cols}"
               f"&order=id.asc&limit={PAGE}&offset={off}")
        batch = jget(url, {"apikey":ANON,"Authorization":f"Bearer {ANON}"})
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        off += PAGE
    return rows

def half_top(h): return str(h or "").lower().startswith(("top","mid"))

def build(pa_rows):
    # starters: pitcher facing the first PA of each half in inning 1
    first = {}  # (game_pk, side) -> (pa_index, pitcher)
    pitcher_pa = defaultdict(list)  # pitcher -> [(date, rv, is_k)]
    for r in pa_rows:
        pid = r["pitcher_mlbam"]; date = r["game_date"]
        rv = RV.get(r["outcome"], 0.0); k = 1 if r["outcome"] == "K" else 0
        pitcher_pa[pid].append((date, rv, k))
        if r["inning"] == 1:
            side = "home" if half_top(r["half"]) else "away"  # top1 -> home pitches
            key = (r["game_pk"], side); pi = r["pa_index"]
            if key not in first or pi < first[key][0]:
                first[key] = (pi, pid)
    for pid in pitcher_pa:
        pitcher_pa[pid].sort()
    starters = {gp: {} for gp, _ in first}
    for (gp, side), (_, pid) in first.items():
        starters[gp][side] = pid
    return starters, pitcher_pa

LG_KRATE = 0.225  # league K/PA ~22.5%
def sp_quality_to_date(pitcher_pa, pid, date, prior_pa=80):
    """Leak-free (rv_allowed/PA, k_rate) before `date`, shrunk toward league."""
    arr = pitcher_pa.get(pid)
    if not arr: return 0.0, 0.0
    i = bisect.bisect_left(arr, (date, -9, -9))   # strictly before `date`
    if i == 0: return 0.0, 0.0
    srv = sum(rv for _, rv, _ in arr[:i]); sk = sum(k for _, _, k in arr[:i]); n = i
    rv = srv / (n + prior_pa)                            # toward 0 (league rv)
    kr = (sk + prior_pa*LG_KRATE) / (n + prior_pa) - LG_KRATE  # k-rate above league
    return rv, kr

def main():
    import os, pickle
    seasons = [2025, 2026]
    cache = "/tmp/dc_cal_cache.pkl"
    if os.path.exists(cache):
        with open(cache,"rb") as f: games, pa = pickle.load(f)
        print(f"loaded cache: {len(games)} games, {len(pa)} PA rows")
    else:
        print("loading schedule..."); games = load_schedule(seasons)
        print(f"  finished games: {len(games)}")
        print("loading daily_pa (paginated)..."); pa = load_daily_pa()
        print(f"  PA rows: {len(pa)}")
        with open(cache,"wb") as f: pickle.dump((games, pa), f)
    starters, pitcher_pa = build(pa)

    # team run env to-date (offense scored, defense allowed), chronological
    team_rs = defaultdict(list); team_ra = defaultdict(list)  # team -> [runs per game]
    def reg(vals, prior_g=8, lg=LG_R):
        if not vals: return lg
        return (sum(vals) + prior_g*lg) / (len(vals) + prior_g)
    def recent_diff(team, n=10):  # last-n (RS-RA) per game, 0 if no history
        rs, ra = team_rs[team][-n:], team_ra[team][-n:]
        return (sum(rs)-sum(ra))/len(rs) if rs else 0.0

    MIN_PRIOR = 20   # both teams need >=20 prior games (skip April noise)
    X, y, meta = [], [], []
    for pk, g in sorted(games.items(), key=lambda kv: kv[1]["date"]):
        h, a, date = g["home"], g["away"], g["date"]
        sp = starters.get(pk, {})
        h_sp, a_sp = sp.get("home"), sp.get("away")
        enough = len(team_rs[h]) >= MIN_PRIOR and len(team_rs[a]) >= MIN_PRIOR
        if enough:
            h_off, a_off = reg(team_rs[h]), reg(team_rs[a])
            h_def, a_def = reg(team_ra[h]), reg(team_ra[a])
            h_rv, h_k = sp_quality_to_date(pitcher_pa, h_sp, date) if h_sp else (0.0,0.0)
            a_rv, a_k = sp_quality_to_date(pitcher_pa, a_sp, date) if a_sp else (0.0,0.0)
            X.append([h_off - a_off, h_def - a_def, h_rv - a_rv, h_k - a_k,
                      recent_diff(h) - recent_diff(a)])
            y.append(g["home_win"]); meta.append(pk)
        # update to-date AFTER using features (leak-free)
        team_rs[h].append(g["hs"]); team_ra[h].append(g["as"])
        team_rs[a].append(g["as"]); team_ra[a].append(g["hs"])

    X = np.array(X); y = np.array(y)
    # standardize so the learned weights are directly comparable (which factor
    # matters most = the pattern), and L2 regularization is fair across features.
    pipe = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))
    pipe.fit(X, y)
    # out-of-sample probabilities (5-fold) so calibration/Brier aren't optimistic
    p = cross_val_predict(pipe, X, y, cv=5, method="predict_proba")[:,1]
    brier = np.mean((p - y)**2)
    base = np.full_like(p, y.mean())
    brier0 = np.mean((base - y)**2)
    lr = pipe.named_steps["logisticregression"]
    print(f"\n=== fit on {len(y)} games (5-fold out-of-sample) ===")
    print(f"home win rate: {y.mean():.4f}")
    print(f"intercept: {lr.intercept_[0]:+.4f}  (home-field)")
    names = ["off_diff(RS/g)","def_diff(RA/g)","starter_rv_diff","starter_K%_diff","recent10_diff"]
    print("  standardized weights (|larger| = more predictive):")
    for nm, c in zip(names, lr.coef_[0]):
        print(f"    {nm:22} = {c:+.4f}")
    print(f"\nBrier: {brier:.4f}   baseline(home-const): {brier0:.4f}   "
          f"improvement: {(brier0-brier)/brier0*100:.1f}%")
    # reliability curve
    print("\nreliability (pred bucket -> actual win rate, n):")
    for lo in [x/10 for x in range(0,10)]:
        m = (p>=lo)&(p<lo+0.1)
        if m.sum()>20:
            print(f"  {lo:.1f}-{lo+0.1:.1f}: pred {p[m].mean():.3f}  actual {y[m].mean():.3f}  (n={m.sum()})")
    print(f"\npredicted prob range: {p.min():.3f} .. {p.max():.3f}  "
          f"(market pregame lines ~0.25..0.75 — extremes should be rare)")

    # ---- PATTERN ANALYSIS: where is the model most reliable / discriminating?
    # The bettable insight: high model confidence only helps if the model is
    # actually right in that segment. Find segments where picking the model's
    # favorite wins at a high rate (clears the ~52.4% vig breakeven with room).
    Xa = np.array(X)
    pick_win = np.where(p >= 0.5, y, 1 - y)        # did the model's favorite win?
    conf = np.abs(p - 0.5)                          # margin of the pick
    def seg(name, mask):
        if mask.sum() < 40: return
        wr = pick_win[mask].mean()
        print(f"  {name:32} n={mask.sum():4d}  fav win% {wr:.3f}  "
              f"avg conf {conf[mask].mean():.3f}")
    print("\n=== PATTERN: model-favorite win-rate by segment (breakeven ~.524) ===")
    seg("ALL", np.ones(len(p), bool))
    for lo in [0.0,0.05,0.10,0.15]:
        seg(f"|margin|>= {lo:.2f}", conf >= lo)
    # by starter-quality gap (feature index 2 = starter rv diff)
    spgap = np.abs(Xa[:,2])
    seg("big starter-gap (top 25%)", spgap >= np.quantile(spgap,0.75))
    seg("small starter-gap (bot 50%)", spgap <= np.quantile(spgap,0.50))
    # by recent-form gap (index 4)
    rfgap = np.abs(Xa[:,4])
    seg("big recent-form gap (top 25%)", rfgap >= np.quantile(rfgap,0.75))
    # high-confidence AND big starter gap (the candidate bet pattern)
    seg("conf>=.10 & big starter-gap", (conf>=0.10)&(spgap>=np.quantile(spgap,0.75)))

    # ---- portable raw coefficients (fold scaler into the logistic) ----------
    sc = pipe.named_steps["standardscaler"]
    raw_coef = lr.coef_[0] / sc.scale_
    raw_int = lr.intercept_[0] - np.sum(lr.coef_[0] * sc.mean_ / sc.scale_)
    print("\n=== PORTABLE MODEL  P(home)=logistic(b0 + sum bi*xi) ===")
    print(f"  b0 = {raw_int:+.5f}")
    for nm, c in zip(names, raw_coef):
        print(f"  {nm:18} coef = {c:+.5f}")

    # ---- score yesterday's 8 ML bets through the calibrated model -----------
    bets = {822724:("KC@WSH","KC"),822887:("MIN@TEX","TEX"),823046:("SD@STL","SD"),
            823452:("MIA@PHI","MIA"),824181:("DET@HOU","HOU"),824505:("NYM@CIN","NYM"),
            824993:("PIT@ATH","PIT"),825071:("LAA@ARI","LAA")}
    pk_to_p = {meta[i]: p[i] for i in range(len(meta))}
    print("\n=== yesterday's 8 ML bets through the calibrated model ===")
    for pk,(mu,bet) in bets.items():
        if pk in pk_to_p:
            ph = pk_to_p[pk]
            home = mu.split("@")[1]
            we_bet = ph if bet==home else 1-ph
            print(f"  {mu:9} bet {bet:4} -> model WE {we_bet:.3f}")
        else:
            print(f"  {mu:9} bet {bet:4} -> (not in filtered set)")

if __name__ == "__main__":
    main()
