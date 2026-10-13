import sys; sys.path.insert(0, '../sim'); sys.path.insert(0, '.')
import numpy as np, json
from style import *
SB = json.load(open('../sim/summary_sobol_cluster.json'))['binned_cluster']
PN = {'W0': 'Planned weekly load', 'shock_p': 'Shock probability', 'tau_g': 'Fitness time constant', 'tau_h': 'Fatigue time constant',
      'tau_k': 'Fatigue-gain time constant', 'k_ratio': 'Fatigue to fitness gain', 'a_inj': 'Injury baseline', 'beta': 'Injury signal effect',
      'phi': 'Injury mechanism (φ)', 'beta_g': 'Fitness protection', 'd_inj': 'Injury duration', 'b_match': 'Match effect',
      'a_ill': 'Illness baseline', 'beta_ill': 'Illness fatigue effect', 'prog': 'Illness progression', 'prodrome': 'Prodrome strength',
      'd_ill': 'Illness duration', 'lam_w': 'Wellness sensitivity', 's_under': 'Under-reporter share', 'rho_under': 'Under-reporting shrinkage',
      's_comp': 'Compressor share', 's_care': 'Careless share', 'm0': 'Baseline missing rate', 'nu': 'MNAR strength', 'dummy': 'Dummy input'}
fig, cx = plt.subplots(figsize=(7.1, 3.9))
outs = [('auc_diff', 'AUROC difference, HBOD minus ACWR, EWMA', '#0072B2'), ('dl_diff', 'Days lost difference, HBOD minus ACWR, EWMA', '#D55E00')]
top = sorted([n for n in SB['auc_diff'] if n != 'dummy'], key=lambda n: -(SB['auc_diff'][n]['S1'] + SB['dl_diff'][n]['S1']))[:10] + ['dummy']
xpos = np.arange(len(top))
for k, (o, lab, col) in enumerate(outs):
    v = np.array([SB[o][n]['S1'] for n in top]); lo = np.array([SB[o][n]['lo'] for n in top]); hi = np.array([SB[o][n]['hi'] for n in top])
    cx.bar(xpos + (k - 0.5) * 0.38, v, width=0.36, color=col, alpha=0.8, label=lab, lw=0)
    cx.errorbar(xpos + (k - 0.5) * 0.38, v, yerr=[v - lo, hi - v], fmt='none', ecolor='black', elinewidth=0.6, capsize=1.5)
    cx.axhline(SB[o]['dummy']['hi'], color=col, lw=0.8, ls=(0, (3, 2)))
cx.set_xticks(xpos); cx.set_xticklabels([PN[n] for n in top], rotation=35, ha='right', fontsize=8)
cx.set_ylabel('First-order index (binned)', fontsize=9); cx.set_ylim(0, 0.40); cx.tick_params(axis='y', labelsize=8)
cx.legend(loc='lower center', bbox_to_anchor=(0.5, 1.02), ncol=2, fontsize=8)
fig.savefig('fig8.png', bbox_inches='tight'); print('ok')
