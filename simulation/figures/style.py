import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.family': 'Liberation Sans', 'font.size': 8, 'axes.linewidth': 0.6,
    'xtick.major.width': 0.6, 'ytick.major.width': 0.6, 'xtick.major.size': 2.5, 'ytick.major.size': 2.5,
    'axes.spines.top': False, 'axes.spines.right': False, 'legend.frameon': False, 'savefig.dpi': 600,
    'axes.labelsize': 8, 'xtick.labelsize': 7, 'ytick.labelsize': 7, 'legend.fontsize': 7,
    'text.color': 'black', 'axes.labelcolor': 'black', 'xtick.color': 'black', 'ytick.color': 'black'})
NAME = {'v1': 'Rule-based prototype', 'ra_coupled': 'ACWR, coupled', 'ra_uncoupled': 'ACWR, uncoupled',
        'ewma': 'ACWR, EWMA', 'week_change': 'Week-to-week change', 'tsb': 'Training stress balance',
        'wellness': 'Wellness z score', 'v2': 'HBOD', 'v2_noW': 'HBOD without wellness',
        'random': 'Random alerts (placebo)', 'none': 'No alerts'}
# Okabe-Ito based palette
COL = {'v1': '#999999', 'ra_coupled': '#E69F00', 'ra_uncoupled': '#F0C46B', 'ewma': '#D55E00',
       'week_change': '#CC79A7', 'tsb': '#56B4E9', 'wellness': '#009E73', 'v2': '#0072B2',
       'v2_noW': '#7FB8DA', 'random': '#000000', 'none': '#BBBBBB'}
ORDER = ['v1', 'ra_coupled', 'ra_uncoupled', 'ewma', 'week_change', 'tsb', 'wellness', 'v2_noW', 'v2']
def panel(ax, letter, x=-0.16, y=1.04):
    ax.text(x, y, letter, transform=ax.transAxes, fontsize=10, fontweight='bold', va='bottom', ha='left')
