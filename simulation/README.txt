HBOD developmental simulation study: code (Supplementary File S1)

Requirements: Python 3.11 with NumPy 2.4, SciPy 1.17, SALib 1.6 and Matplotlib 3.10; Node.js for the parity check of the
rule-based prototype; Mermaid command-line interface 11.14.0 for the flowcharts (figures/fig1.mmd and figures/fig9.mmd).

Run every script from inside its own folder.

Names used in the code
v1      rule-based prototype (an unpublished development stage of HBOD)
v2      HBOD, the adaptive state-space agent (Kalman filter with recursive least squares)
v2_noW  HBOD without wellness (ablation without any observation update)
These working names match the labels of the retrospective registration (https://doi.org/10.17605/OSF.IO/MUWQ3).

sim/hbodsim.py          data-generating model (training plan, Busso physiology, injury and illness hazards, reporting model);
                        LIFE_ILL sets the effect of life stress on illness exposure (0.3 in all frozen analyses)
sim/engines.py          the nine monitoring signals (rule-based prototype, three ACWR variants, week-to-week change, TSB,
                        wellness z score, HBOD and HBOD without wellness)
sim/metrics.py          open-loop performance measures
sim/calib.py            two-wave history matching (calib_summ.py: calibration statistics)
sim/experiments.py      open-loop and closed-loop experiment functions
sim/run_main.py         main evaluation (1000 worlds, open and closed loop)
sim/run_robust.py       five-by-five reporting robustness grid
sim/run_sobol.py        Saltelli design for global sensitivity analysis
sim/run_dose.py         exploratory dose analysis (alert budgets 5%, 10%, 20% and 30%; not part of the frozen plan)
sim/run_lifeoff.py      check of model structure: life-stress term of illness exposure set to 0 and kept at 0.3 (200 worlds;
                        not part of the frozen plan)
sim/analyze.py          aggregation, confidence intervals, Benjamini-Hochberg q-values, decision rule
sim/analyze_circ.py     prodrome and progression quartiles; paired comparison of the life-stress runs
sim/analyze_sobol.py    Saltelli indices and naive binned first-order indices
sim/analyze_sobol_cluster.py  binned first-order indices with a bias-corrected cluster bootstrap over Saltelli base blocks;
                        HBOD minus EWMA ACWR differences in the worlds drawn without history matching
sim/analyze_dose.py, analyze_rob.py  dose and robustness summaries
sim/diag.py, cl.py      development diagnostics (development seeds only)
sim/protocol_freeze.md  frozen analysis plan
verify/                 parity of the rule-based prototype against its JavaScript code, scalar and Riccati checks of HBOD,
                        closed-form physiology check
figures/                scripts for Figures 1 to 9 and Figures S1 to S3

Run order (no result files are shipped; every result is regenerated)
1. sim: python calib.py, then python calib_summ.py (history matching and calibration statistics)
2. sim: python run_main.py, run_robust.py, run_sobol.py, run_dose.py and run_lifeoff.py
3. sim: python analyze.py, analyze_rob.py, analyze_sobol.py, analyze_sobol_cluster.py, analyze_dose.py and analyze_circ.py
4. figures: python fig2.py to fig8.py and figS1.py to figS3.py; mmdc for fig1.mmd and fig9.mmd
5. verify: python mk_parity.py, then node parity.js (Node.js 22), then python compare_parity.py;
   python kalman_check.py; python const_check.py

Random-number seeds
development: prior draws seed 2 and simulation seed 11 (diag.py, cl.py); development seeds 2 and 3 are also listed in the
  frozen plan.
calibration: Sobol scrambling seeds 1 (pilot), 2 (wave 1) and 3 (wave 2); simulation seeds 1000 and 2000 (pilot), from
  10000 (wave 1) and from 50000 (wave 2).
main evaluation: simulation seeds 900000 onwards; parameter draw seed 2026.
robustness grid: simulation seeds 700000 onwards; draw seed 3030.
Sobol design: design seed 4040; simulation seeds 500000 onwards; SALib bootstrap seed 7; naive binned bootstrap seed 11;
  cluster bootstrap seed 12.
dose analysis: 950000. life-stress check: 960000 onwards (first 200 evaluation parameter sets, same seeds for both runs).
figures: exemplar athlete (Figure 2) 990000 onwards; point jitter in Figure 3 seed 1.
verification: parity data prior seed 77 and simulation seed 123; Kalman check prior seed 9 and simulation seed 5.
tie-breaking of equal prototype scores in metrics.py uses the world index as seed.
