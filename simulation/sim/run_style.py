"""Post hoc check by reporting style: discrimination and closed-loop days lost for athletes who report honestly,
under-report, compress their answers or answer carelessly. Same 1000 evaluation worlds and seeds as run_main.py."""
import numpy as np, pickle, os, time
import experiments as ex, hbodsim as hs, metrics as mt
from engines import EngineBank
X = np.load('eval_X.npy'); CH = 50
ENG = ['ra_coupled', 'ewma', 'wellness', 'v2']; ARMS = ['ewma', 'v2']
os.makedirs('res_style', exist_ok=True)

def style_auc(o, e):
    widx = o['widx']; W = widx.max() + 1; st = o['style']
    Y = mt.future_onset(o['onset_inj'] | o['onset_ill'])
    ev = np.zeros_like(o['healthy']); ev[:, hs.EVAL_START:] = True; m = o['healthy'] & ev
    s = np.nan_to_num(o['bank'].score[e].astype(float), nan=-1e9)
    out = np.full((W, 4), np.nan)
    for w in range(W):
        for k in range(4):
            r = (widx == w) & (st == k)
            if r.sum() == 0: continue
            mm = m[r]; out[w, k] = mt._rank_auc(s[r][mm], Y[r][mm])
    return out

def style_days_lost(o):
    widx = o['widx']; W = widx.max() + 1; st = o['style']
    E = np.zeros_like(o['healthy']); E[:, hs.EVAL_START:] = True
    out = np.full((W, 4), np.nan)
    for w in range(W):
        for k in range(4):
            r = (widx == w) & (st == k)
            if r.sum() == 0: continue
            e = E[r]; out[w, k] = ((~o['healthy'][r]) & e).sum() / e.sum() * 100
    return out

for c in range(0, 1000, CH):
    f = f'res_style/chunk_{c:04d}.pkl'
    if os.path.exists(f): continue
    t0 = time.time(); seed = 900000 + c; Xc = X[c:c + CH]
    W = len(Xc); N = W * hs.A_PER_SQUAD; widx = np.repeat(np.arange(W), hs.A_PER_SQUAD)
    o = hs.simulate(Xc, seed=seed)
    auc = {e: style_auc(o, e) for e in ENG}
    n_style = np.array([[((o['widx'] == w) & (o['style'] == k)).sum() for k in range(4)] for w in range(W)])
    thr = {e: ex.budget_thresholds(o, e) for e in ARMS}
    dl = {'none': style_days_lost(o)}
    for e in ARMS:
        b = EngineBank(N, hs.T_DAYS, widx, W); b.thr[e] = thr[e]
        dl[e] = style_days_lost(hs.simulate(Xc, seed=seed, policy=e, engines=b))
    b = EngineBank(N, hs.T_DAYS, widx, W); b.placebo_rate = np.full(W, ex.RATE)
    dl['random'] = style_days_lost(hs.simulate(Xc, seed=seed, policy='random:x', engines=b))
    pickle.dump(dict(auc=auc, dl=dl, n=n_style), open(f, 'wb'))
    print(c, round(time.time() - t0, 1), flush=True)
