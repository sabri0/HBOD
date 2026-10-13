import numpy as np, pickle, json
from scipy import stats
D = pickle.load(open('../sim/res_dose.pkl', 'rb'))
base = D['none']; arms = ['v1', 'ra_coupled', 'ewma', 'wellness', 'v2', 'random']; rates = [0.05, 0.10, 0.20, 0.30]
out = {}
for a in arms:
    for r in rates:
        o = D[(a, r)]
        wd = base[:, 3] - o[:, 3]; av = base[:, 0] - o[:, 0]
        out[f'{a}_{r}'] = dict(withheld=wd.mean(), withheld_se=wd.std(ddof=1)/np.sqrt(len(wd)), averted=av.mean(), averted_se=av.std(ddof=1)/np.sqrt(len(av)),
                               inj=(base[:,1]-o[:,1]).mean(), ill=(base[:,2]-o[:,2]).mean())
        print(f"{a:11s} {r:.2f} withheld {wd.mean():.2f} kAU  days averted {av.mean():.2f}  per kAU {av.mean()/wd.mean():.2f}  inj {out[f'{a}_{r}']['inj']:.2f} ill {out[f'{a}_{r}']['ill']:.2f}")
# matched withheld load: per world, interpolate days lost averted at common withheld values via linear interpolation over budgets
grid = np.array([1.0, 1.5, 2.0, 2.5])
res = {}
for a in arms:
    W = np.stack([base[:, 3] - D[(a, r)][:, 3] for r in rates], 1); A = np.stack([base[:, 0] - D[(a, r)][:, 0] for r in rates], 1)
    Wm = W.mean(0); Am = A
    # interpolate on the squad-averaged dose axis (monotone in budget), world-level outcome for CI
    vals = np.stack([np.array([np.interp(g, Wm, Am[k]) for g in grid]) for k in range(len(A))])
    res[a] = vals
    print(a, 'dose range', np.round(Wm, 2))
print('days averted at matched load withheld (kAU per athlete):', grid)
for a in arms:
    print(f"{a:11s}", np.round(res[a].mean(0), 3))
for a in arms:
    if a == 'random': continue
    d = res[a] - res['random']; m = d.mean(0); h = stats.t.ppf(.975, len(d)-1) * d.std(0, ddof=1) / np.sqrt(len(d))
    print(f"{a:11s} minus random", np.round(m, 3), 'CI lo', np.round(m - h, 3), 'hi', np.round(m + h, 3))
json.dump(dict(out=out, grid=grid.tolist(), matched={a: res[a].mean(0).tolist() for a in arms}), open('../sim/summary_dose.json', 'w'), indent=1, default=float)
