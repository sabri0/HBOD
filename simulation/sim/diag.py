import numpy as np, warnings
warnings.filterwarnings('ignore')
import hbodsim as hs, metrics as mt
from engines import ENGINES
rng=np.random.default_rng(2)
X=hs.sample_priors(60,rng)
out=hs.simulate(X,seed=11)
b=out['bank']
s=b.score['v2'][:,hs.EVAL_START:]
print('v2 ties: frac==0',np.mean(s==0),'frac==1',np.mean(s==1), 'unique',len(np.unique(s)))
# oracle: true zF and zS based score: use zF and also true spike
P=out['P']; widx=out['widx']
zF=out['zF'].astype(float)
S=hs.spike_series(out['w_true'])
phi=P['phi'][widx][:,None]
# standardize spike within athlete
mS=np.nanmean(S[:,42:],1,keepdims=True); sS=np.nanstd(S[:,42:],1,keepdims=True)
zS=(S-mS)/sS
b.score['oracle']=((1-phi)*zF+phi*np.nan_to_num(zS)).astype(np.float32)
b.score['oracle_F']=zF.astype(np.float32)
eng=ENGINES+['oracle','oracle_F']
al={e:np.zeros_like(out['healthy']) for e in eng}
R=mt.world_metrics(out,eng,al)
phis=P['phi']
for e in eng:
    a=R[e]['auc']
    print(f"{e:12s} AUC all {np.nanmean(a):.3f}  phi<.33 {np.nanmean(a[phis<.33]):.3f}  phi>.66 {np.nanmean(a[phis>.66]):.3f}")
print('--- injury only / illness only')
Ri=mt.world_metrics(out,eng,al,onset=out['onset_inj'])
Rl=mt.world_metrics(out,eng,al,onset=out['onset_ill'])
for e in eng:
    print(f"{e:12s} inj {np.nanmean(Ri[e]['auc']):.3f}  ill {np.nanmean(Rl[e]['auc']):.3f}")
print('prodrome mean',P['prodrome'].mean())
