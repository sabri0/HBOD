import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np
from style import *
import hbodsim as hs
from analyze import load_main, est
res, cl, real, X = load_main()
fig, (b1, b2) = plt.subplots(2, 1, figsize=(5.6, 4.6), sharex=True, gridspec_kw=dict(hspace=0.12))
jp = hs.PNAMES.index('phi'); q = np.quantile(X[:, jp], [0, .25, .5, .75, 1]); xm = np.arange(4)
for e, off in [('ra_coupled', -0.21), ('ewma', -0.07), ('wellness', 0.07), ('v2', 0.21)]:
    ss = [est(res[e]['auc_inj'][(X[:, jp] >= q[k]) & (X[:, jp] <= q[k + 1])]) for k in range(4)]
    m = np.array([s['mean'] for s in ss]); lo = np.array([s['lo'] for s in ss]); hi = np.array([s['hi'] for s in ss])
    b1.errorbar(xm + off, m, yerr=[m - lo, hi - m], fmt='o-', ms=4, lw=1.0, color=COL[e], mec='black', mew=0.3, elinewidth=0.8, label=NAME[e])
b1.axhline(0.5, color='black', lw=0.5, ls=(0, (2, 2))); b1.set_ylabel('Injury AUROC', fontsize=9); b1.set_ylim(0.45, 0.8)
b1.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0), fontsize=8)
ss = [est(cl['v2'][(X[:, jp] >= q[k]) & (X[:, jp] <= q[k + 1]), 0] - cl['ewma'][(X[:, jp] >= q[k]) & (X[:, jp] <= q[k + 1]), 0]) for k in range(4)]
m = np.array([s['mean'] for s in ss]); lo = np.array([s['lo'] for s in ss]); hi = np.array([s['hi'] for s in ss])
b2.errorbar(xm, m, yerr=[m - lo, hi - m], fmt='s-', ms=4, lw=1.0, color=COL['v2'], mec='black', mew=0.3, elinewidth=0.8)
b2.axhline(0, color='black', lw=0.5, ls=(0, (2, 2))); b2.set_ylabel('Days lost difference,\nHBOD minus ACWR, EWMA', fontsize=8.5); b2.set_ylim(-1.6, 0.5)
b2.set_xticks(xm); b2.set_xticklabels(['Q1\nfatigue-driven', 'Q2', 'Q3', 'Q4\nspike-driven']); b2.set_xlabel('Quartile of injury mechanism (φ)', fontsize=9)
for a in (b1, b2): a.tick_params(labelsize=8)
panel(b1, 'a', x=-0.17, y=1.02); panel(b2, 'b', x=-0.17, y=1.02)
fig.savefig('fig7.png', bbox_inches='tight'); print('ok')
