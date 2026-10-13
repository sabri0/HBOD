"""Sensitivity analysis: life stress no longer raises illness exposure (structural link removed)."""
import numpy as np, pickle, os, time, sys
import experiments as ex, hbodsim as hs
X = np.load('eval_X.npy')[:200]; CH = 50
os.makedirs('res_lifeoff', exist_ok=True)
for flag, tag in [(0.0, 'off'), (0.3, 'on')]:
    hs.LIFE_ILL = flag
    for c in range(0, 200, CH):
        f = f'res_lifeoff/{tag}_{c:04d}.pkl'
        if os.path.exists(f): continue
        t0 = time.time(); seed = 960000 + c
        res, thr, base, o = ex.open_loop(X[c:c+CH], seed)
        cl, real = ex.closed_loop(X[c:c+CH], seed, thr)
        cl['none'] = base
        pickle.dump(dict(res=res, cl=cl, real=real), open(f, 'wb'))
        print(tag, c, round(time.time() - t0, 1), flush=True)
