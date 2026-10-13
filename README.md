# HBOD

**HBOD (Hooper-Borg-Oslo-Dergaa)** is an autonomous artificial intelligence agent for the daily monitoring of
training load, wellness and health. Athletes report session duration, rating of perceived exertion (Borg CR-10) and
four Hooper items on one short daily form. For each athlete, HBOD keeps three modelled states (fitness, fatigue and
a wellness strain that load does not explain), updates them every day with a Kalman filter and athlete-specific
learning, widens its uncertainty when a report is missing, and returns a **probability** with a fixed alert budget.
The coach keeps the final decision.

This repository accompanies the paper

> **Development of an autonomous artificial intelligence agent for training load monitoring: a simulation study and
> closed-loop in silico trial against the acute-to-chronic workload ratio**

and holds, as code only:

| Folder | Content |
| --- | --- |
| [`app/`](app/) | The HBOD web application: one self-contained file, [`app/HBOD_App.html`](app/HBOD_App.html), built from `app/src/`. |
| [`simulation/`](simulation/) | Supplementary File S1 of the paper, unchanged: the simulator, the nine monitoring signals, the experiments, the analyses, the verification scripts and the figure scripts. |
| [`parity/`](parity/) | The parity test of the JavaScript engine of the application against the Python code of File S1. |
| [`cli/`](cli/) | The same analytical core on the command line, and the optional language-model layer. |
| [`tests/`](tests/) | Automated tests (Node.js built-in runner, no dependency). |

The protocol and the frozen analysis plan of the study are registered on the Open Science Framework:
<https://doi.org/10.17605/OSF.IO/MUWQ3>.

## What the probability means

> The probability shows how far the athlete's modelled state sits beyond his or her own baseline. It is not an
> injury risk.

It is the posterior probability that the fatigue-minus-fitness deficit or the wellness strain exceeds the athlete's
own baseline of up to 42 previous days by one standard deviation (Equation 14 of the paper). An alert is raised when
it reaches 0.80. In the simulation study no monitoring signal predicted time-loss onsets well, and HBOD failed one of
the four pre-specified criteria of the replacement test; its use is an operational preference pending field
validation, not an evidence-based mandate. HBOD supports the decision; it does not take it.

## The application

Open [`app/HBOD_App.html`](app/HBOD_App.html) in a browser and load the responses file of the daily form (CSV), or
press *Load demonstration squad* to try it on simulated data.

- **Free for academic and training use.**
- **Computes on the coach's device without uploading any data.** The page is a single file with no server behind
  it. Its Content-Security-Policy forbids every connection (`default-src 'none'; connect-src 'none'`), and it loads
  no external script, font or image. Settings and logs stay in the local storage of the browser and can be exported
  as files.

What it does:

| Subject | Behaviour |
| --- | --- |
| Decision engine | The HBOD state-space engine of File S1 (`simulation/sim/engines.py`), Equations 7 to 14 of Section 2.5, with the settings of Table S2 (below). |
| Alert | When the posterior probability reaches 0.80. |
| Alert budget | A setting ranks the healthy athletes by probability and caps the daily list at about 10% of healthy athlete-days, about two athletes per day in a squad of 25. Athletes at or above 0.80 beyond the cap are shown as above the threshold, outside the budget. |
| Missing reports | A missing session load is replaced by the squad median of that day, and the uncertainty of fitness and fatigue is multiplied by four. A missing day is never treated as rest. |
| Unavailable athletes | Athletes who are injured, ill or in return to play (availability log kept by the staff) contribute zero load and are never on the list. |
| Acute-to-chronic workload ratio | Acute load, chronic load and their ratio stay on screen **for planning only**. The ratio raises no flag and triggers no decision. |
| Health | The daily health item, the weekly Oslo questionnaire and the health gate (hold, refer, stop) are unchanged. The gate sits above load and wellness, whatever the probability shows. |
| Daily report | States what the probability shows and that it is not an injury risk; lists the health gate, today's list, the missing reports to follow up the same day and the unavailable athletes; adds descriptive weekly, monthly and quarterly reviews when they are due. |
| Language-model layer | Optional. A language model may only restate the computed result in plain language; it never computes or changes the probability. Every stored summary carries the probability of the engine next to it, with an automatic screening check, so that faithfulness can be tested in the field study. The application itself contacts no model. |

### Settings of the engine (Table S2)

| Setting | Value |
| --- | --- |
| States | fitness, fatigue (exponentially weighted load, time constants 42 and 7 days) and wellness strain (autoregressive coefficient 0.80) |
| Process noise (SD) | 0.005 kAU, 0.03 kAU and 0.30 item units; variances of fitness and fatigue × 4 on days with an imputed load |
| Initial state and covariance | zero; diag(0.05, 0.05, 0.25) |
| Observation coefficients (c0, ch, cg) | start at 3.5, 1.0, 0.3; learned by recursive least squares, forgetting factor 0.99, initial covariance diag(1, 4, 4); ch within 0.1 to 5, cg within 0 to 5 |
| Observation variance | adaptive, starts at 0.5, never below 0.05 |
| Wellness correction | from day 14, only on days with all four Hooper items |
| Personal baseline | from day 28, using up to 42 previous days |
| Exceedance and alert | κ = 1 SD; alert when the posterior probability reaches 0.80 |
| Alert budget (application) | 10% of healthy athlete-days by default |

### Input

A form-responses CSV with one line per report. Columns are matched by keyword, in English or French: timestamp,
player, session duration (min), session intensity (CR-10), fatigue, stress, muscle soreness, sleep (Hooper items,
1 = best to 7 = worst), specific pain and its location (daily health item), and the four items of the Oslo
questionnaire. One file is one squad. Day 0 is the first day of the file, and every calendar day counts.

### Command line

```bash
node cli/hbod.js --input responses.csv --availability availability.json \
     --out report.html --text report.txt --audit audit.csv --json day.json
node cli/summarize.js --day day.json            # prints the constrained prompt and the data block; calls no model
```

`cli/summarize.js --run` is an explicit opt-in that sends the constrained prompt and the computed result of the
selected athletes, with every name replaced by a code, to a language model. Nothing else in this repository can
send anything.

## Parity of the JavaScript engine with File S1

The engine of the application (`app/src/engine.js`) is a port of the HBOD engine of File S1. Both were run on the
same simulated data, the data of the prototype check in `simulation/verify/` (prior seed 77, simulation seed 123:
4 squads, 100 athletes, 238 days, 19,471 reports), once through the engine alone and once through the whole
application path (responses files read by the application core).

| Measure | Result |
| --- | --- |
| Maximum absolute difference in daily probabilities | **2.6 × 10⁻¹⁴** |
| Athlete-days with the same alert decision | **21,000 of 21,000** scored athlete-days (100%); 23,800 of 23,800 over all athlete-days |

The health gate of the application gives the same result as the code of the rule-based prototype on 9,340 of 9,340
athlete-days of the prototype's two synthetic datasets.

```bash
npm run parity               # needs Python with NumPy and SciPy, and Node.js 22
npm run parity:health-gate
```

## Tests

```bash
npm test                     # node --test; Node.js 22, no package to install
npm run build                # rebuilds app/HBOD_App.html from app/src/
```

## Simulation code (Supplementary File S1)

`simulation/` is File S1 as submitted with the paper. Its own [`simulation/README.txt`](simulation/README.txt)
gives the requirements (Python 3.11 with NumPy 2.4, SciPy 1.17, SALib 1.6 and Matplotlib 3.10), the run order and
every random-number seed. No result file is shipped; every result is regenerated. In that code the working names
`v1`, `v2` and `v2_noW` stand for the rule-based prototype, HBOD and HBOD without wellness.

## Releases

| Release | Content |
| --- | --- |
| `v1.0.0` | The release that matches the paper: HBOD application and engine, File S1, parity test. |
| `v0.1.0-rule-based-prototype` | **Archived earlier release.** The rule-based prototype, an unpublished development stage of HBOD and the internal comparator of the paper. It is not HBOD as described in the paper and is kept for reference only. |

Releases tuned on field data will carry version numbers, so that each published result maps to a citable release.

## Citation and licence

Please cite the paper and this software release (see [`CITATION.cff`](CITATION.cff)).

HBOD is free for academic and training use. The code is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md); see [`NOTICE`](NOTICE). For any other use, contact the authors.
