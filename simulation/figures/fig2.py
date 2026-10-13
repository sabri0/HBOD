import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np, warnings; warnings.filterwarnings('ignore')
from style import *
import hbodsim as hs
X = np.load('../sim/eval_X.npy')
best = None
for w in range(40):
    o = hs.simulate(X[w:w+1], seed=990000 + w)
    inj = o['onset_inj'][:, 42:].sum(1); ill = o['onset_ill'][:, 42:].sum(1)
    early = o['healthy'][:, :70].all(1)
    missf = (np.isnan(o['rep_load']) & o['healthy']).sum(1) / o['healthy'].sum(1)
    c = np.where((inj >= 1) & (ill >= 1) & (inj + ill <= 3) & early & (missf > 0.12))[0]
    if len(c): best = (w, c[0], o); break
w, i, o = best; print('world', w, 'athlete', i)
b = o['bank']; T = hs.T_DAYS; t = np.arange(T)
fig, axs = plt.subplots(4, 1, figsize=(7.1, 6.4), sharex=True, gridspec_kw=dict(hspace=0.12, height_ratios=[1.1, 1, 1, 1]))
def shade(ax):
    st = ~o['healthy'][i]
    inj_on = np.where(o['onset_inj'][i])[0]; ill_on = np.where(o['onset_ill'][i])[0]
    k = 0
    while k < T:
        if st[k]:
            j = k
            while j < T and st[j]: j += 1
            kind = 'inj' if any(abs(k - x) <= 1 for x in inj_on) else 'ill'
            ax.axvspan(k - 0.5, j - 0.5, color='#D55E00' if kind == 'inj' else '#009E73', alpha=0.13, lw=0)
            k = j
        else: k += 1
ax = axs[0]; shade(ax)
ax.bar(t, o['w_true'][i], width=0.85, color='#9a9a9a', lw=0, label='True session load')
ax.plot(t, o['plan'][i], color='black', lw=0.7, label='Planned load')
miss = np.isnan(o['rep_load'][i]) & o['healthy'][i]
ax.plot(t[miss], np.full(miss.sum(), -60), '|', color='black', ms=4, mew=0.7, label='Missing report')
ax.set_ylabel('sRPE (AU)'); ax.set_ylim(-110, None); panel(ax, 'a', x=-0.1, y=0.98)
ax.legend(loc='upper left', bbox_to_anchor=(1.01, 1.0))
ax = axs[1]; shade(ax)
zt = o['zF'][i].astype(float)
dd = b.dd[i]; m = np.nanmean(dd[42:]); s = np.nanstd(dd[42:])
ax.plot(t, zt, color='black', lw=1.0, label='True latent fatigue')
ax.plot(t, (dd - m) / s, color='#0072B2', lw=1.0, label='HBOD fatigue minus fitness')
ax.set_ylabel('z score'); panel(ax, 'b', x=-0.1, y=0.98)
ax.legend(loc='upper left', bbox_to_anchor=(1.01, 1.0))
ax = axs[2]; shade(ax)
p = 1 / (1 + np.exp(-b.score['v2'][i].astype(float)))
ax.plot(t, p, color='#0072B2', lw=1.0, label='HBOD posterior probability')
ax.axhline(0.8, color='#0072B2', lw=0.7, ls=(0, (3, 2)), label='Alert threshold 0.80')
ax.set_ylim(0, 1.02); ax.set_ylabel('Probability'); panel(ax, 'c', x=-0.1, y=0.98)
ax.legend(loc='upper left', bbox_to_anchor=(1.01, 1.0))
ax = axs[3]; shade(ax)
ax.plot(t, b.score['ewma'][i], color='#D55E00', lw=1.0, label='ACWR, EWMA')
ax.plot(t, b.score['ra_coupled'][i], color='#E69F00', lw=0.8, label='ACWR, coupled')
ax.axhline(1.3, color='black', lw=0.7, ls=(0, (3, 2)), label='Ratio threshold 1.30')
ax.set_ylabel('Ratio'); ax.set_xlabel('Day of season'); panel(ax, 'd', x=-0.1, y=0.98)
from matplotlib.patches import Patch
h, l = ax.get_legend_handles_labels()
h += [Patch(color='#D55E00', alpha=0.25, lw=0), Patch(color='#009E73', alpha=0.25, lw=0)]
l += ['Unavailable, injury', 'Unavailable, illness']
ax.legend(h, l, loc='upper left', bbox_to_anchor=(1.01, 1.04))
ax.set_xlim(0, T)
for a in axs: a.axvline(42, color='black', lw=0.5, ls=(0, (1, 2)))
fig.savefig('fig2.png', bbox_inches='tight'); print('ok')
