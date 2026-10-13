import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np
from style import *
from analyze import load_main, paired
res, cl, real, X = load_main()
fig = plt.figure(figsize=(7.1, 3.4))
gs = fig.add_gridspec(1, 3, wspace=0.12)
arms = ['v1', 'ra_coupled', 'ra_uncoupled', 'ewma', 'tsb', 'wellness', 'v2_noW', 'v2']
labs = ['Days lost\n(per 100 athlete-days)', 'Injuries\n(per 1000 athlete-days)', 'Illnesses\n(per 1000 athlete-days)']
axs = []
for j in range(3):
    ax = fig.add_subplot(gs[j], sharey=axs[0] if axs else None); axs.append(ax)
    for i, a in enumerate(arms):
        p = paired(cl[a][:, j], cl['random'][:, j])
        op = a in ('v2_noW', 'ra_uncoupled')
        ax.errorbar(p['mean'], i, xerr=[[p['mean'] - p['lo']], [p['hi'] - p['mean']]], fmt='o', ms=5, color=COL[a],
                    mfc='white' if op else COL[a], mec=COL[a] if op else 'black', mew=1.2 if op else 0.4, elinewidth=1.1)
    ax.axvline(0, color='black', lw=0.6, ls=(0, (2, 2)))
    ax.set_xlabel(labs[j], fontsize=8); ax.tick_params(labelsize=7.5)
    if j == 0:
        ax.set_yticks(range(len(arms))); ax.set_yticklabels([NAME[a] for a in arms], fontsize=8)
    else:
        plt.setp(ax.get_yticklabels(), visible=False); ax.tick_params(axis='y', length=0)
axs[0].set_ylim(-0.6, len(arms) - 0.4)
fig.text(0.5, -0.08, 'Paired difference versus random alerts (mean, 95% CI)', ha='center', fontsize=8.5)
fig.savefig('fig5.png', bbox_inches='tight'); print('ok')
