import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np, pickle
from style import *
fig, bx = plt.subplots(figsize=(6.2, 4.0))
D = pickle.load(open('../sim/res_dose.pkl', 'rb')); base = D['none']
for a in ['v1', 'ra_coupled', 'ewma', 'wellness', 'v2', 'random']:
    W = np.array([(base[:, 3] - D[(a, r)][:, 3]) for r in [0.05, 0.1, 0.2, 0.3]]); A = np.array([(base[:, 0] - D[(a, r)][:, 0]) for r in [0.05, 0.1, 0.2, 0.3]])
    n = W.shape[1]; wm, am = W.mean(1), A.mean(1); ws, as_ = 1.96 * W.std(1, ddof=1) / np.sqrt(n), 1.96 * A.std(1, ddof=1) / np.sqrt(n)
    ls = (0, (3, 2)) if a == 'random' else '-'
    bx.errorbar(wm, am, xerr=ws, yerr=as_, fmt='o', ls=ls, lw=1.2, ms=4.5, color=COL[a], mec='black', mew=0.4, elinewidth=0.7, label=NAME[a])
bx.set_xlabel('Training load withheld (kAU per athlete per season)', fontsize=9); bx.set_ylabel('Days lost averted per 100 athlete-days', fontsize=9)
bx.tick_params(labelsize=8)
bx.set_xlim(0, 6.2); bx.set_ylim(0, 6.5)
bx.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0), ncol=1, fontsize=8)
fig.savefig('fig6.png', bbox_inches='tight'); print('ok')
