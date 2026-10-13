"""Closed-loop in silico trial on development seeds (matched alert budget, CRN)."""
import numpy as np, warnings, time, sys
warnings.filterwarnings('ignore')
import hbodsim as hs, metrics as mt
from engines import EngineBank
W=int(sys.argv[1]) if len(sys.argv)>1 else 40; seed=int(sys.argv[2]) if len(sys.argv)>2 else 11
rate=0.10
rng=np.random.default_rng(2); X=hs.sample_priors(W,rng)
t0=time.time(); base=hs.simulate(X,seed=seed); print('open loop',round(time.time()-t0,1),'s')
widx=base['widx']; N=len(widx); ev=np.zeros_like(base['healthy']); ev[:,hs.EVAL_START:]=True
mask=base['healthy']&ev
def thr_for(e):
    s=np.nan_to_num(base['bank'].score[e].astype(float),nan=-1e9); th=np.zeros(W)
    for w in range(W):
        r=widx==w; th[w]=np.quantile(s[r][mask[r]],1-rate)
    return th[widx]
def outcome(o):
    E=np.zeros_like(o['healthy']); E[:,hs.EVAL_START:]=True
    ad=E.sum()
    inj=(o['onset_inj']&E).sum()/ad*1000; ill=(o['onset_ill']&E).sum()/ad*1000
    lost=((~o['healthy'])&E).sum()/ad*100
    load=o['w_true'][:,hs.EVAL_START:].sum(1).mean()/1000
    perf=(o['G']-o['H'])[:,-1].mean()  # Banister performance proxy at season end
    return np.array([inj,ill,lost,load,perf])
res={'none':outcome(base)}
for e in ['v1','ra_coupled','ewma','tsb','wellness','v2','v2_noW']:
    b=EngineBank(N,hs.T_DAYS,widx,W); b.thr[e]=thr_for(e)
    o=hs.simulate(X,seed=seed,policy=e,engines=b); res[e]=outcome(o)
    al=b.alerts(e); E=o['healthy'].copy(); E[:,:hs.EVAL_START]=False
    print(e,'realised alert rate',round((al&E).sum()/E.sum(),3), np.round(res[e],3),flush=True)
b=EngineBank(N,hs.T_DAYS,widx,W); b.placebo_rate=np.full(W,rate)
o=hs.simulate(X,seed=seed,policy='random:x',engines=b); res['random']=outcome(o)
print('cols: inj/1000d ill/1000d %days lost load(kAU) perf')
for k,v in res.items(): print(f"{k:12s}",np.round(v,3), 'diff vs random', np.round(v-res['random'],3))
