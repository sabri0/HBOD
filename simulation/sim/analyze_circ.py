"""Circularity checks: prodrome and progression quartiles (main run) and the life-stress-off sensitivity run."""
import numpy as np, pickle, glob, json
import hbodsim as hs
from analyze import load_main, est, paired
res, cl, real, X = load_main()
out = {}
for par in ['prodrome', 'prog']:
    j = hs.PNAMES.index(par); q = np.quantile(X[:, j], [0, .25, .5, .75, 1]); out[par] = {'cuts': q.tolist()}
    for k in range(4):
        m = (X[:, j] >= q[k]) & (X[:, j] <= q[k + 1])
        out[par][f'Q{k+1}'] = dict(dl_v2_ewma=paired(cl['v2'][m, 0], cl['ewma'][m, 0]),
                                   dl_v2_rand=paired(cl['v2'][m, 0], cl['random'][m, 0]),
                                   ill_v2_ewma=paired(cl['v2'][m, 2], cl['ewma'][m, 2]),
                                   aucill_v2=est(res['v2']['auc_ill'][m]), aucill_ewma=est(res['ewma']['auc_ill'][m]),
                                   n=int(m.sum()))
    p10 = np.quantile(X[:, j], 0.10); m = X[:, j] < p10
    out[par]['below_p10'] = dict(cut=float(p10), n=int(m.sum()), dl_v2_ewma=paired(cl['v2'][m, 0], cl['ewma'][m, 0]),
                                 aucill_v2=est(res['v2']['auc_ill'][m]))
# life-stress-off run
L = {}
for tag in ['off', 'on']:
    R = [pickle.load(open(f, 'rb')) for f in sorted(glob.glob(f'res_lifeoff/{tag}_*.pkl'))]
    L[tag] = dict(res={e: {k: np.concatenate([r['res'][e][k] for r in R]) for k in ['auc', 'auc_inj', 'auc_ill']} for e in R[0]['res']},
                  cl={a: np.vstack([r['cl'][a] for r in R]) for a in R[0]['cl']})
lo = {}
for tag in L:
    c = L[tag]['cl']; r = L[tag]['res']
    acwr = ['ra_coupled', 'ra_uncoupled', 'ewma']; best = min(acwr, key=lambda a: c[a][:, 0].mean())
    lo[tag] = dict(n=len(c['v2']), best=best,
                   none_dl=est(c['none'][:, 0]), none_ill=est(c['none'][:, 2]), none_inj=est(c['none'][:, 1]),
                   dl={a: est(c[a][:, 0]) for a in c},
                   v2_best=paired(c['v2'][:, 0], c[best][:, 0]), v2_ewma=paired(c['v2'][:, 0], c['ewma'][:, 0]),
                   v2_rand=paired(c['v2'][:, 0], c['random'][:, 0]), well_rand=paired(c['wellness'][:, 0], c['random'][:, 0]),
                   ill_v2_ewma=paired(c['v2'][:, 2], c['ewma'][:, 2]), inj_v2_ewma=paired(c['v2'][:, 1], c['ewma'][:, 1]),
                   v2noW_ewma=paired(c['v2_noW'][:, 0], c['ewma'][:, 0]),
                   auc={e: est(r[e]['auc']) for e in r}, auc_ill={e: est(r[e]['auc_ill']) for e in r},
                   auc_inj={e: est(r[e]['auc_inj']) for e in r},
                   aucd_v2_coupled=paired(r['v2']['auc'], r['ra_coupled']['auc']))
    print(tag, 'best', best, 'none dl %.2f ill %.2f inj %.2f' % (lo[tag]['none_dl']['mean'], lo[tag]['none_ill']['mean'], lo[tag]['none_inj']['mean']))
    for k in ['v2_best', 'v2_ewma', 'v2_rand', 'well_rand', 'ill_v2_ewma', 'inj_v2_ewma', 'v2noW_ewma', 'aucd_v2_coupled']:
        v = lo[tag][k]; print('  ', k, '%.3f (%.3f to %.3f) p=%.4g' % (v['mean'], v['lo'], v['hi'], v['p']))
    print('   auc_ill v2 %.3f ewma %.3f coupled %.3f wellness %.3f' % tuple(lo[tag]['auc_ill'][e]['mean'] for e in ['v2', 'ewma', 'ra_coupled', 'wellness']))
    print('   auc v2 %.3f coupled %.3f' % (lo[tag]['auc']['v2']['mean'], lo[tag]['auc']['ra_coupled']['mean']))
    print('   dl', {a: round(lo[tag]['dl'][a]['mean'], 2) for a in lo[tag]['dl']})
out['lifeoff'] = lo
for par in ['prodrome', 'prog']:
    print(par, [round(c, 3) for c in out[par]['cuts']])
    for k in ['Q1', 'Q2', 'Q3', 'Q4']:
        v = out[par][k]; d = v['dl_v2_ewma']; print('  ', k, 'dl %.2f (%.2f to %.2f)' % (d['mean'], d['lo'], d['hi']), 'aucill v2 %.3f ewma %.3f' % (v['aucill_v2']['mean'], v['aucill_ewma']['mean']))
    b = out[par]['below_p10']; print('   <p10', b['cut'], b['n'], '%.2f (%.2f to %.2f)' % (b['dl_v2_ewma']['mean'], b['dl_v2_ewma']['lo'], b['dl_v2_ewma']['hi']))
def conv(o):
    if isinstance(o, dict): return {k: conv(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [conv(v) for v in o]
    if isinstance(o, (np.floating, np.integer)): return o.item()
    return o
json.dump(conv(out), open('summary_circ.json', 'w'), indent=1)
