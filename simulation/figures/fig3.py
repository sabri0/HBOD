import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np, json
from style import *
from analyze import load_main
from scipy.stats import gaussian_kde
res, cl, real, X = load_main()
S = json.load(open('../sim/summary_main.json'))
fig = plt.figure(figsize=(7.1, 4.3))
gs = fig.add_gridspec(1, 2, width_ratios=[1.35, 1], wspace=0.16)
ax = fig.add_subplot(gs[0]); bx = fig.add_subplot(gs[1], sharey=ax)
rng = np.random.default_rng(1)
for i, e in enumerate(ORDER):
    a = res[e]['auc']; a = a[~np.isnan(a)]
    k = gaussian_kde(a); xs = np.linspace(a.min(), a.max(), 200); d = k(xs); d = d / d.max() * 0.38
    ax.fill_between(xs, i + 0.08, i + 0.08 + d, color=COL[e], alpha=0.55, lw=0)
    ax.scatter(a, i - 0.22 + rng.uniform(-0.09, 0.09, len(a)), s=1.2, color=COL[e], alpha=0.35, lw=0)
    q1, med, q3 = np.percentile(a, [25, 50, 75])
    ax.plot([q1, q3], [i, i], color='black', lw=2.2, solid_capstyle='butt')
    ax.plot([med], [i], 'o', ms=3.2, mfc='white', mec='black', mew=0.8)
ax.axvline(0.5, color='black', lw=0.6, ls=(0, (2, 2)))
ax.set_yticks(range(len(ORDER))); ax.set_yticklabels([NAME[e] for e in ORDER])
ax.set_xlabel('AUROC per simulated world, any onset')
ax.set_xlim(0.25, 0.85); ax.set_ylim(-0.6, len(ORDER) - 0.3)
panel(ax, 'a', x=-0.42)
# b: injury vs illness means with CI
for i, e in enumerate(ORDER):
    for k, (key, mk, off) in enumerate([('auc_inj', 's', 0.14), ('auc_ill', '^', -0.14)]):
        s = S['open'][e][key]
        bx.errorbar(s['mean'], i + off, xerr=[[s['mean'] - s['lo']], [s['hi'] - s['mean']]], fmt=mk, ms=3.6,
                    color=COL[e], mec='black', mew=0.4, elinewidth=0.9, capsize=0)
bx.axvline(0.5, color='black', lw=0.6, ls=(0, (2, 2)))
bx.set_xlabel('Mean AUROC (95% CI) by onset type')
bx.set_xlim(0.45, 0.66)
plt.setp(bx.get_yticklabels(), visible=False); bx.tick_params(axis='y', length=0)
from matplotlib.lines import Line2D
h = [Line2D([], [], marker='s', ls='', color='grey', mec='black', mew=0.4, ms=4, label='Injury onsets'),
     Line2D([], [], marker='^', ls='', color='grey', mec='black', mew=0.4, ms=4, label='Illness onsets')]
bx.legend(handles=h, loc='upper center', bbox_to_anchor=(0.5, -0.13), ncol=2)
panel(bx, 'b', x=-0.05)
fig.savefig('fig3.png', bbox_inches='tight'); print('ok')
