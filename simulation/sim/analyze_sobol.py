import numpy as np, pickle, glob, json
from SALib.analyze import sobol as sa
import hbodsim as hs
C = np.load('../sim/calib_out.npz')
names = list(hs.PNAMES) + ['dummy']
lo = list(C['lo1']) + [0.0]; hi = list(C['hi1']) + [1.0]
prob = dict(num_vars=len(names), names=names, bounds=[[l, h] for l, h in zip(lo, hi)])
R = [pickle.load(open(f, 'rb')) for f in sorted(glob.glob('../sim/res_sob/chunk_*.pkl'))]
cat = lambda k: np.concatenate([r[k] for r in R])
Y = {'auc_v2': cat('auc_v2'), 'auc_diff': cat('auc_v2') - cat('auc_ewma'), 'dl_diff': cat('dl_v2') - cat('dl_ewma')}
out = {}
for k, y in Y.items():
    y = np.where(np.isnan(y), np.nanmean(y), y)
    Si = sa.analyze(prob, y, calc_second_order=False, seed=7, num_resamples=500)
    out[k] = {n: dict(S1=float(Si['S1'][i]), S1c=float(Si['S1_conf'][i]), ST=float(Si['ST'][i]), STc=float(Si['ST_conf'][i])) for i, n in enumerate(names)}
    order = np.argsort(-Si['ST'])
    print(k, 'n', len(y), 'nan', int(np.isnan(Y[k]).sum()))
    for i in order[:8]: print(f"   {names[i]:10s} S1 {Si['S1'][i]:.3f}±{Si['S1_conf'][i]:.3f}  ST {Si['ST'][i]:.3f}±{Si['ST_conf'][i]:.3f}")
    d = names.index('dummy'); print(f"   dummy      S1 {Si['S1'][d]:.3f}  ST {Si['ST'][d]:.3f}±{Si['ST_conf'][d]:.3f}")
json.dump(out, open('../sim/summary_sobol.json', 'w'), indent=1)

# complementary given-data first-order index: correlation ratio from 20 quantile bins
Xs = np.load('../sim/sobol_X.npy')
eta = {}
rng = np.random.default_rng(11)
for k, y in Y.items():
    ok = ~np.isnan(y); yy = y[ok]; XX = Xs[ok]; vy = yy.var(); eta[k] = {}
    for i, n in enumerate(names):
        q = np.quantile(XX[:, i], np.linspace(0, 1, 21)); b = np.clip(np.searchsorted(q, XX[:, i], side='right') - 1, 0, 19)
        def ratio(yv):
            m = np.array([yv[b == j].mean() for j in range(20)]); w = np.array([(b == j).mean() for j in range(20)])
            return float((w * (m - yv.mean()) ** 2).sum() / yv.var())
        boot = [ratio(yy[idx]) if False else None for idx in []]
        est = ratio(yy)
        bs = []
        for r in range(200):
            idx = rng.integers(0, len(yy), len(yy)); yb = yy[idx]; bb = b[idx]
            m = np.array([yb[bb == j].mean() for j in range(20)]); w = np.array([(bb == j).mean() for j in range(20)])
            bs.append((w * (m - yb.mean()) ** 2).sum() / yb.var())
        eta[k][n] = dict(S1=est, lo=float(np.percentile(bs, 2.5)), hi=float(np.percentile(bs, 97.5)))
    od = sorted(eta[k], key=lambda n: -eta[k][n]['S1'])
    print('binned', k, [(n, round(eta[k][n]['S1'], 4), round(eta[k][n]['hi'], 4)) for n in od[:7]], 'dummy', round(eta[k]['dummy']['S1'], 4), round(eta[k]['dummy']['hi'], 4))
json.dump(dict(saltelli=out, binned=eta), open('../sim/summary_sobol.json', 'w'), indent=1)
