"""Verification of the vectorised v2 filter against a scalar reference loop and the DARE."""
import sys; sys.path.insert(0,'../sim')
import numpy as np, warnings; warnings.filterwarnings('ignore')
from scipy.stats import norm
from scipy.linalg import solve_discrete_are
import hbodsim as hs, engines as en
rec={}
class RecBank(en.EngineBank):
    def _kalman(self, t, ukau, imputed, y, use_obs, tag):
        if use_obs: rec[t]=(ukau.copy(), imputed.copy(), y.copy())
        return super()._kalman(t, ukau, imputed, y, use_obs, tag)
X=hs.sample_priors(2,np.random.default_rng(9)); W=2; N=W*hs.A_PER_SQUAD
widx=np.repeat(np.arange(W),hs.A_PER_SQUAD)
b=RecBank(N,hs.T_DAYS,widx,W); o=hs.simulate(X,seed=5,engines=b)
# scalar reference
def ref(i):
    ag,ah,rs=np.exp(-1/42),np.exp(-1/7),0.8; q=np.array([.005**2,.03**2,.3**2])
    F=np.diag([ag,ah,rs]); B=np.array([1-ag,1-ah,0])
    x=np.zeros(3); P=np.diag([.05,.05,.3**2/(1-.64)]); th=np.array([3.5,1.,.3]); Pr=np.diag([1.,4.,4.]); R=.5
    dd=[]; ss=[]; sc=np.full(hs.T_DAYS,np.nan)
    for t in range(hs.T_DAYS):
        u,imp,y=rec[t]; u=u[i]; imp=imp[i]; y=y[i]
        x=F@x+u*B; P=F@P@F.T+np.diag(q*np.array([4. if imp else 1.,4. if imp else 1.,1.]))
        if not np.isnan(y):
            phi=np.array([1.,x[1],-x[0]]); yr=y-x[2]
            if t>=14:
                H=np.array([-th[2],th[1],1.]); e=y-(th[0]+H@x); S=H@P@H+R; K=P@H/S
                hph=H@P@H; x=x+K*e; P=P-np.outer(K,H@P); R=max(.95*R+.05*(e*e-hph),.05)
            den=.99+phi@Pr@phi; Kr=Pr@phi/den; er=yr-th@phi
            th=th+Kr*er; Pr=(Pr-np.outer(Kr,phi@Pr))/.99; th[1]=min(max(th[1],.1),5); th[2]=min(max(th[2],0),5)
        d=x[1]-x[0]; vd=P[0,0]+P[1,1]-2*P[0,1]; dd.append(d); ss.append(x[2])
        if t>=28:
            bd=np.array(dd[max(0,t-42):t]); bs=np.array(ss[max(0,t-42):t])
            pd_=norm.cdf((d-bd.mean()-bd.std())/np.sqrt(max(vd,1e-10)))
            ps=norm.cdf((x[2]-bs.mean()-bs.std())/np.sqrt(max(P[2,2],1e-10)))
            p=np.clip(1-(1-pd_)*(1-ps),1e-12,1-1e-12); sc[t]=np.log(p/(1-p))
    return sc,P,th,R
mx=0
for i in range(N):
    sc,P,th,R=ref(i)
    v=b.score['v2'][i].astype(float); m=~np.isnan(sc)
    mx=max(mx,np.max(np.abs(v[m]-sc[m])/np.maximum(1,np.abs(sc[m]))))
print('max relative discrepancy vectorised vs scalar reference (float32 storage):',mx)
# DARE check: constant load and constant wellness, frozen convergence
b1=en.EngineBank(1,2000,np.zeros(1,int),1)
b1.T=2000
for t in range(2000):
    b1._kalman(t,np.array([0.45]),np.array([False]),np.array([3.0]),True,"")
th=b1.theta[0]; Hm=np.array([[-th[2],th[1],1.]]); F=np.diag([np.exp(-1/42),np.exp(-1/7),0.8])
Q=np.diag(b1.q); Rm=np.array([[b1.R[0]]])
Pinf=solve_discrete_are(F.T,Hm.T,Q,Rm)   # prior (predicted) covariance at steady state
# filter stores posterior covariance; convert DARE prior to posterior
K=Pinf@Hm.T@np.linalg.inv(Hm@Pinf@Hm.T+Rm); Ppost=Pinf-K@Hm@Pinf
print('max abs difference posterior covariance vs DARE:',np.abs(b1.P[0]-Ppost).max())
