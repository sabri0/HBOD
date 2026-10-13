"""Two-wave history matching (implausibility, 3-sigma rule) of the data-generating model."""
import numpy as np, warnings, json, time
warnings.filterwarnings('ignore')
from scipy.stats import qmc
import hbodsim as hs
from engines import NullBank
from calib_summ import summaries, NAMES
Z  = np.array([2900.0, 6.3, 0.53, 0.15, 0.84])   # targets
SD = np.array([600.0, 1.5, 0.10, 0.03, 0.21])    # observational/between-team uncertainty
lo0 = np.array([hs.PRIORS[k][0] for k in hs.PNAMES]); hi0 = np.array([hs.PRIORS[k][1] for k in hs.PNAMES])
D = len(lo0)

def run(X, seed, chunk=500):
    S = []
    for i in range(0, len(X), chunk):
        o = hs.simulate(X[i:i+chunk], seed=seed + i, engines=NullBank()); S.append(summaries(o))
    return np.vstack(S)

def sobol(n, lo, hi, seed):
    u = qmc.Sobol(D, scramble=True, seed=seed).random(n)
    return lo + u * (hi - lo)

t0 = time.time()
# pilot: stochastic (ensemble) variance of each summary, two seeds on the same worlds
Xp = sobol(1024, lo0, hi0, 1)
S1 = run(Xp, 1000); S2 = run(Xp, 2000)
Vens = np.nanmedian((S1 - S2) ** 2 / 2, 0)
print('Vens sd', np.sqrt(Vens), round(time.time() - t0))
def implaus(S):
    return np.abs(S - Z) / np.sqrt(SD ** 2 + Vens)
log = {}
# wave 1
X1 = sobol(2 ** 15, lo0, hi0, 2); S = run(X1, 10000); I = implaus(S)
acc1 = np.nanmax(I, 1) < 3
print('wave1 accepted', acc1.sum(), 'of', len(X1), round(time.time() - t0))
lo1 = X1[acc1].min(0); hi1 = X1[acc1].max(0)
# wave 2 inside the non-implausible bounding box
X2 = sobol(2 ** 15, lo1, hi1, 3); S2w = run(X2, 50000); I2 = implaus(S2w)
acc2 = np.nanmax(I2, 1) < 3
print('wave2 accepted', acc2.sum(), 'of', len(X2), round(time.time() - t0))
np.savez('calib_out.npz', X1=X1, S1=S, I1=I, acc1=acc1, X2=X2, S2=S2w, I2=I2, acc2=acc2,
         lo1=lo1, hi1=hi1, Vens=Vens, Z=Z, SD=SD)
for j, k in enumerate(hs.PNAMES):
    a = X2[acc2, j]
    print(f"{k:10s} prior [{lo0[j]:.2f},{hi0[j]:.2f}]  NROY box [{lo1[j]:.2f},{hi1[j]:.2f}]  post median {np.median(a):.2f} IQR {np.percentile(a,25):.2f}-{np.percentile(a,75):.2f}")
for i, n in enumerate(NAMES):
    print(n, 'target', Z[i], 'accepted median', np.round(np.median(S2w[acc2, i]), 3), 'IQR', np.round(np.percentile(S2w[acc2, i], [25, 75]), 3))
