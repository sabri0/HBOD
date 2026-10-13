import numpy as np, pickle, os, sys, time
import experiments as ex
C = np.load('calib_out.npz')
pool = C['X2'][np.nanmax(C['I2'], 1) < 2]
rng = np.random.default_rng(2026)
idx = rng.choice(len(pool), 1000, replace=len(pool) < 1000)
X = pool[idx]; np.save('eval_X.npy', X)
os.makedirs('res_main', exist_ok=True)
CH = 50
for c in range(0, 1000, CH):
    f = f'res_main/chunk_{c:04d}.pkl'
    if os.path.exists(f): continue
    t0 = time.time(); seed = 900000 + c
    res, thr, base, o = ex.open_loop(X[c:c+CH], seed)
    cl, real = ex.closed_loop(X[c:c+CH], seed, thr)
    cl['none'] = base
    pickle.dump(dict(res=res, cl=cl, real=real, X=X[c:c+CH]), open(f, 'wb'))
    print(c, round(time.time() - t0, 1), flush=True)
