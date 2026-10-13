"""Aggregate evaluation results: estimates, 95% CI, MCSE, paired contrasts, BH q-values, decision rule."""
import numpy as np, pickle, glob, json
from scipy import stats
import hbodsim as hs
from engines import ENGINES

def load_main():
    R = [pickle.load(open(f, 'rb')) for f in sorted(glob.glob('../sim/res_main/chunk_*.pkl'))]
    res = {e: {k: np.concatenate([r['res'][e][k] for r in R]) for k in R[0]['res'][e]} for e in ENGINES}
    cl = {a: np.vstack([r['cl'][a] for r in R]) for a in R[0]['cl']}
    real = {a: np.concatenate([r['real'][a] for r in R]) for a in R[0]['real']}
    X = np.vstack([r['X'] for r in R])
    return res, cl, real, X

def est(x):
    x = x[~np.isnan(x)]; n = len(x); m = x.mean(); s = x.std(ddof=1); se = s / np.sqrt(n)
    h = stats.t.ppf(0.975, n - 1) * se
    return dict(mean=m, lo=m - h, hi=m + h, mcse=se, sd=s, n=n)

def paired(a, b):
    d = a - b; ok = ~np.isnan(d); d = d[ok]; e = est(d)
    e['p'] = stats.ttest_1samp(d, 0).pvalue
    e['dz'] = d.mean() / d.std(ddof=1)
    return e

def bh(p):
    p = np.asarray(p); n = len(p); o = np.argsort(p); q = np.empty(n)
    q[o] = np.minimum.accumulate((p[o] * n / np.arange(1, n + 1))[::-1])[::-1]
    return np.minimum(q, 1)

if __name__ == '__main__':
    res, cl, real, X = load_main()
    out = {'n_worlds': len(X)}
    # open loop
    keys = ['auc', 'ap', 'prev', 'sens_def', 'fa_def', 'ppv_def', 'rate_def', 'lead_def', 'sens_bud', 'fa_bud',
            'ppv_bud', 'lead_bud', 'auc_inj', 'auc_ill', 'n_events']
    out['open'] = {e: {k: est(res[e][k]) for k in keys} for e in ENGINES}
    comps = [e for e in ENGINES if e != 'v2']
    for k in ['auc', 'ap', 'auc_inj', 'auc_ill', 'sens_bud', 'ppv_bud']:
        pr = {e: paired(res['v2'][k], res[e][k]) for e in comps}
        q = bh([pr[e]['p'] for e in comps])
        for e, qq in zip(comps, q): pr[e]['q'] = qq
        out.setdefault('paired_v2_minus', {})[k] = pr
    # net benefit
    pt = np.linspace(0.005, 0.10, 20)
    out['nb'] = {e: [est(res[e]['nb'][:, j]) for j in range(len(pt))] for e in ENGINES}
    out['pt'] = pt.tolist()
    # closed loop
    names = ['days_lost', 'inj', 'ill', 'load', 'perf']
    out['closed'] = {a: {n: est(cl[a][:, j]) for j, n in enumerate(names)} for a in cl}
    out['realised'] = {a: est(real[a]) for a in real}
    acwr = ['ra_coupled', 'ra_uncoupled', 'ewma']
    best = min(acwr, key=lambda a: cl[a][:, 0].mean()); out['best_acwr'] = best
    arms = [a for a in cl if a not in ('random', 'none')]
    vs_rand = {a: {n: paired(cl[a][:, j], cl['random'][:, j]) for j, n in enumerate(names)} for a in arms}
    for j, n in enumerate(names):
        q = bh([vs_rand[a][n]['p'] for a in arms])
        for a, qq in zip(arms, q): vs_rand[a][n]['q'] = qq
    out['vs_random'] = vs_rand
    cand = [a for a in arms if a not in acwr]
    vs_best = {a: {n: paired(cl[a][:, j], cl[best][:, j]) for j, n in enumerate(names)} for a in cand}
    for j, n in enumerate(names):
        q = bh([vs_best[a][n]['p'] for a in cand])
        for a, qq in zip(cand, q): vs_best[a][n]['q'] = qq
    out['vs_best_acwr'] = vs_best
    best_auc = max(acwr, key=lambda a: np.nanmean(res[a]['auc'])); out['best_acwr_auc'] = best_auc
    out['ni_auc'] = {a: paired(res[a]['auc'], res[best_auc]['auc']) for a in cand}
    json.dump(out, open('summary_main.json', 'w'), indent=1, default=float)
    # print digest
    print('worlds', len(X), 'best ACWR (days lost):', best, ' best ACWR (AUROC):', best_auc)
    for e in ENGINES:
        o = out['open'][e]
        print(f"{e:12s} AUC {o['auc']['mean']:.3f} [{o['auc']['lo']:.3f},{o['auc']['hi']:.3f}] AP {o['ap']['mean']:.3f} "
              f"inj {o['auc_inj']['mean']:.3f} ill {o['auc_ill']['mean']:.3f} | default rate {o['rate_def']['mean']:.3f} "
              f"sens {o['sens_def']['mean']:.3f} FA/mo {o['fa_def']['mean']:.2f} | budget sens {o['sens_bud']['mean']:.3f} ppv {o['ppv_bud']['mean']:.3f}")
    print('prevalence of 7-day onset', out['open']['v2']['prev']['mean'])
    for a in cl:
        c = out['closed'][a]
        print(f"{a:12s} days lost {c['days_lost']['mean']:.3f} inj {c['inj']['mean']:.3f} ill {c['ill']['mean']:.3f} load {c['load']['mean']:.2f} perf {c['perf']['mean']:.3f}")
    for a in arms:
        v = vs_rand[a]['days_lost']; print(f"vs random {a:12s} d={v['mean']:.3f} [{v['lo']:.3f},{v['hi']:.3f}] q={v['q']:.4f}")
    for a in cand:
        v = vs_best[a]['days_lost']; ni = out['ni_auc'][a]
        print(f"vs {best} {a:12s} d={v['mean']:.3f} [{v['lo']:.3f},{v['hi']:.3f}] q={v['q']:.4f} | AUC diff vs {best_auc} {ni['mean']:.4f} [{ni['lo']:.4f},{ni['hi']:.4f}]")
