import sys; sys.path.insert(0,'../sim')
import numpy as np, hbodsim as hs
P={k:np.array([v]) for k,v in dict(tau_g=40.,tau_h=12.,tau_k=5.,W0=2800.,k_ratio=2.).items()}
w=400.; T=3000; pl=np.full((1,T),w)
hs_T=hs.T_DAYS; hs.EVAL_START=0
ag,ah,ak=np.exp(-1/40),np.exp(-1/12),np.exp(-1/5); k1=1e-3
k3=2*k1/((2800/7)/(1-ak))
g=h=k2=0.
for t in range(1,T): g=g*ag+k1*w; k2=k2*ak+k3*w; h=h*ah+k2*w
print('fitness numeric',g,'analytic',k1*w/(1-ag))
print('fatigue numeric',h,'analytic',k3*w*w/((1-ak)*(1-ah)))
print('fatigue/fitness gain ratio at typical load (k2/k1):',(k3*w/(1-ak))/k1)
