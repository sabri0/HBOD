"""Performance measures for decision engines (per world)."""
import numpy as np
from hbodsim import EVAL_START, T_DAYS

H = 7  # prediction horizon (days)


def future_onset(onset, h=H):
    """Y[i,t] = 1 if an onset occurs on days t+1..t+h."""
    N, T = onset.shape
    c = np.concatenate([np.zeros((N, 1)), np.cumsum(onset, 1)], 1)
    Y = np.zeros((N, T), bool)
    for t in range(T):
        a = min(T, t + 1); b = min(T, t + h)
        Y[:, t] = (c[:, b + 1 if b < T else T] - c[:, a]) > 0 if a <= b else False
    return Y


def _rank_auc(s, y):
    """AUROC via Mann-Whitney with tie handling. s, y 1-D."""
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return np.nan
    order = np.argsort(s, kind="mergesort")
    ss = s[order]
    ranks = np.empty(len(s))
    # average ranks for ties
    i = 0; r = np.arange(1, len(s) + 1, dtype=float)
    uniq, idx, cnt = np.unique(ss, return_index=True, return_counts=True)
    avg = idx + (cnt + 1) / 2.0
    ranks[order] = np.repeat(avg, cnt)
    return (ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0)


def _avg_precision(s, y):
    n1 = y.sum()
    if n1 == 0:
        return np.nan
    order = np.argsort(-s, kind="mergesort")
    ys = y[order]; ss = s[order]
    # group ties
    uniq, idx = np.unique(-ss, return_index=True)
    tp = np.cumsum(ys); fp = np.cumsum(~ys)
    ends = np.r_[idx[1:] - 1, len(ss) - 1]
    TP = tp[ends]; FP = fp[ends]
    prec = TP / (TP + FP); rec = TP / n1
    rec_prev = np.r_[0, rec[:-1]]
    return float(np.sum((rec - rec_prev) * prec))


def world_metrics(out, engines, alerts, onset=None, worlds=None, pt_grid=None):
    """
    Returns dict engine -> dict of arrays over worlds:
      auc, ap, sens_event, fa_per_month, ppv, alert_rate, lead, nb (n_pt)
    alerts: dict engine -> (N,T) bool
    """
    widx = out["widx"]; W = widx.max() + 1
    if onset is None:
        onset = out["onset_inj"] | out["onset_ill"]
    healthy = out["healthy"]
    Y = future_onset(onset)
    ev = np.zeros_like(healthy); ev[:, EVAL_START:] = True
    mask = healthy & ev
    if pt_grid is None:
        pt_grid = np.linspace(0.005, 0.10, 20)
    res = {}
    for e in engines:
        s_all = out["bank"].score[e].astype(float)
        s_all = np.where(np.isnan(s_all), -1e9, s_all)
        al = alerts[e]
        r = {k: np.full(W, np.nan) for k in ("auc", "ap", "sens_event", "fa_per_month", "ppv",
                                              "alert_rate", "lead", "n_events", "prev")}
        r["nb"] = np.full((W, len(pt_grid)), np.nan)
        for w in range(W):
            rows = widx == w
            m = mask[rows]; s = s_all[rows][m]; y = Y[rows][m]; a = al[rows][m]
            r["auc"][w] = _rank_auc(s, y)
            r["ap"][w] = _avg_precision(s, y)
            n = m.sum()
            tp = (a & y).sum(); fp = (a & ~y).sum()
            r["ppv"][w] = tp / max(a.sum(), 1)
            r["alert_rate"][w] = a.mean()
            r["prev"][w] = y.mean()
            r["fa_per_month"][w] = 30.0 * fp / max((~y).sum(), 1)
            r["nb"][w] = tp / n - fp / n * pt_grid / (1 - pt_grid)
            # event-level sensitivity and lead time
            on = onset[rows]; al_r = al[rows]; hl = healthy[rows]
            det = []; leads = []
            ii, tt = np.where(on[:, EVAL_START:])
            tt = tt + EVAL_START
            for i, t0 in zip(ii, tt):
                win = slice(max(EVAL_START, t0 - 7), t0)
                aw = al_r[i, win] & hl[i, win]
                det.append(aw.any())
                if aw.any():
                    first = np.argmax(aw); leads.append(t0 - (win.start + first))
            r["n_events"][w] = len(det)
            r["sens_event"][w] = np.mean(det) if det else np.nan
            r["lead"][w] = np.mean(leads) if leads else np.nan
        res[e] = r
    res["_pt"] = pt_grid
    res["_treat_all"] = None
    return res


def matched_budget_alerts(out, engines, rate=0.10):
    """Per-world thresholds so that each engine alerts on the same fraction of evaluated healthy days."""
    widx = out["widx"]; W = widx.max() + 1
    healthy = out["healthy"]; ev = np.zeros_like(healthy); ev[:, EVAL_START:] = True
    mask = healthy & ev
    al = {}
    for e in engines:
        s = out["bank"].score[e].astype(float)
        s = np.where(np.isnan(s), -1e9, s)
        A = np.zeros_like(healthy)
        for w in range(W):
            rows = widx == w
            v = s[rows][mask[rows]]
            if len(v) == 0:
                continue
            thr = np.quantile(v, 1 - rate)
            # random tie-break so that ties at the threshold do not inflate the budget
            rnd = np.random.default_rng(w).random(s[rows].shape) * 1e-9
            A[rows] = (s[rows] + rnd) > thr
        al[e] = A & mask
    return al
