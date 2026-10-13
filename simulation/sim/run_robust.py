import numpy as np, pickle, os, time
import experiments as ex, hbodsim as hs
C = np.load('calib_out.npz'); pool = C['X2'][np.nanmax(C['I2'], 1) < 2]
ju = hs.PNAMES.index('s_under'); jn = hs.PNAMES.index('nu')
SU = [0, 0.1, 0.2, 0.3, 0.4]; NU = [0, 0.25, 0.5, 0.75, 1.0]
rng = np.random.default_rng(3030); os.makedirs('res_rob', exist_ok=True)
arms = ['ra_coupled', 'ra_uncoupled', 'ewma', 'v2']
for a, su in enumerate(SU):
    for b, nu in enumerate(NU):
        f = f'res_rob/cell_{a}{b}.pkl'
        if os.path.exists(f): continue
        X = pool[rng.choice(len(pool), 40, replace=False)].copy(); X[:, ju] = su; X[:, jn] = nu
        seed = 700000 + 100 * a + b; t0 = time.time()
        res, thr, base, o = ex.open_loop(X, seed)
        cl, real = ex.closed_loop(X, seed, thr, arms=arms)
        pickle.dump(dict(res=res, cl=cl, su=su, nu=nu), open(f, 'wb'))
        print(a, b, round(time.time() - t0, 1), flush=True)
