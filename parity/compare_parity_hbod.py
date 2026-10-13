"""Compare the JavaScript HBOD engine (js_hbod.json) with the Python code of File S1 (py_hbod.json).

Run from inside this folder, after mk_parity_hbod.py and parity_hbod.js:  python compare_parity_hbod.py

Two numbers are reported:
  1. the maximum absolute difference in daily probabilities;
  2. the share of athlete-days with the same alert decision.

When js_hbod_app.json exists (written by parity_app.js), the same two numbers are also reported for the
application path, in which the application core reads the responses file of each squad and prepares the inputs
of the engine itself.
"""
import json
import os
import sys
import numpy as np

py = json.load(open('py_hbod.json'))
js = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'js_hbod.json'))
app_file = sys.argv[2] if len(sys.argv) > 2 else 'js_hbod_app.json'


def arr(a):
    return np.array([[np.nan if v is None else v for v in row] for row in a], float)


pp, lp = arr(py['p']), arr(py['logit'])
ap = np.array(py['alert'], bool)
N, T = pp.shape
scored = ~np.isnan(pp)
healthy = scored & ~np.array(py['unavailable'], bool)


def compare(other):
    """Differences between File S1 and one JavaScript run over the scored athlete-days."""
    pj, lj = arr(other['p']), arr(other['logit'])
    aj = np.array(other['alert'], bool)
    assert np.array_equal(scored, ~np.isnan(pj)), 'the two engines do not score the same athlete-days'
    dp = np.abs(pp - pj)[scored]
    dl = np.abs(lp - lj)[scored]
    same_all = int((ap == aj).sum())
    same_scored = int((ap == aj)[scored].sum())
    return dict(max_abs_diff_probability=float(dp.max()), median_abs_diff_probability=float(np.median(dp)),
                bit_identical=int((dp == 0).sum()), scored_athlete_days=int(scored.sum()),
                athlete_days=int(N * T), same_alert_scored=same_scored, same_alert_all=same_all,
                share_same_alert_scored=same_scored / int(scored.sum()), share_same_alert_all=same_all / (N * T),
                alerts_python=int(ap.sum()), alerts_javascript=int(aj.sum()),
                max_abs_diff_logit=float(dl.max()))


def headline(r):
    print(f"1. maximum absolute difference in daily probabilities: {r['max_abs_diff_probability']:.3e}"
          f"   (median {r['median_abs_diff_probability']:.1e}; identical to the last bit on "
          f"{r['bit_identical']} of {r['scored_athlete_days']})")
    print(f"2. athlete-days with the same alert decision: {r['same_alert_scored']} of "
          f"{r['scored_athlete_days']} scored athlete-days ({100 * r['share_same_alert_scored']:.4f}%); "
          f"{r['same_alert_all']} of {r['athlete_days']} over all athlete-days "
          f"({100 * r['share_same_alert_all']:.4f}%)")


res = compare(js)
z = np.array(py['ndtr_z']); dz = np.abs(np.array(py['ndtr_p']) - np.array(js['ndtr']))

print(f"File S1: Python {py['python']}, NumPy {py['numpy']}, SciPy {py['scipy']}; "
      f"application engine {js['engine']} on Node.js {js['node']}")
print(f"data: prior seed {py['prior_seed']}, simulation seed {py['sim_seed']}, {py['squads']} squads, "
      f"{N} athletes, {T} days")
print(f"athlete-days: {N * T} in total, {int(scored.sum())} with a probability (from day 28), "
      f"{int(healthy.sum())} of them healthy")
print()
headline(res)
print()
print(f"alerts at p >= 0.80: File S1 {res['alerts_python']}, JavaScript {res['alerts_javascript']}")
print(f"maximum absolute difference of the score on the logit scale: {res['max_abs_diff_logit']:.3e}")
print(f"standard normal distribution function on {z.size} points: maximum absolute difference {dz.max():.3e}")

result = dict(res, max_abs_diff_ndtr=float(dz.max()),
              python=py['python'], numpy=py['numpy'], scipy=py['scipy'], node=js['node'], engine=js['engine'],
              prior_seed=py['prior_seed'], sim_seed=py['sim_seed'], squads=py['squads'], athletes=N, days=T)

# ---- application path: the same File S1 values against the engine fed by the application core
if os.path.exists(app_file):
    app = json.load(open(app_file))
    res_app = compare(app)
    print()
    print(f"Application path ({app['reports']} reports in {py['squads']} responses files read by the application "
          f"core; inputs of the engine identical to those of File S1 on {app['same_inputs']} of "
          f"{app['athlete_days']} athlete-days)")
    headline(res_app)
    print(f"alerts at p >= 0.80: File S1 {res_app['alerts_python']}, JavaScript {res_app['alerts_javascript']}")
    result['application'] = dict(res_app, reports=app['reports'], same_inputs=app['same_inputs'],
                                 node=app['node'], engine=app['engine'])

json.dump(result, open('parity_hbod_result.json', 'w'), indent=1)
