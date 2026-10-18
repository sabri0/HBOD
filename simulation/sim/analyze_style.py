"""Summaries for the post hoc check by reporting style."""
import numpy as np, pickle, glob, json
from analyze import est, paired, bh, load_main
R = [pickle.load(open(f, 'rb')) for f in sorted(glob.glob('res_style/chunk_*.pkl'))]
auc = {e: np.vstack([r['auc'][e] for r in R]) for e in R[0]['auc']}
dl = {a: np.vstack([r['dl'][a] for r in R]) for a in R[0]['dl']}
n = np.vstack([r['n'] for r in R])
# sanity: athlete-weighted days lost reproduces the main run
res, cl, real, X = load_main()
for a in ['v2', 'ewma', 'random', 'none']:
    w = np.nansum(np.nan_to_num(dl[a]) * n, 1) / n.sum(1)
    print('sanity', a, round(float(np.max(np.abs(w - cl[a][:, 0]))), 6))
names = ['honest', 'under', 'compressor', 'careless']
out = {}
for k, nm in enumerate(names):
    ok = n[:, k] > 0
    d = dict(n_worlds=int(ok.sum()), n_athletes=int(n[:, k].sum()))
    for e in auc: d['auc_' + e] = est(auc[e][ok, k])
    d['aucd_v2_coupled'] = paired(auc['v2'][ok, k], auc['ra_coupled'][ok, k])
    d['aucd_v2_ewma'] = paired(auc['v2'][ok, k], auc['ewma'][ok, k])
    for a in dl: d['dl_' + a] = est(dl[a][ok, k])
    d['dl_v2_ewma'] = paired(dl['v2'][ok, k], dl['ewma'][ok, k])
    d['dl_v2_random'] = paired(dl['v2'][ok, k], dl['random'][ok, k])
    out[nm] = d
for key in ['dl_v2_ewma', 'aucd_v2_ewma', 'aucd_v2_coupled']:
    q = bh([out[nm][key]['p'] for nm in names])
    for nm, qq in zip(names, q): out[nm][key]['q'] = float(qq)
for nm in names:
    d = out[nm]; f = lambda s, k=3: f"{s['mean']:.{k}f} ({s['lo']:.{k}f} to {s['hi']:.{k}f})"
    print(nm, 'worlds', d['n_worlds'], 'athletes', d['n_athletes'])
    print('   AUROC v2', f(d['auc_v2']), 'coupled', f(d['auc_ra_coupled']), 'ewma', f(d['auc_ewma']), 'wellness', f(d['auc_wellness']))
    print('   AUROC v2-coupled', f(d['aucd_v2_coupled']), 'q', round(d['aucd_v2_coupled']['q'], 4), ' v2-ewma', f(d['aucd_v2_ewma']), 'q', round(d['aucd_v2_ewma']['q'], 4))
    print('   days lost none', f(d['dl_none'], 2), 'v2', f(d['dl_v2'], 2), 'ewma', f(d['dl_ewma'], 2), 'random', f(d['dl_random'], 2))
    print('   v2-ewma', f(d['dl_v2_ewma'], 2), 'q', round(d['dl_v2_ewma']['q'], 4), '  v2-random', f(d['dl_v2_random'], 2))
def conv(o):
    if isinstance(o, dict): return {k: conv(v) for k, v in o.items()}
    if isinstance(o, (np.floating, np.integer)): return o.item()
    return o
json.dump(conv(out), open('summary_style.json', 'w'), indent=1)
