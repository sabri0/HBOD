"""Demonstration squad of the HBOD application (simulated data).

Run from the repository root:  python tools/mk_demo.py

Writes app/src/demo-data.js, the squad that the application loads with "Load demonstration squad". The data are
simulated: no real athlete is involved.

Source of the data. The simulator of Supplementary File S1 is imported unchanged from simulation/sim. One squad
of 25 athletes is drawn with prior seed 77 and simulation seed 123, the seeds of the parity test and of the
golden values in tests/fixtures/engine_golden.json, here with a single squad. The first 154 days of the simulated
season are kept (22 weeks, from Sunday 25 January 2026 to Saturday 27 June 2026, a day on which the weekly, the
monthly and the quarterly review are all due). Because the engine is recursive, the application computes on
these 154 days exactly the probabilities that File S1 computes on them; tests/build.test.js checks this against
the golden values.

What is written.
  - A responses file in the column format of the form: one row per athlete and day on which the simulator
    produced a report (session duration in minutes, intensity on the Borg CR-10 scale and the four Hooper items).
    The simulator reports the session load as intensity x planned duration, so both factors are written as they
    were drawn; in return to play the duration is 60% of the planned one, as in the simulator.
  - An availability log taken from the simulator's health status: the period of injury or illness starts at the
    simulated onset, and the last seven days of each episode are the return-to-play phase. A period that is not
    over on the last day is left open.
  - Health answers: the daily health item ("Specific pain" and its location) and, every Friday, the Oslo
    questionnaire on health problems with the option texts of the form. THESE HEALTH ANSWERS ARE ILLUSTRATIVE
    ADDITIONS, NOT SIMULATOR OUTPUT. The simulator does not produce them. Five short scripted cases (HEALTH_CASES
    below) were added so that the demonstration shows the three tiers of the health gate (hold, refer, stop);
    every other answer says that there is no problem. They change no load, no Hooper item and no probability.
"""
import datetime as dt
import json
import os
import sys
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.dont_write_bytecode = True                      # leave simulation/ untouched (no __pycache__)
sys.path.insert(0, os.path.join(ROOT, 'simulation', 'sim'))
warnings.filterwarnings('ignore')

import numpy as np                                  # noqa: E402
import scipy                                        # noqa: E402
import hbodsim as hs                                # noqa: E402
import engines as en                                # noqa: E402

PRIOR_SEED, SIM_SEED = 77, 123
DAYS = 154                                          # first 22 weeks of the simulated season
END_DATE = dt.date(2026, 6, 27)                     # Saturday; last Saturday of June 2026
START_DATE = END_DATE - dt.timedelta(DAYS - 1)      # Sunday 25 January 2026
RTP_DAYS = 7                                        # length of the return-to-play phase in the simulator
OUT = os.path.join(ROOT, 'app', 'src', 'demo-data.js')

HEADER = ('Timestamp,Player,Session duration (min),Session intensity (CR-10),Fatigue,Stress,Muscle soreness,Sleep,'
          'Specific pain,Location,OSTRC Q1,OSTRC Q2,OSTRC Q3,OSTRC Q4')

# Option texts of the Oslo questionnaire on health problems, as the form exports them.
NO_PROBLEM = ('Full participation without health problems', 'No reduction', 'No effect', 'No symptoms')
MINOR = ('Full participation but with health problems', 'No reduction', 'No effect', 'Mild')
MINOR_REDUCED = ('Full participation but with health problems', 'To a minor extent', 'To a minor extent', 'Mild')
SUBSTANTIAL = ('Reduced participation', 'To a moderate extent', 'To a moderate extent', 'Moderate')
SUBSTANTIAL_MILD = ('Reduced participation', 'To a moderate extent', 'To a minor extent', 'Moderate')
CANNOT = ('Could not participate', 'To a major extent', 'To a major extent', 'Severe')

# Illustrative health cases (not simulator output). Each case names one athlete (number 1 to 25), a location, the
# days on which the daily health item is answered "Yes", and the answers to the weekly questionnaire on given
# Fridays. With the health gate of the application they give, in order: hold, then refer, then stop on the last
# two days (knee); refer on the last two days (hamstring); hold on the last two days (lower back); hold, refer and
# hold again in March (shoulder); hold on three days in May (ankle).
HEALTH_CASES = [
    dict(athlete=13, location='Knee', pain=('2026-06-10', '2026-06-27'),
         weekly={'2026-06-12': MINOR_REDUCED, '2026-06-19': SUBSTANTIAL_MILD, '2026-06-26': CANNOT}),
    dict(athlete=3, location='Hamstring', pain=('2026-06-24', '2026-06-27'),
         weekly={'2026-06-26': SUBSTANTIAL}),
    dict(athlete=18, location='Lower back', pain=('2026-06-27', '2026-06-27'),
         weekly={'2026-06-26': MINOR}),
    dict(athlete=11, location='Shoulder', pain=('2026-03-11', '2026-03-29'),
         weekly={'2026-03-13': MINOR_REDUCED, '2026-03-20': SUBSTANTIAL, '2026-03-27': MINOR}),
    dict(athlete=5, location='Ankle', pain=('2026-05-05', '2026-05-07'), weekly={}),
]


class RecordingBank(en.EngineBank):
    """EngineBank of File S1, computation unchanged; records what the simulator passes to update() each day."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.score['v2'] = np.full((self.N, self.T), np.nan, np.float64)     # the HBOD score kept in doubles
        self.rep = np.full((self.N, self.T), np.nan)
        self.cat = np.full((self.N, self.T, 4), np.nan)
        self.unav = np.zeros((self.N, self.T), bool)

    def update(self, t, rep, cat, unavailable):
        self.rep[:, t] = rep
        self.cat[:, t, :] = cat
        self.unav[:, t] = unavailable
        super().update(t, rep, cat, unavailable)


def day(t):
    return START_DATE + dt.timedelta(int(t))


def index_of(date_text):
    t = (dt.date.fromisoformat(date_text) - START_DATE).days
    assert 0 <= t < DAYS, f'{date_text} is outside the demonstration period'
    return t


def phases_of(unavailable, onset_injury, onset_illness):
    """Reason of every unavailable day of one athlete: 'injured', 'ill' or 'return to play'.

    The simulator keeps its status code to itself, so the phases are rebuilt from what it returns: an episode
    starts at an onset and ends on the last unavailable day before the next onset or the next healthy day, and
    its last seven days are the return-to-play phase. An episode cut by the end of the simulation keeps the
    reason of its onset throughout.
    """
    T = len(unavailable)
    reason = [None] * T
    t = 0
    while t < T:
        if not unavailable[t]:
            t += 1
            continue
        assert onset_injury[t] or onset_illness[t], 'an unavailable period must start with an onset'
        end = t
        while end + 1 < T and unavailable[end + 1] and not (onset_injury[end + 1] or onset_illness[end + 1]):
            end += 1
        complete = end + 1 < T
        first_rtp = end - RTP_DAYS + 1 if complete else end + 1
        assert first_rtp > t, 'an episode holds at least one day before the return to play'
        for k in range(t, end + 1):
            reason[k] = 'return to play' if k >= first_rtp else ('injured' if onset_injury[t] else 'ill')
        t = end + 1
    return reason


def main():
    A, T = hs.A_PER_SQUAD, hs.T_DAYS
    X = hs.sample_priors(1, np.random.default_rng(PRIOR_SEED))
    widx = np.repeat(np.arange(1), A)
    bank = RecordingBank(A, T, widx, 1)
    out = hs.simulate(X, seed=SIM_SEED, return_wellness=True, engines=bank)
    # planned session duration of each day, drawn as simulate() draws it
    _, duration, _ = hs.build_plans(hs.as_dict(X), np.random.default_rng([SIM_SEED, 1]))
    duration = duration[0]

    names = [f'Athlete {i + 1:02d}' for i in range(A)]
    reasons = [phases_of(bank.unav[i], out['onset_inj'][i], out['onset_ill'][i]) for i in range(A)]

    # ---- illustrative health answers (not simulator output)
    pain = {}                                       # (athlete index, day index) -> location
    weekly = {}                                     # (athlete index, day index) -> four option texts
    for case in HEALTH_CASES:
        i = case['athlete'] - 1
        a, b = index_of(case['pain'][0]), index_of(case['pain'][1])
        assert not bank.unav[i, a:b + 1].any(), f'{names[i]} is unavailable during the health case'
        for t in range(a, b + 1):
            pain[(i, t)] = case['location']
        for date_text, answers in case['weekly'].items():
            t = index_of(date_text)
            assert day(t).weekday() == 4, f'{date_text} is not a Friday'
            assert not np.isnan(bank.rep[i, t]), f'{names[i]} sent no report on {date_text}'
            weekly[(i, t)] = answers
        for t in (a, b):
            assert not np.isnan(bank.rep[i, t]), f'{names[i]} sent no report on {day(t)}'

    # ---- responses file
    rows = [HEADER]
    for t in range(DAYS):
        for i in range(A):
            load = bank.rep[i, t]
            if np.isnan(load):
                continue                            # no report on that day: no row
            minutes = duration[t] * (0.6 if reasons[i][t] == 'return to play' else 1.0)
            if load > 0:
                intensity = load / minutes
                assert minutes == int(minutes) and intensity == int(intensity) and 1 <= intensity <= 10
                minutes, intensity = int(minutes), int(intensity)
                assert minutes * intensity == load
            else:
                minutes, intensity = 0, 0           # a reported day without a session
            sleep, stress, fatigue, soreness = (int(v) for v in bank.cat[i, t])     # item order of File S1
            if bank.unav[i, t]:
                health = ['', '', '', '', '', '']   # covered by the availability log
            else:
                location = pain.get((i, t))
                answers = weekly.get((i, t), NO_PROBLEM if day(t).weekday() == 4 else ('', '', '', ''))
                health = ['Yes' if location else 'No', location or '', *answers]
            rows.append(','.join([f'{day(t).isoformat()} 20:00:00', names[i], str(minutes), str(intensity),
                                  str(fatigue), str(stress), str(soreness), str(sleep), *health]))

    # ---- availability log
    availability = []
    for i in range(A):
        t = 0
        while t < DAYS:
            why = reasons[i][t]
            if why is None:
                t += 1
                continue
            end = t
            while end + 1 < T and reasons[i][end + 1] == why and not (
                    out['onset_inj'][i, end + 1] or out['onset_ill'][i, end + 1]):
                end += 1
            availability.append({'athlete': names[i], 'from': day(t).isoformat(),
                                 'to': day(end).isoformat() if end < DAYS else None, 'reason': why})
            t = end + 1

    # the log reproduces the unavailable flags that the simulator passed to the engine
    covered = np.zeros((A, DAYS), bool)
    for p in availability:
        i = names.index(p['athlete'])
        a = index_of(p['from'])
        b = DAYS - 1 if p['to'] is None else index_of(p['to'])
        covered[i, a:b + 1] = True
    assert np.array_equal(covered, bank.unav[:, :DAYS])

    logit = bank.score['v2'][:, :DAYS]
    alerts = int((np.nan_to_num(logit.astype(np.float32).astype(float), nan=-np.inf) >= en.DEFAULT_THR['v2']).sum())
    meta = {
        'label': 'Demonstration squad (simulated data)',
        'simulated': True,
        'description': ('Simulated squad of 25 athletes followed for 154 days, drawn with the simulator of '
                        'Supplementary File S1. No real athlete is involved. The answers to the daily health item '
                        'and to the weekly Oslo questionnaire are illustrative additions, not simulator output.'),
        'source': {'simulator': 'simulation/sim/hbodsim.py (File S1)', 'priorSeed': PRIOR_SEED,
                   'simulationSeed': SIM_SEED, 'squads': 1, 'firstDays': DAYS},
        'startDate': START_DATE.isoformat(),
        'endDate': END_DATE.isoformat(),
        'athletes': A,
        'days': DAYS,
    }

    lines = [
        '/*',
        ' * Demonstration squad of the HBOD application: SIMULATED DATA. No real athlete is involved.',
        ' *',
        ' * Written by tools/mk_demo.py; do not edit by hand. One squad of 25 athletes drawn with the simulator of',
        f' * Supplementary File S1 (prior seed {PRIOR_SEED}, simulation seed {SIM_SEED}), first {DAYS} days, dated',
        f' * {START_DATE.isoformat()} to {END_DATE.isoformat()}. Session duration, intensity, Hooper items and the',
        ' * availability log come from the simulator. The answers to the daily health item and to the weekly Oslo',
        ' * questionnaire are illustrative additions, not simulator output: they were scripted so that the',
        ' * demonstration shows the three tiers of the health gate.',
        ' *',
        f' * Generated with Python {sys.version.split()[0]}, NumPy {np.__version__} and SciPy {scipy.__version__}.',
        ' */',
        '(function (root, factory) {',
        "  if (typeof module === 'object' && module.exports) module.exports = factory();",
        '  else root.HBOD_DEMO = factory();',
        "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {",
        "  'use strict';",
        '',
        '  // Responses file, one line per report, in the column format of the form.',
        '  const rows = [',
    ]
    lines += [json.dumps(r) + ',' for r in rows]
    lines += [
        '  ];',
        '',
        '  // Periods during which an athlete is injured, ill or in return to play (to: null = still open).',
        '  const availability = [',
    ]
    lines += ['    ' + json.dumps(p) + ',' for p in availability]
    lines += ['  ];', '', '  return {']
    lines += [f'    {k}: {json.dumps(v)},' for k, v in meta.items()]
    lines += [
        "    csv: rows.join('\\n') + '\\n',",
        '    availability: availability',
        '  };',
        '});',
        '',
    ]
    text = '\n'.join(lines)
    assert all(ord(c) < 128 for c in text), 'the demonstration file is plain ASCII'
    with open(OUT, 'w', newline='\n', encoding='ascii') as f:
        f.write(text)

    unavailable_days = int(bank.unav[:, :DAYS].sum())
    print(f'{A} athletes, {DAYS} days ({START_DATE} to {END_DATE}); {len(rows) - 1} reports, '
          f'{A * DAYS - (len(rows) - 1)} athlete-days without a report; {len(availability)} availability periods '
          f'({unavailable_days} unavailable athlete-days); {alerts} athlete-days at p >= 0.80 in File S1; '
          f'{len(HEALTH_CASES)} illustrative health cases; {os.path.getsize(OUT)} bytes written to '
          f'{os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
