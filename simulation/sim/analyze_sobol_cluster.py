"""Binned first-order indices with a cluster bootstrap over Saltelli base rows, and mean HBOD minus EWMA ACWR differences in the non-history-matched Sobol worlds."""
import numpy as np, pickle, glob, json
import hbodsim as hs
names = list(hs.PNAMES) + ['dummy']; D = len(names)
R = [pickle.load(open(f, 'rb')) for f in sorted(glob.glob('res_sob/chunk_*.pkl'))]
cat = lambda k: np.concatenate([r[k] for r in R])
Y = {'auc_v2': cat('auc_v2'), 'auc_diff': cat('auc_v2') - cat('auc_ewma'), 'dl_diff': cat('dl_v2') - cat('dl_ewma')}
Xs = np.load('sobol_X.npy'); n = len(Xs); blk = D + 2; assert n % blk == 0; NB = n // blk
grp = np.repeat(np.arange(NB), blk)
rng = np.random.default_rng(12)
def eta(y, x):
    q = np.quantile(x, np.linspace(0, 1, 21)); b = np.clip(np.searchsorted(q, x, side='right') - 1, 0, 19)
    m = np.array([y[b == j].mean() for j in range(20)]); w = np.array([(b == j).mean() for j in range(20)])
    return float((w * (m - y.mean()) ** 2).sum() / y.var())
out = {}
B = 500; boots = [rng.integers(0, NB, NB) for _ in range(B)]
idxs = [np.concatenate([np.where(grp == g)[0] for g in bb]) for bb in boots]
for k, y in Y.items():
    y = np.where(np.isnan(y), np.nanmean(y), y); out[k] = {}
    for i, nm in enumerate(names):
        est = eta(y, Xs[:, i]); bs = [eta(y[ix], Xs[ix, i]) for ix in idxs]
        bs = np.array(bs); bias = bs.mean() - est   # resampled blocks contain duplicated rows, which inflates the correlation ratio
        out[k][nm] = dict(S1=est, bias=float(bias), lo=float(np.percentile(bs, 2.5) - bias), hi=float(np.percentile(bs, 97.5) - bias),
                          lo_raw=float(np.percentile(bs, 2.5)), hi_raw=float(np.percentile(bs, 97.5)))
    od = sorted(out[k], key=lambda z: -out[k][z]['S1'])
    print(k, [(z, round(out[k][z]['S1'], 4), round(out[k][z]['lo'], 4), round(out[k][z]['hi'], 4)) for z in od[:6]],
          'dummy', round(out[k]['dummy']['S1'], 4), round(out[k]['dummy']['hi'], 4))
# mean differences, cluster bootstrap CI
md = {}
for k in ['auc_diff', 'dl_diff']:
    y = Y[k]; ok = ~np.isnan(y)
    est = float(np.nanmean(y)); bs = [np.nanmean(y[ix]) for ix in idxs]
    md[k] = dict(mean=est, lo=float(np.percentile(bs, 2.5)), hi=float(np.percentile(bs, 97.5)), n=int(ok.sum()), share_neg=float((y[ok] < 0).mean()))
    print(k, md[k])
json.dump(dict(binned_cluster=out, mean_diff=md, n_blocks=NB, block=blk), open('summary_sobol_cluster.json', 'w'), indent=1)
