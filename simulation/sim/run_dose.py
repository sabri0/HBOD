"""Post hoc dose-response analysis: alert budget versus load withheld and days lost."""
import numpy as np, pickle, os, time
import experiments as ex, hbodsim as hs
from engines import EngineBank
X = np.load('eval_X.npy')[:300]; W = len(X); N = W * hs.A_PER_SQUAD
widx = np.repeat(np.arange(W), hs.A_PER_SQUAD); seed = 950000
arms = ['v1', 'ra_coupled', 'ewma', 'wellness', 'v2']
t0 = time.time()
res, thr0, base, o = ex.open_loop(X, seed, engines=arms)
out = {'none': base}
for rate in [0.05, 0.10, 0.20, 0.30]:
    for e in arms:
        thr = ex.budget_thresholds(o, e, rate)
        b = EngineBank(N, hs.T_DAYS, widx, W); b.thr[e] = thr
        out[(e, rate)] = ex.world_outcomes(hs.simulate(X, seed=seed, policy=e, engines=b))
    b = EngineBank(N, hs.T_DAYS, widx, W); b.placebo_rate = np.full(W, rate)
    out[('random', rate)] = ex.world_outcomes(hs.simulate(X, seed=seed, policy='random:x', engines=b))
    print(rate, round(time.time() - t0), flush=True)
pickle.dump(out, open('res_dose.pkl', 'wb'))
