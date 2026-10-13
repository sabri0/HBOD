import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np
from style import *
from analyze import load_main
res, cl, real, X = load_main()
pt0 = np.linspace(0.005, 0.10, 20); pt = np.linspace(0.01, 0.25, 97)
fig, ax = plt.subplots(figsize=(6.2, 3.8))
sel = ['v1', 'ra_coupled', 'ewma', 'week_change', 'tsb', 'wellness', 'v2']
for e in sel:
    n0 = res[e]['nb_def'] * 1000; w0 = pt0 / (1 - pt0)
    b = (n0[:, 0] - n0[:, -1]) / (w0[-1] - w0[0]); a = n0[:, 0] + b * w0[0]
    nb = a[:, None] - b[:, None] * (pt / (1 - pt))[None, :]   # exact: net benefit is linear in pt/(1-pt)
    m = np.nanmean(nb, 0); se = np.nanstd(nb, 0, ddof=1) / np.sqrt(nb.shape[0])
    ax.plot(pt * 100, m, color=COL[e], lw=1.4, label=NAME[e])
    ax.fill_between(pt * 100, m - 1.96 * se, m + 1.96 * se, color=COL[e], alpha=0.18, lw=0)
prev = res['v2']['prev'][:, None]
nball = (prev - (1 - prev) * pt / (1 - pt)) * 1000
ax.plot(pt * 100, np.nanmean(nball, 0), color='black', lw=1.0, ls=(0, (4, 2)), label='Alert on every day')
ax.axhline(0, color='black', lw=0.8, label='Never alert')
ax.set_ylim(-60, 60); ax.set_xlim(1, 25)
ax.set_xlabel('Threshold probability (%)', fontsize=9); ax.set_ylabel('Net benefit per 1000 athlete-days', fontsize=9)
ax.tick_params(labelsize=8)
ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0), ncol=1, fontsize=8)
fig.savefig('figS2.png', bbox_inches='tight'); print('ok')
