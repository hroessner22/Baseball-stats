"""Add a REAL starter-quality feature (season ERA-to-date) to the calibration.

Replaces the weak PA-outcome run-value proxy (which under-weighted aces like
Burns) with each starter's actual season ERA entering the game, computed
leak-free from per-pitcher game logs. Re-fits the win-prob model and re-runs
the large-margin pattern analysis to see if the real metric sharpens it.

Reuses /tmp/dc_cal_cache.pkl (schedule + daily_pa) from calibrate_we.py.
Caches pitcher game logs at /tmp/dc_starter_logs.pkl.
"""
from __future__ import annotations
import json, ssl, urllib.request, bisect, os, pickle
from collections import defaultdict
import certifi, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_predict

CTX = ssl.create_default_context(cafile=certifi.where())
LG_R, LG_ERA, LG_KRATE = 4.5, 4.3, 0.225
RV = {"BB":0.31,"HBP":0.33,"1B":0.45,"2B":0.76,"3B":1.04,"HR":1.40,
      "K":-0.27,"OUT":-0.27,"OTHER":0.0}

def jget(u):
    req=urllib.request.Request(u, headers={"User-Agent":"dc/1.0"})
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=30))
def half_top(h): return str(h or "").lower().startswith(("top","mid"))

def fetch_pitcher_log(pid):
    """[(date, er, ip)] across 2025+2026, sorted by date."""
    out=[]
    for yr in (2025,2026):
        try:
            d=jget(f"https://statsapi.mlb.com/api/v1/people/{pid}/stats"
                   f"?stats=gameLog&group=pitching&season={yr}")
            for s in d["stats"][0]["splits"]:
                st=s["stat"]; ip=float(st.get("inningsPitched") or 0)
                er=float(st.get("earnedRuns") or 0)
                out.append((s["date"], er, ip))
        except Exception:
            pass
    out.sort(); return out

def main():
    with open("/tmp/dc_cal_cache.pkl","rb") as f: games, pa = pickle.load(f)
    print(f"cache: {len(games)} games, {len(pa)} PA rows")

    # starters + pitcher PA stats (for K-rate, reuse rv path too)
    first={}; pit_pa=defaultdict(list)
    for r in pa:
        pid=r["pitcher_mlbam"]; date=r["game_date"]
        pit_pa[pid].append((date, RV.get(r["outcome"],0.0), 1 if r["outcome"]=="K" else 0))
        if r["inning"]==1:
            side="home" if half_top(r["half"]) else "away"
            key=(r["game_pk"],side); pi=r["pa_index"]
            if key not in first or pi<first[key][0]: first[key]=(pi,pid)
    for pid in pit_pa: pit_pa[pid].sort()
    starters={gp:{} for gp,_ in first}
    for (gp,side),(_,pid) in first.items(): starters[gp][side]=pid

    # fetch game logs for every distinct starter (cached)
    sids=sorted({pid for s in starters.values() for pid in s.values()})
    print(f"distinct starters: {len(sids)} — fetching game logs (cached)...")
    cache="/tmp/dc_starter_logs.pkl"
    logs=pickle.load(open(cache,"rb")) if os.path.exists(cache) else {}
    n=0
    for pid in sids:
        if pid not in logs:
            logs[pid]=fetch_pitcher_log(pid); n+=1
            if n%100==0: print(f"  fetched {n}..."); pickle.dump(logs,open(cache,"wb"))
    pickle.dump(logs,open(cache,"wb"))
    print(f"  fetched {n} new, {len(logs)} total")

    def era_to_date(pid, date, prior_ip=30):
        arr=logs.get(pid)
        if not arr: return 0.0
        i=bisect.bisect_left(arr,(date,-9,-9))
        if i==0: return 0.0
        er=sum(e for _,e,_ in arr[:i]); ip=sum(p for _,_,p in arr[:i])
        if ip<=0: return 0.0
        era=(er*9 + prior_ip*LG_ERA)/(ip+prior_ip)   # shrink toward league
        return era - LG_ERA                            # above-league (positive=worse)
    def krate(pid, date, prior=80):
        arr=pit_pa.get(pid)
        if not arr: return 0.0
        i=bisect.bisect_left(arr,(date,-9,-9))
        if i==0: return 0.0
        sk=sum(k for _,_,k in arr[:i]); n=i
        return (sk+prior*LG_KRATE)/(n+prior)-LG_KRATE

    team_rs=defaultdict(list); team_ra=defaultdict(list)
    def reg(v,pg=8,lg=LG_R): return lg if not v else (sum(v)+pg*lg)/(len(v)+pg)
    def recent(t,n=10):
        rs,ra=team_rs[t][-n:],team_ra[t][-n:]
        return (sum(rs)-sum(ra))/len(rs) if rs else 0.0

    X,y,meta=[],[],[]; MIN=20
    for pk,g in sorted(games.items(), key=lambda kv:kv[1]["date"]):
        h,a,date=g["home"],g["away"],g["date"]; sp=starters.get(pk,{})
        if len(team_rs[h])>=MIN and len(team_rs[a])>=MIN:
            h_era=era_to_date(sp.get("home"),date) if sp.get("home") else 0.0
            a_era=era_to_date(sp.get("away"),date) if sp.get("away") else 0.0
            h_k=krate(sp.get("home"),date) if sp.get("home") else 0.0
            a_k=krate(sp.get("away"),date) if sp.get("away") else 0.0
            X.append([reg(team_rs[h])-reg(team_rs[a]), reg(team_ra[h])-reg(team_ra[a]),
                      h_era-a_era, h_k-a_k, recent(h)-recent(a)])
            y.append(g["home_win"]); meta.append(pk)
        team_rs[h].append(g["hs"]); team_ra[h].append(g["as"])
        team_rs[a].append(g["as"]); team_ra[a].append(g["hs"])

    X=np.array(X); y=np.array(y)
    pipe=make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))
    pipe.fit(X,y)
    p=cross_val_predict(pipe,X,y,cv=5,method="predict_proba")[:,1]
    brier=np.mean((p-y)**2); brier0=np.mean((y.mean()-y)**2)
    lr=pipe.named_steps["logisticregression"]
    print(f"\n=== REAL-ERA model: {len(y)} games (5-fold OOS) ===")
    names=["off_diff","def_diff","starter_ERA_diff","starter_K%_diff","recent10_diff"]
    print("standardized weights:")
    for nm,c in zip(names,lr.coef_[0]): print(f"  {nm:18} {c:+.4f}")
    print(f"Brier {brier:.4f} vs baseline {brier0:.4f} = {(brier0-brier)/brier0*100:.1f}% better")
    pick_win=np.where(p>=0.5,y,1-y); conf=np.abs(p-0.5)
    print("\nlarge-margin pattern (fav win% by margin):")
    for lo in [0.0,0.05,0.10,0.15]:
        m=conf>=lo
        if m.sum()>40: print(f"  margin>={lo:.2f}: n={m.sum():4d} fav win% {pick_win[m].mean():.3f}")
    # Burns game check
    if 824505 in meta:
        i=meta.index(824505); ph=p[i]
        print(f"\nBurns game NYM@CIN: model P(home/CIN)={ph:.3f}  P(NYM)={1-ph:.3f}  (market NYM .45, was .48)")

if __name__=="__main__":
    main()
