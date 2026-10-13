import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np
from style import *
from analyze import load_main
res, cl, real, X = load_main()
fig, bx = plt.subplots(figsize=(6.2, 3.9))
for e in ORDER:
    s = res[e]['sens_def'] * 100; f = res[e]['fa_def']
    ms, mf = np.nanmean(s), np.nanmean(f)
    cs = 1.96 * np.nanstd(s, ddof=1) / np.sqrt(np.sum(~np.isnan(s))); cf = 1.96 * np.nanstd(f, ddof=1) / np.sqrt(len(f))
    op = e in ('v2_noW', 'ra_uncoupled')
    bx.errorbar(mf, ms, xerr=cf, yerr=cs, fmt='o', ms=6.5, color=COL[e], mfc='white' if op else COL[e], mec=COL[e] if op else 'black', mew=1.4 if op else 0.5, elinewidth=0.8, label=NAME[e])
bx.set_xscale('log'); bx.set_xticks([0.5, 1, 2, 5, 10, 20]); bx.set_xticklabels(['0.5', '1', '2', '5', '10', '20'])
bx.set_xlim(0.4, 25); bx.set_ylim(0, 100)
bx.set_xlabel('False alerts per athlete-month (log scale)', fontsize=9)
bx.set_ylabel('Onsets preceded by an alert within 7 days (%)', fontsize=9)
bx.tick_params(labelsize=8)
bx.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0), ncol=1, handletextpad=0.3, fontsize=8)
fig.savefig('fig4.png', bbox_inches='tight'); print('ok')
