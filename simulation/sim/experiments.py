"""Evaluation experiments: open loop, closed loop, robustness grid, global sensitivity."""
import numpy as np, warnings
warnings.filterwarnings("ignore")
import hbodsim as hs, metrics as mt
from engines import EngineBank, ENGINES

RATE = 0.10
CL_ARMS = ["v1", "ra_coupled", "ra_uncoupled", "ewma", "tsb", "wellness", "v2", "v2_noW"]


def _mask(o):
    ev = np.zeros_like(o["healthy"]); ev[:, hs.EVAL_START:] = True
    return o["healthy"] & ev


def budget_thresholds(o, e, rate=RATE):
    widx = o["widx"]; W = widx.max() + 1; m = _mask(o)
    s = np.nan_to_num(o["bank"].score[e].astype(float), nan=-1e9); th = np.zeros(W)
    for w in range(W):
        r = widx == w; v = s[r][m[r]]
        th[w] = np.quantile(v, 1 - rate) if len(v) else np.inf
    return th[widx]


def world_outcomes(o):
    """Per-world closed-loop outcomes: days lost /100 athlete-days, injury and illness /1000, load (kAU/athlete), perf."""
    widx = o["widx"]; W = widx.max() + 1
    E = np.zeros_like(o["healthy"]); E[:, hs.EVAL_START:] = True
    res = np.zeros((W, 5))
    for w in range(W):
        r = widx == w; e = E[r]; ad = e.sum()
        res[w] = [((~o["healthy"][r]) & e).sum() / ad * 100,
                  (o["onset_inj"][r] & e).sum() / ad * 1000,
                  (o["onset_ill"][r] & e).sum() / ad * 1000,
                  o["w_true"][r][:, hs.EVAL_START:].sum(1).mean() / 1000,
                  (o["G"][r] - o["H"][r])[:, -1].mean()]
    return res


OUT_NAMES = ["days_lost", "inj", "ill", "load", "perf"]


def open_loop(X, seed, engines=ENGINES):
    o = hs.simulate(X, seed=seed)
    b = o["bank"]
    al_def = {e: b.alerts(e) & _mask(o) for e in engines}
    al_bud = mt.matched_budget_alerts(o, engines, RATE)
    R_def = mt.world_metrics(o, engines, al_def)
    R_bud = mt.world_metrics(o, engines, al_bud)
    R_inj = mt.world_metrics(o, engines, al_bud, onset=o["onset_inj"])
    R_ill = mt.world_metrics(o, engines, al_bud, onset=o["onset_ill"])
    res = {}
    for e in engines:
        res[e] = dict(auc=R_def[e]["auc"], ap=R_def[e]["ap"], prev=R_def[e]["prev"],
                      sens_def=R_def[e]["sens_event"], fa_def=R_def[e]["fa_per_month"],
                      ppv_def=R_def[e]["ppv"], rate_def=R_def[e]["alert_rate"], lead_def=R_def[e]["lead"],
                      sens_bud=R_bud[e]["sens_event"], fa_bud=R_bud[e]["fa_per_month"],
                      ppv_bud=R_bud[e]["ppv"], lead_bud=R_bud[e]["lead"], nb=R_bud[e]["nb"],
                      nb_def=R_def[e]["nb"], n_events=R_def[e]["n_events"],
                      auc_inj=R_inj[e]["auc"], auc_ill=R_ill[e]["auc"])
    thr = {e: budget_thresholds(o, e) for e in CL_ARMS}
    base = world_outcomes(o)
    return res, thr, base, o


def closed_loop(X, seed, thr, arms=CL_ARMS):
    W = X.shape[0]; N = W * hs.A_PER_SQUAD; widx = np.repeat(np.arange(W), hs.A_PER_SQUAD)
    out = {}; realised = {}
    for e in arms:
        b = EngineBank(N, hs.T_DAYS, widx, W); b.thr[e] = thr[e]
        o = hs.simulate(X, seed=seed, policy=e, engines=b)
        out[e] = world_outcomes(o)
        m = _mask(o); al = b.alerts(e) & m
        realised[e] = np.array([al[widx == w].sum() / max(m[widx == w].sum(), 1) for w in range(W)])
    b = EngineBank(N, hs.T_DAYS, widx, W); b.placebo_rate = np.full(W, RATE)
    o = hs.simulate(X, seed=seed, policy="random:x", engines=b)
    out["random"] = world_outcomes(o)
    return out, realised
