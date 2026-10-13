import numpy as np, pickle, glob, json
from scipy import stats
SU = [0, 0.1, 0.2, 0.3, 0.4]; NU = [0, 0.25, 0.5, 0.75, 1.0]
D = np.zeros((5, 5)); Dlo = np.zeros((5, 5)); Dhi = np.zeros((5, 5)); A = np.zeros((5, 5)); R = np.zeros((5,5)); AW=np.zeros((5,5))
for a in range(5):
    for b in range(5):
        r = pickle.load(open(f'../sim/res_rob/cell_{a}{b}.pkl', 'rb'))
        cl = r['cl']; best = min(['ra_coupled', 'ra_uncoupled', 'ewma'], key=lambda k: cl[k][:, 0].mean())
        d = cl['v2'][:, 0] - cl[best][:, 0]; m = d.mean(); h = stats.t.ppf(.975, len(d) - 1) * d.std(ddof=1) / np.sqrt(len(d))
        D[a, b] = m; Dlo[a, b] = m - h; Dhi[a, b] = m + h
        R[a, b] = (cl['v2'][:, 0] - cl['random'][:, 0]).mean()
        A[a, b] = np.nanmean(r['res']['v2']['auc'] - r['res']['ra_coupled']['auc'])
        AW[a,b] = np.nanmean(r['res']['wellness']['auc'])
np.set_printoptions(precision=3, suppress=True)
print('days lost v2 - best ACWR per cell (rows s_under, cols nu)\n', D)
print('cells with negative sign', (D < 0).sum(), 'cells with upper CI < 0', (Dhi < 0).sum())
print('v2 - random\n', R); print('AUC v2 - coupled ACWR\n', A); print('wellness AUC\n',AW)
json.dump(dict(D=D.tolist(), Dlo=Dlo.tolist(), Dhi=Dhi.tolist(), R=R.tolist(), A=A.tolist(), SU=SU, NU=NU), open('../sim/summary_rob.json', 'w'))
