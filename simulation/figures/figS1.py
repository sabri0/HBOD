import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np
from style import *
C = np.load('../sim/calib_out.npz')
S = C['S2']; acc = np.nanmax(C['I2'], 1) < 2; Z = C['Z']; SD = C['SD']
lab = ['Weekly true load (AU)', 'Injury incidence\n(per 1000 athlete-days)', 'Illness share of\ntime-loss onsets', 'Unavailability\nprevalence', 'Report compliance']
sc = [1, 1, 1, 100, 100]; lab[3] = 'Unavailability\nprevalence (%)'; lab[4] = 'Report compliance (%)'
fig, axs = plt.subplots(1, 5, figsize=(7.1, 1.9), gridspec_kw=dict(wspace=0.35))
for j, ax in enumerate(axs):
    x = S[:, j] * sc[j]; ok = ~np.isnan(x)
    lo, hi = np.percentile(x[ok], [0.5, 99.5]); bins = np.linspace(lo, hi, 40)
    ax.hist(x[ok], bins=bins, density=True, histtype='step', color='black', lw=0.7, label='Prior predictive')
    ax.hist(x[acc & ok], bins=bins, density=True, color='#0072B2', alpha=0.55, lw=0, label='Retained (implausibility below 2)')
    ax.axvspan((Z[j] - SD[j]) * sc[j], min((Z[j] + SD[j]) * sc[j], 100 if j == 4 else 1e9), color='#E69F00', alpha=0.18, lw=0, label='Target mean plus or minus 1 SD')
    ax.axvline(Z[j] * sc[j], color='#D55E00', lw=1.0, label='Target mean')
    ax.set_xlabel(lab[j], fontsize=7); ax.set_yticks([])
    ax.spines['left'].set_visible(False)
    panel(ax, 'abcde'[j], x=-0.05, y=1.02)
axs[0].set_ylabel('Density')
h, l = axs[0].get_legend_handles_labels()
fig.legend(h, l, loc='upper center', bbox_to_anchor=(0.5, -0.12), ncol=4)
fig.savefig('figS1.png', bbox_inches='tight'); print('ok')
