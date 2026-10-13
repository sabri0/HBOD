/*
 * HBOD state-space engine (JavaScript).
 *
 * Port of the HBOD engine of Supplementary File S1 (simulation/sim/engines.py: EngineBank._impute and
 * EngineBank._kalman with use_obs=True, the class named v2 in that file). The equations are Equations 7 to 14
 * of Section 2.5 of the paper and the settings are those of Table S2. Every arithmetic step keeps the order of
 * operations of the Python code so that the two implementations can be compared number by number
 * (see parity/).
 *
 * Three states per athlete: fitness G and fatigue H (exponentially weighted means of daily load, in kAU) and a
 * wellness strain s that load does not explain (Hooper item units). The daily output is the posterior probability
 * that the fatigue-minus-fitness deficit or the strain exceeds the athlete's own baseline by kappa SD. It describes
 * how far the modelled state sits beyond that baseline. It is not the probability of an injury or an illness.
 *
 * The acute-to-chronic workload ratio is not computed here and triggers nothing.
 *
 * Pure computation: no DOM, no network, no storage. Runs unchanged in the browser and in Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HBODEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  // ------------------------------------------------------------------ settings (Table S2)
  const SETTINGS = Object.freeze({
    tauG: 42.0,                 // fitness time constant (days): F[0][0] = exp(-1/42)
    tauH: 7.0,                  // fatigue time constant (days): F[1][1] = exp(-1/7)
    rhoS: 0.80,                 // autoregressive coefficient of the wellness strain: F[2][2]
    qG: 0.005,                  // process-noise SD of fitness (kAU)
    qH: 0.03,                   // process-noise SD of fatigue (kAU)
    qS: 0.30,                   // process-noise SD of strain (Hooper item units)
    p0G: 0.05,                  // initial variance of fitness
    p0H: 0.05,                  // initial variance of fatigue; strain starts at qS^2 / (1 - rhoS^2) = 0.25
    theta0: Object.freeze([3.5, 1.0, 0.3]),   // initial observation coefficients (c0, ch, cg)
    rlsP0: Object.freeze([1.0, 4.0, 4.0]),    // initial diagonal of the recursive-least-squares covariance
    forget: 0.99,               // forgetting factor of recursive least squares
    chMin: 0.1, chMax: 5.0,     // bounds of ch
    cgMin: 0.0, cgMax: 5.0,     // bounds of cg
    R0: 0.5,                    // initial observation variance
    rKeep: 0.95, rGain: 0.05,   // adaptive observation variance: R <- max(0.95 R + 0.05 (e^2 - c P c'), rFloor)
    rFloor: 0.05,
    correctionStartDay: 14,     // wellness correction from day 14 (days are numbered from 0)
    baselineStartDay: 28,       // personal baseline and probability from day 28
    baselineWindow: 42,         // up to 42 previous days
    kappa: 1.0,                 // exceedance of the baseline, in SD
    alertProbability: 0.80,     // alert when the posterior probability reaches 0.80
    imputeInflation: 4.0,       // process-noise variances of fitness and fatigue x 4 on days with an imputed load
    auPerKau: 1000.0,           // load enters the filter in thousands of arbitrary units
    varFloor: 1e-10,            // floor of the posterior variances inside the probability
    pClip: 1e-12,               // probabilities are kept inside [1e-12, 1 - 1e-12]
    alertBudget: 0.10           // default alert budget: share of healthy athlete-days on the daily list
  });

  // ------------------------------------------------------------------ standard normal distribution function
  // Cephes ndtr (erf and erfc by rational approximation), the routine behind scipy.stats.norm.cdf in File S1.
  const P_ = [2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687e0,
    4.86371970985681366614e1, 1.96520832956077098242e2, 5.26445194995477358631e2,
    9.34528527171957607540e2, 1.02755188689515710272e3, 5.57535335369399327526e2];
  const Q_ = [1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2,
    9.75708501743205489753e2, 1.82390916687909736289e3, 2.24633760818710981792e3,
    1.65666309194161350182e3, 5.57535340817727675546e2];
  const R_ = [5.64189583547755073984e-1, 1.27536670759978104416e0, 5.01905042251180477414e0,
    6.16021097993053585195e0, 7.40974269950448939160e0, 2.97886665372100240670e0];
  const S_ = [2.26052863220117276590e0, 9.39603524938001434673e0, 1.20489539808096656605e1,
    1.70814450747565897222e1, 9.60896809063285878198e0, 3.36907645100081516050e0];
  const T_ = [9.60497373987051638749e0, 9.00260197203842689217e1, 2.23200534594684319226e3,
    7.00332514112805075473e3, 5.55923013010394962768e4];
  const U_ = [3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3,
    2.26290000613890934246e4, 4.92673942608635921086e4];
  const MAXLOG = 7.09782712893383996843e2;

  function polevl(x, c) {
    let a = c[0];
    for (let i = 1; i < c.length; i++) a = a * x + c[i];
    return a;
  }
  function p1evl(x, c) {
    let a = x + c[0];
    for (let i = 1; i < c.length; i++) a = a * x + c[i];
    return a;
  }
  function erf(x) {
    if (Number.isNaN(x)) return NaN;
    if (x < 0.0) return -erf(-x);
    if (Math.abs(x) > 1.0) return 1.0 - erfc(x);
    const z = x * x;
    return x * polevl(z, T_) / p1evl(z, U_);
  }
  function erfc(a) {
    if (Number.isNaN(a)) return NaN;
    const x = a < 0.0 ? -a : a;
    if (x < 1.0) return 1.0 - erf(a);
    let z = -a * a;
    if (z < -MAXLOG) return a < 0 ? 2.0 : 0.0;
    z = Math.exp(z);
    let p, q;
    if (x < 8.0) { p = polevl(x, P_); q = p1evl(x, Q_); }
    else { p = polevl(x, R_); q = p1evl(x, S_); }
    let y = (z * p) / q;
    if (a < 0) y = 2.0 - y;
    if (y === 0.0) return a < 0 ? 2.0 : 0.0;
    return y;
  }
  function normCdf(a) {
    if (Number.isNaN(a)) return NaN;
    const x = a * Math.SQRT1_2;
    const z = Math.abs(x);
    if (z < Math.SQRT1_2) return 0.5 + 0.5 * erf(x);
    let y = 0.5 * erfc(z);
    if (x > 0) y = 1.0 - y;
    return y;
  }

  // ------------------------------------------------------------------ helpers
  // Sum in the order used by NumPy for a contiguous run of doubles (pairwise summation with eight
  // accumulators), so that baseline means and SDs follow File S1 to the last bit.
  function pairwiseSum(a, start, n) {
    if (n < 8) {
      let res = 0.0;
      for (let i = 0; i < n; i++) res += a[start + i];
      return res;
    }
    if (n <= 128) {
      const r = [a[start], a[start + 1], a[start + 2], a[start + 3],
        a[start + 4], a[start + 5], a[start + 6], a[start + 7]];
      let i = 8;
      const lim = n - (n % 8);
      for (; i < lim; i += 8) {
        r[0] += a[start + i]; r[1] += a[start + i + 1]; r[2] += a[start + i + 2]; r[3] += a[start + i + 3];
        r[4] += a[start + i + 4]; r[5] += a[start + i + 5]; r[6] += a[start + i + 6]; r[7] += a[start + i + 7];
      }
      let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < n; i++) res += a[start + i];
      return res;
    }
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return pairwiseSum(a, start, n2) + pairwiseSum(a, start + n2, n - n2);
  }

  // Mean and population SD of a[start .. start+n-1].
  function meanStd(a, start, n) {
    const mean = (0.0 + pairwiseSum(a, start, n)) / n;
    const sq = new Array(n);
    for (let k = 0; k < n; k++) { const v = a[start + k] - mean; sq[k] = v * v; }
    return [mean, Math.sqrt((0.0 + pairwiseSum(sq, 0, n)) / n)];
  }

  // Median as NumPy computes it: middle value, or half the sum of the two middle values.
  function median(values) {
    const v = values.slice().sort(function (p, q) { return p - q; });
    const n = v.length, h = n >> 1;
    return n % 2 ? v[h] : (v[h - 1] + v[h]) / 2.0;
  }

  function isMissing(v) { return v === null || v === undefined || Number.isNaN(v); }

  function resolveSettings(overrides) {
    const s = {};
    for (const k of Object.keys(SETTINGS)) s[k] = SETTINGS[k];
    if (overrides) for (const k of Object.keys(overrides)) s[k] = overrides[k];
    return Object.freeze(s);
  }

  // Alert threshold on the logit scale. File S1 writes it as log(0.8 / 0.2).
  function alertLogit(pAlert) {
    return pAlert === 0.8 ? Math.log(0.8 / 0.2) : Math.log(pAlert / (1 - pAlert));
  }

  // ------------------------------------------------------------------ the squad filter
  /**
   * createSquad(ids, overrides) -> squad
   *   ids        athlete identifiers (strings), in a fixed order; one squad shares one daily median
   *   overrides  optional replacements of SETTINGS (used by tests only; the application runs the defaults)
   *
   * squad.step(day) processes the next calendar day (days are numbered from 0) and returns the day's results.
   *   day.load[i]         reported session load of athlete i in AU (sum of duration x RPE over the day's sessions,
   *                       0 for a reported rest day); NaN, null or undefined when no session load was reported
   *   day.hooper[i]       the four Hooper items [a, b, c, d], each 1 (best) to 7 (worst), or null when the athlete
   *                       did not give all four
   *   day.unavailable[i]  true when the athlete is injured, ill or in return to play (contributes zero load)
   */
  function createSquad(ids, overrides) {
    const S = resolveSettings(overrides);
    const N = ids.length;
    const ag = Math.exp(-1 / S.tauG), ah = Math.exp(-1 / S.tauH), rs = S.rhoS;
    const f = [ag, ah, rs];
    const b = [1 - ag, 1 - ah, 0.0];
    const q = [S.qG * S.qG, S.qH * S.qH, S.qS * S.qS];
    const thr = alertLogit(S.alertProbability);
    const lam = S.forget;
    const ath = [];
    for (let i = 0; i < N; i++) {
      ath.push({
        id: ids[i],
        x: [0.0, 0.0, 0.0],
        P: [[S.p0G, 0.0, 0.0], [0.0, S.p0H, 0.0], [0.0, 0.0, q[2] / (1 - rs * rs)]],
        theta: [S.theta0[0], S.theta0[1], S.theta0[2]],
        Pr: [[S.rlsP0[0], 0.0, 0.0], [0.0, S.rlsP0[1], 0.0], [0.0, 0.0, S.rlsP0[2]]],
        R: S.R0,
        dd: [],   // history of the deficit d = H - G
        ss: []    // history of the strain s
      });
    }
    let t = 0;

    function step(day) {
      // ---- imputation (EngineBank._impute): squad median of the day among available reporters
      const reporters = [];
      for (let i = 0; i < N; i++) {
        if (!day.unavailable[i] && !isMissing(day.load[i])) reporters.push(Number(day.load[i]));
      }
      const med = reporters.length ? median(reporters) : 0.0;
      const out = { t: t, squadMedian: med, reporters: reporters.length, athletes: new Array(N) };

      for (let i = 0; i < N; i++) {
        const a = ath[i];
        const unavailable = !!day.unavailable[i];
        const reported = !isMissing(day.load[i]);
        const u = unavailable ? 0.0 : (reported ? Number(day.load[i]) : med);
        const imputed = !reported && !unavailable;
        const ukau = u / S.auPerKau;
        const hoop = day.hooper ? day.hooper[i] : null;
        let have = false, y = NaN;
        if (hoop && hoop.length === 4 && !isMissing(hoop[0]) && !isMissing(hoop[1]) &&
            !isMissing(hoop[2]) && !isMissing(hoop[3])) {
          have = true;
          y = (((Number(hoop[0]) + Number(hoop[1])) + Number(hoop[2])) + Number(hoop[3])) / 4.0;
        }

        // ---- time update with today's reported or imputed load (Equation 7)
        let x0 = a.x[0] * f[0] + ukau * b[0];
        let x1 = a.x[1] * f[1] + ukau * b[1];
        let x2 = a.x[2] * f[2] + ukau * b[2];
        const P = a.P;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P[r][c] = (f[r] * P[r][c]) * f[c];
        const infl = imputed ? S.imputeInflation : 1.0;
        P[0][0] += q[0] * infl; P[1][1] += q[1] * infl; P[2][2] += q[2];

        let corrected = false;
        if (have) {
          const th = a.theta;
          // regressors of recursive least squares use the predicted load states; target net of predicted strain
          const phi = [1.0, x1, -x0];
          const yRls = y - x2;
          if (t >= S.correctionStartDay) {
            // ---- wellness correction (Equations 8 to 11)
            const H = [-th[2], th[1], 1.0];
            const yhat = th[0] + ((H[0] * x0 + H[1] * x1) + H[2] * x2);
            const e = y - yhat;
            const HP = [0, 0, 0];
            for (let c = 0; c < 3; c++) HP[c] = (H[0] * P[0][c] + H[1] * P[1][c]) + H[2] * P[2][c];
            const hph = (HP[0] * H[0] + HP[1] * H[1]) + HP[2] * H[2];
            const Sv = hph + a.R;
            const K = [HP[0] / Sv, HP[1] / Sv, HP[2] / Sv];
            x0 = x0 + K[0] * e; x1 = x1 + K[1] * e; x2 = x2 + K[2] * e;
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P[r][c] = P[r][c] - K[r] * HP[c];
            a.R = Math.max(S.rKeep * a.R + S.rGain * (e * e - hph), S.rFloor);
            corrected = true;
          }
          // ---- recursive least squares with forgetting (Equations 12 and 13)
          const Pr = a.Pr;
          const Pphi = [0, 0, 0];
          for (let r = 0; r < 3; r++) Pphi[r] = (Pr[r][0] * phi[0] + Pr[r][1] * phi[1]) + Pr[r][2] * phi[2];
          const den = lam + ((phi[0] * Pphi[0] + phi[1] * Pphi[1]) + phi[2] * Pphi[2]);
          const Kr = [Pphi[0] / den, Pphi[1] / den, Pphi[2] / den];
          const er = yRls - ((th[0] * phi[0] + th[1] * phi[1]) + th[2] * phi[2]);
          const t0 = th[0] + Kr[0] * er;
          let t1 = th[1] + Kr[1] * er;
          let t2 = th[2] + Kr[2] * er;
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Pr[r][c] = (Pr[r][c] - Kr[r] * Pphi[c]) / lam;
          t1 = Math.min(Math.max(t1, S.chMin), S.chMax);
          t2 = Math.min(Math.max(t2, S.cgMin), S.cgMax);
          a.theta = [t0, t1, t2];
        }
        a.x = [x0, x1, x2];

        // ---- posterior exceedance probability (Equation 14)
        const d = x1 - x0;
        const vd = P[0][0] + P[1][1] - 2 * P[0][1];
        const sdD = Math.sqrt(Math.max(vd, S.varFloor));
        const sdS = Math.sqrt(Math.max(P[2][2], S.varFloor));
        let p = null, logit = null, pD = null, pS = null, alert = false, base = null;
        if (t >= S.baselineStartDay) {
          const lo = Math.max(0, t - S.baselineWindow), n = t - lo;
          const md = meanStd(a.dd, lo, n), ms = meanStd(a.ss, lo, n);
          pD = normCdf((d - md[0] - S.kappa * md[1]) / sdD);
          pS = normCdf((x2 - ms[0] - S.kappa * ms[1]) / sdS);
          p = 1 - (1 - pD) * (1 - pS);
          p = Math.min(Math.max(p, S.pClip), 1 - S.pClip);
          logit = Math.log(p / (1 - p));
          // File S1 stores the score in single precision before comparing it with the threshold
          alert = Math.fround(logit) >= thr;
          base = { days: n, meanDeficit: md[0], sdDeficit: md[1], meanStrain: ms[0], sdStrain: ms[1] };
        }
        a.dd.push(d); a.ss.push(x2);

        out.athletes[i] = {
          id: a.id, t: t,
          unavailable: unavailable, reported: reported, imputed: imputed,
          load: u,                       // load used by the filter (AU): reported, squad median or zero
          hooperMean: have ? y : null,
          corrected: corrected,          // wellness correction applied today
          fitness: x0, fatigue: x1, strain: x2, deficit: d,
          sdDeficit: sdD, sdStrain: sdS,
          pDeficit: pD, pStrain: pS,
          probability: p, logit: logit, alert: alert,
          baseline: base,
          coefficients: [a.theta[0], a.theta[1], a.theta[2]],
          observationVariance: a.R
        };
      }
      t += 1;
      return out;
    }

    return {
      ids: ids.slice(),
      settings: S,
      step: step,
      get day() { return t; }
    };
  }

  /** runSquad(ids, days, overrides) -> array of daily results, one per element of days. */
  function runSquad(ids, days, overrides) {
    const squad = createSquad(ids, overrides);
    const res = new Array(days.length);
    for (let k = 0; k < days.length; k++) res[k] = squad.step(days[k]);
    return res;
  }

  // ------------------------------------------------------------------ alert budget
  /** Largest daily list for a number of healthy athletes: budget x healthy, halves rounded down, at least one. */
  function dailyCap(nHealthy, budget) {
    if (!(nHealthy > 0)) return 0;
    return Math.max(1, Math.ceil(budget * nHealthy - 0.5));
  }

  /**
   * alertBudget(athletes, options) ranks the healthy athletes of one day by posterior probability and caps
   * the daily list.
   *   athletes         the athletes array returned by squad.step
   *   options.enabled  false lists every healthy athlete at or above the alert threshold (default true)
   *   options.budget   share of healthy athlete-days on the list (default SETTINGS.alertBudget = 0.10,
   *                    about two athletes per day in a squad of 25)
   * Returns { enabled, budget, healthy, cap, ranking, listed, overflow } where ranking, listed and overflow hold
   * athlete identifiers ordered by decreasing probability. Unavailable athletes are never listed.
   */
  function alertBudget(athletes, options) {
    const o = options || {};
    const enabled = o.enabled !== false;
    const budget = o.budget === undefined || o.budget === null ? SETTINGS.alertBudget : o.budget;
    const healthy = [];
    for (let i = 0; i < athletes.length; i++) if (!athletes[i].unavailable) healthy.push({ a: athletes[i], k: i });
    const scored = healthy.filter(function (h) { return h.a.probability !== null; });
    scored.sort(function (p, q) {
      return (q.a.probability - p.a.probability) || (q.a.logit - p.a.logit) || (p.k - q.k);
    });
    const above = scored.filter(function (h) { return h.a.alert; });
    const cap = enabled ? dailyCap(healthy.length, budget) : above.length;
    return {
      enabled: enabled,
      budget: budget,
      healthy: healthy.length,
      cap: cap,
      ranking: scored.map(function (h) { return h.a.id; }),
      listed: above.slice(0, cap).map(function (h) { return h.a.id; }),
      overflow: above.slice(cap).map(function (h) { return h.a.id; })
    };
  }

  return {
    VERSION: VERSION,
    SETTINGS: SETTINGS,
    createSquad: createSquad,
    runSquad: runSquad,
    alertBudget: alertBudget,
    dailyCap: dailyCap,
    normCdf: normCdf,
    _internal: { erf: erf, erfc: erfc, pairwiseSum: pairwiseSum, meanStd: meanStd, median: median, alertLogit: alertLogit }
  };
});
