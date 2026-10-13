"""Simulated data and File S1 reference values for the parity test of the JavaScript HBOD engine.

Run from inside this folder:  python mk_parity_hbod.py [number of squads, default 4]

The data are the ones used for the parity test of the rule-based prototype in File S1 (verify/mk_parity.py):
prior seed 77 and simulation seed 123, squads of 25 athletes followed for 238 days.

File S1 is imported unchanged from ../simulation/sim. The only difference from a plain run is that the HBOD
score is kept in double precision next to the single-precision value that File S1 stores, so that the daily
probabilities can be compared without the rounding of single-precision storage. The alert decision written
here is the File S1 decision: single-precision score compared with log(0.8 / 0.2).
"""
import sys
sys.path.insert(0, '../simulation/sim')
import json, warnings, datetime as dt
import numpy as np
from scipy.stats import norm
warnings.filterwarnings('ignore')
import hbodsim as hs
import engines as en

PRIOR_SEED, SIM_SEED = 77, 123
W = int(sys.argv[1]) if len(sys.argv) > 1 else 4
A = hs.A_PER_SQUAD
N = W * A
T = hs.T_DAYS
D0 = dt.date(2025, 7, 1)


class RecBank(en.EngineBank):
    """File S1 EngineBank, computation unchanged; records its daily inputs and keeps the HBOD score in doubles."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.score['v2'] = np.full((self.N, self.T), np.nan, np.float64)
        self.rep = np.full((self.N, self.T), np.nan)
        self.cat = np.full((self.N, self.T, 4), np.nan)
        self.unav = np.zeros((self.N, self.T), bool)

    def update(self, t, rep, cat, unavailable):
        self.rep[:, t] = rep
        self.cat[:, t, :] = cat
        self.unav[:, t] = unavailable
        super().update(t, rep, cat, unavailable)


X = hs.sample_priors(W, np.random.default_rng(PRIOR_SEED))
widx = np.repeat(np.arange(W), A)
bank = RecBank(N, T, widx, W)
o = hs.simulate(X, seed=SIM_SEED, return_wellness=True, engines=bank)

# the engine saw exactly what the simulator reported
assert np.array_equal(np.isnan(bank.rep), np.isnan(o['rep_load']))
assert np.allclose(np.nan_to_num(bank.rep), np.nan_to_num(o['rep_load']))

logit64 = bank.score['v2']                                  # double precision, NaN before day 28
scored = ~np.isnan(logit64)
p64 = np.where(scored, 1.0 / (1.0 + np.exp(-logit64)), np.nan)
logit32 = logit64.astype(np.float32)                        # what File S1 stores
thr = en.DEFAULT_THR['v2']                                  # log(0.8 / 0.2)
alert = np.nan_to_num(logit32.astype(float), nan=-np.inf) >= thr

# a plain File S1 run (single-precision storage) gives the same alerts
plain = en.EngineBank(N, T, widx, W)
o2 = hs.simulate(X, seed=SIM_SEED, engines=plain)
assert np.array_equal(plain.alerts('v2'), alert), 'double-precision recording changed a File S1 decision'
assert np.array_equal(plain.score['v2'][scored], logit32[scored])


def num(v):
    return None if np.isnan(v) else float(v)


def fmt(v):
    """Shortest text that reads back as the same number."""
    v = float(v)
    return str(int(v)) if v == int(v) else repr(v)


# ---- engine-level inputs: what File S1 passed to EngineBank.update on each day
inputs = dict(squads=W, athletes_per_squad=A, days=T, start_date=D0.isoformat(),
              load=[[num(bank.rep[i, t]) for t in range(T)] for i in range(N)],
              hooper=[[None if np.isnan(bank.cat[i, t]).any() else [int(v) for v in bank.cat[i, t]]
                       for t in range(T)] for i in range(N)],
              unavailable=[[bool(bank.unav[i, t]) for t in range(T)] for i in range(N)])
json.dump(inputs, open('parity_hbod_inputs.json', 'w'))

# ---- the same data as the application reads them: one responses file per squad and an availability log
# Hooper item order in the simulator: sleep, stress, fatigue, soreness
rows_total = 0
availability = {}
for w in range(W):
    rows = ['Timestamp,Player,Session duration (min),Session intensity (CR-10),Fatigue,Stress,Muscle soreness,Sleep']
    periods = []
    for i in range(w * A, (w + 1) * A):
        name = f'P{i:03d}'
        for t in range(T):
            if np.isnan(bank.rep[i, t]):
                continue                                    # no report on that day: no row
            L = bank.rep[i, t]
            c = bank.cat[i, t]
            sl, st, fa, so = (str(int(v)) for v in c) if not np.isnan(c).any() else ('', '', '', '')
            stamp = f'{(D0 + dt.timedelta(t)).isoformat()} 20:00:00'
            # a session of L minutes at intensity 1 carries the reported load exactly; 0 and 0 on a rest day
            rows.append(f'{stamp},{name},{fmt(L) if L > 0 else 0},{1 if L > 0 else 0},{fa},{st},{so},{sl}')
        t = 0
        while t < T:
            if bank.unav[i, t]:
                t1 = t
                while t1 + 1 < T and bank.unav[i, t1 + 1]:
                    t1 += 1
                periods.append({'athlete': name, 'from': (D0 + dt.timedelta(t)).isoformat(),
                                'to': (D0 + dt.timedelta(t1)).isoformat(), 'reason': 'unavailable'})
                t = t1 + 1
            else:
                t += 1
    open(f'parity_hbod_squad{w}.csv', 'w', newline='\n').write('\n'.join(rows) + '\n')
    availability[f'squad{w}'] = periods
    rows_total += len(rows) - 1
json.dump(dict(start_date=D0.isoformat(), days=T, squads=W, athletes_per_squad=A,
               roster=[f'P{i:03d}' for i in range(N)], availability=availability),
          open('parity_hbod_app.json', 'w'))

# ---- File S1 reference values
z = np.concatenate([np.linspace(-40, 40, 16001), np.random.default_rng(1).normal(0, 3, 20000)])
ref = dict(numpy=np.__version__, scipy=__import__('scipy').__version__, python=sys.version.split()[0],
           prior_seed=PRIOR_SEED, sim_seed=SIM_SEED, squads=W, athletes=N, days=T, threshold_logit=thr,
           p=[[num(v) for v in row] for row in p64],
           logit=[[num(v) for v in row] for row in logit64],
           alert=[[bool(v) for v in row] for row in alert],
           unavailable=[[bool(v) for v in row] for row in bank.unav],
           ndtr_z=[float(v) for v in z], ndtr_p=[float(v) for v in norm.cdf(z)])
json.dump(ref, open('py_hbod.json', 'w'))

print(f'{W} squads, {N} athletes, {T} days; {rows_total} reports written; '
      f'{int(scored.sum())} scored athlete-days; {int(alert.sum())} alerts at p >= 0.80')
