import numpy as np, pickle, os, time
from SALib.sample import sobol as ssob
import experiments as ex, hbodsim as hs
C = np.load('calib_out.npz')
names = list(hs.PNAMES) + ['dummy']
lo = list(C['lo1']) + [0.0]; hi = list(C['hi1']) + [1.0]
prob = dict(num_vars=len(names), names=names, bounds=[[l, h] for l, h in zip(lo, hi)])
Xs = ssob.sample(prob, 256, calc_second_order=False, seed=4040)
np.save('sobol_X.npy', Xs); os.makedirs('res_sob', exist_ok=True)
CH = 96
for c in range(0, len(Xs), CH):
    f = f'res_sob/chunk_{c:05d}.pkl'
    if os.path.exists(f): continue
    X = Xs[c:c+CH, :-1]; seed = 500000 + c; t0 = time.time()
    res, thr, base, o = ex.open_loop(X, seed, engines=['ra_coupled', 'ewma', 'v2'])
    cl, real = ex.closed_loop(X, seed, thr, arms=['ewma', 'v2'])
    pickle.dump(dict(auc_v2=res['v2']['auc'], auc_ewma=res['ewma']['auc'], auc_rac=res['ra_coupled']['auc'],
                     dl_v2=cl['v2'][:, 0], dl_ewma=cl['ewma'][:, 0], dl_rand=cl['random'][:, 0]), open(f, 'wb'))
    print(c, len(Xs), round(time.time() - t0, 1), flush=True)
