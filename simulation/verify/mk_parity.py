import sys; sys.path.insert(0,'../sim')
import numpy as np, warnings, json, datetime as dt
warnings.filterwarnings('ignore')
import hbodsim as hs
X=hs.sample_priors(4,np.random.default_rng(77))
o=hs.simulate(X,seed=123,return_wellness=True)
rep=o['rep_load']; well=o['well']; N,T=rep.shape
d0=dt.date(2025,7,1)
rows=['Player,Timestamp,Session duration (min),Session intensity (CR-10),Fatigue,Stress,Muscle soreness,Sleep']
for i in range(N):
    for t in range(T):
        if np.isnan(rep[i,t]): continue
        L=rep[i,t]; w=well[i,t]
        ws=','.join(str(int(v)) for v in w) if not np.isnan(w).any() else ',,,'
        rows.append(f"P{i},{(d0+dt.timedelta(t)).isoformat()} 20:00:00,{L if L>0 else 0},{1 if L>0 else 0},{ws}")
open('parity.csv','w').write('\n'.join(rows))
v1=o['bank'].score['v1']
np.save('py_v1.npy',np.floor(np.nan_to_num(v1,nan=-1)))
print(N,T,len(rows)-1)
