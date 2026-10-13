"""Golden values of File S1 for the unit tests of the JavaScript HBOD engine.

Run from inside this folder:  python mk_golden.py

One simulated squad of 25 athletes followed for 238 days, drawn with prior seed 77 and simulation seed 123 (the
seeds of the parity test, here with a single squad). File S1 is imported unchanged from ../simulation/sim. As in
mk_parity_hbod.py, the HBOD score is kept in double precision next to the single-precision value that File S1
stores; the alert decision written here is the File S1 decision (single-precision score compared with
log(0.8 / 0.2)).

Writes ../tests/fixtures/engine_golden.json, which the tests read without needing Python:
  load         reported session load per athlete and day in AU, null where the athlete sent no report
  hooper       per athlete, four characters per day in the order of File S1 (sleep, stress, fatigue, soreness),
               '----' on days without the four items
  unavailable  per athlete, one character per day: '1' injured, ill or in return to play, else '0'
  p            posterior probability of File S1 in double precision, null before day 28
  alert        per athlete, one character per day: '1' where File S1 raises an alert at p >= 0.80
  ratio        uncoupled rolling-average ratio of acute to chronic load of File S1 (stored in single precision),
               null before day 34 and where the chronic load is zero; used to check the planning indices
"""
import sys
sys.path.insert(0, '../simulation/sim')
import json, os, warnings
import numpy as np
warnings.filterwarnings('ignore')
import hbodsim as hs
import engines as en

PRIOR_SEED, SIM_SEED = 77, 123
W = 1
A = hs.A_PER_SQUAD
T = hs.T_DAYS
OUT = os.path.join('..', 'tests', 'fixtures', 'engine_golden.json')


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
bank = RecBank(A, T, widx, W)
hs.simulate(X, seed=SIM_SEED, return_wellness=True, engines=bank)

logit64 = bank.score['v2']                                  # double precision, NaN before day 28
scored = ~np.isnan(logit64)
p64 = np.where(scored, 1.0 / (1.0 + np.exp(-logit64)), np.nan)
logit32 = logit64.astype(np.float32)                        # what File S1 stores
alert = np.nan_to_num(logit32.astype(float), nan=-np.inf) >= en.DEFAULT_THR['v2']

# a plain File S1 run (single-precision storage) gives the same alerts
plain = en.EngineBank(A, T, widx, W)
hs.simulate(X, seed=SIM_SEED, engines=plain)
assert np.array_equal(plain.alerts('v2'), alert), 'double-precision recording changed a File S1 decision'
ratio = plain.score['ra_uncoupled']


def num(v):
    """Shortest text that reads back as the same number; whole numbers without a decimal point."""
    if np.isnan(v):
        return None
    v = float(v)
    return int(v) if v == int(v) else v


def bits(row):
    return ''.join('1' if v else '0' for v in row)


golden = dict(
    source='File S1 (simulation/sim/engines.py, EngineBank), written by parity/mk_golden.py',
    python=sys.version.split()[0], numpy=np.__version__, scipy=__import__('scipy').__version__,
    prior_seed=PRIOR_SEED, sim_seed=SIM_SEED, athletes=A, days=T, threshold_logit=en.DEFAULT_THR['v2'],
    load=[[num(v) for v in row] for row in bank.rep],
    hooper=[''.join('----' if np.isnan(c).any() else ''.join(str(int(v)) for v in c) for c in row)
            for row in bank.cat],
    unavailable=[bits(row) for row in bank.unav],
    p=[[num(v) for v in row] for row in p64],
    alert=[bits(row) for row in alert],
    # a single-precision value is written with the digits that identify it in single precision
    ratio=[[None if np.isnan(v) else float(str(v)) for v in row] for row in ratio])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', newline='\n') as f:
    json.dump(golden, f, separators=(',', ':'))
    f.write('\n')
print(f'{A} athletes, {T} days; {int(scored.sum())} scored athlete-days; {int(alert.sum())} alerts at p >= 0.80; '
      f'{int((~np.isnan(ratio)).sum())} ratios; {os.path.getsize(OUT)} bytes written to {OUT}')
