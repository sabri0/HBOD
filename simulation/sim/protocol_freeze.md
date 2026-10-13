Frozen analysis plan (written 2026-10-11, after development runs on seeds 11, 2, 3 and before any evaluation seed was simulated)

Engines frozen as in engines.py (v1, ra_coupled, ra_uncoupled, ewma, week_change, tsb, wellness, v2, v2_noW).
v2 hyperparameters frozen: kappa 1.0, q_g 0.005, q_h 0.03, q_s 0.30, rho_s 0.80, forgetting 0.99, imputation inflation 4, alert at posterior probability >= 0.80.

Evaluation worlds: 1000 parameter vectors drawn without replacement from the wave-2 non-implausible pool; simulation seeds 900000 onwards (never used in development or calibration).
Primary horizon: any time-loss onset (injury or illness) within the next 7 days, healthy athlete-days from day 42.

Open-loop estimands (per world, then averaged over worlds; paired differences against v2 with 95% CI from the world-level t distribution; Benjamini-Hochberg across engines):
  AUROC, average precision, event sensitivity, false alerts per athlete-month and PPV at default thresholds and at a matched 10% alert budget; net benefit across threshold probabilities 0.005 to 0.10; injury-only and illness-only AUROC.
Closed-loop estimands (common random numbers, matched 10% alert budget, deload 25% for two days):
  days lost per 100 athlete-days (primary), injury and illness incidence per 1000 athlete-days, delivered load, season-end Banister performance; paired differences against a random-alert placebo with the same budget.
Robustness: 5 x 5 grid of under-reporter share (0, 0.1, 0.2, 0.3, 0.4) and MNAR strength (0, 0.25, 0.5, 0.75, 1), 40 worlds per cell.
Global sensitivity: Saltelli design (base N = 256) over the wave-1 non-implausible box with a dummy parameter; outputs AUROC of v2, AUROC difference v2 minus EWMA ACWR, closed-loop days lost difference v2 minus ACWR policy.

Pre-specified replacement rule. A candidate replaces the ACWR component of HBOD if all hold on evaluation seeds:
  (1) closed-loop days lost lower than under the best ratio-based (ACWR) policy, BH q < 0.05;
  (2) closed-loop days lost lower than under the random placebo, BH q < 0.05;
  (3) open-loop AUROC non-inferior to the best ACWR variant, lower 95% limit of the difference above -0.02;
  (4) the sign of (1) preserved in at least 20 of the 25 robustness cells.
If no candidate meets all four, the paper reports that no replacement is supported.
