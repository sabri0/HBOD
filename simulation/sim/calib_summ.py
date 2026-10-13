"""World-level summary statistics used for calibration (history matching)."""
import numpy as np
from hbodsim import EVAL_START
def summaries(o):
    widx=o['widx']; W=widx.max()+1
    E=np.zeros_like(o['healthy']); E[:,EVAL_START:]=True
    rep=o['rep_load']; out=np.zeros((W,5))
    for w in range(W):
        r=widx==w; e=E[r]; ad=e.sum()
        inj=(o['onset_inj'][r]&e).sum(); ill=(o['onset_ill'][r]&e).sum()
        # weekly sRPE of healthy athletes from true load in weeks fully healthy (training load)
        wt=o['w_true'][r][:,EVAL_START:]; hl=o['healthy'][r][:,EVAL_START:]
        nw=wt.shape[1]//7
        wk=wt[:,:nw*7].reshape(wt.shape[0],nw,7).sum(2); hk=hl[:,:nw*7].reshape(wt.shape[0],nw,7).all(2)
        avail=(o['healthy'][r]|False)[:,EVAL_START:]
        comp=(~np.isnan(rep[r][:,EVAL_START:]))[avail].mean()
        out[w]=[wk[hk].mean(), inj/ad*1000, ill/max(inj+ill,1), (~hl).mean(), comp]
    return out
NAMES=['weekly sRPE (AU)','injury incidence (/1000 athlete-days)','illness share','unavailability prevalence','report compliance']
