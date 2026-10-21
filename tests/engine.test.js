// Tests of the HBOD state-space engine (app/src/engine.js): the settings of Table S2, the behaviours the paper
// states for missing reports, unavailable athletes, the wellness correction, the personal baseline, the alert and
// the alert rate, and a golden comparison with File S1 that needs no Python (fixtures/engine_golden.json,
// written by parity/mk_golden.py).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HBODEngine = require('../app/src/engine.js');

const S = HBODEngine.SETTINGS;

// One day of inputs for a squad; Hooper items and availability default to "none given" and "all available".
function day(load, hooper, unavailable) {
  return {
    load: load,
    hooper: hooper || load.map(() => null),
    unavailable: unavailable || load.map(() => false),
  };
}

// A plain training week in AU (Monday to Sunday), shifted a little for each athlete.
const WEEK = [300, 0, 520, 480, 400, 200, 640];
function weekLoad(t, i) { return WEEK[t % 7] === 0 ? 0 : WEEK[t % 7] + 10 * i; }

// ------------------------------------------------------------------ settings
test('settings are those of Table S2', () => {
  assert.equal(S.tauG, 42);
  assert.equal(S.tauH, 7);
  assert.equal(S.rhoS, 0.8);
  assert.deepEqual([S.qG, S.qH, S.qS], [0.005, 0.03, 0.30]);
  assert.deepEqual([S.p0G, S.p0H], [0.05, 0.05]);
  assert.deepEqual(Array.from(S.theta0), [3.5, 1.0, 0.3]);
  assert.deepEqual(Array.from(S.rlsP0), [1, 4, 4]);
  assert.equal(S.forget, 0.99);
  assert.deepEqual([S.chMin, S.chMax, S.cgMin, S.cgMax], [0.1, 5, 0, 5]);
  assert.equal(S.R0, 0.5);
  assert.deepEqual([S.rKeep, S.rGain, S.rFloor], [0.95, 0.05, 0.05]);
  assert.equal(S.correctionStartDay, 14);
  assert.equal(S.baselineStartDay, 28);
  assert.equal(S.baselineWindow, 42);
  assert.equal(S.kappa, 1);
  assert.equal(S.alertProbability, 0.80);
  assert.equal(S.imputeInflation, 4);
  assert.equal(S.alertBudget, 0.10);
  assert.ok(Object.isFrozen(S));
});

test('three states start at zero and follow the transition matrix of Table S2', () => {
  const out = HBODEngine.runSquad(['a'], [day([1000]), day([0])]);
  const a0 = out[0].athletes[0], a1 = out[1].athletes[0];
  assert.equal(a0.fitness, 1 - Math.exp(-1 / 42));          // load enters in kAU
  assert.equal(a0.fatigue, 1 - Math.exp(-1 / 7));
  assert.equal(a0.strain, 0);
  assert.equal(a0.deficit, a0.fatigue - a0.fitness);
  assert.equal(a1.fitness, a0.fitness * Math.exp(-1 / 42));
  assert.equal(a1.fatigue, a0.fatigue * Math.exp(-1 / 7));
  // initial covariance diag(0.05, 0.05, 0.25): the strain variance stays at 0.8^2 x 0.25 + 0.30^2 = 0.25
  assert.ok(Math.abs(a0.sdStrain - 0.5) < 1e-15);
  const v = Math.exp(-2 / 42) * 0.05 + 0.005 ** 2 + Math.exp(-2 / 7) * 0.05 + 0.03 ** 2;
  assert.ok(Math.abs(a0.sdDeficit ** 2 - v) < 1e-15);
});

// ------------------------------------------------------------------ requirement 4: missing reports
test('a missing session load is replaced by the squad median of that day', () => {
  const odd = HBODEngine.createSquad(['a', 'b', 'c', 'd']).step(day([100, 300, 200, null]));
  assert.equal(odd.squadMedian, 200);
  assert.equal(odd.reporters, 3);
  assert.equal(odd.athletes[3].load, 200);
  assert.equal(odd.athletes[3].imputed, true);
  assert.equal(odd.athletes[3].reported, false);

  const even = HBODEngine.createSquad(['a', 'b', 'c', 'd', 'e']).step(day([100, NaN, 400, 200, 300]));
  assert.equal(even.squadMedian, 250);                     // half the sum of the two middle values
  assert.equal(even.athletes[1].load, 250);
  for (const k of [0, 2, 3, 4]) {
    assert.equal(even.athletes[k].imputed, false);
    assert.equal(even.athletes[k].reported, true);
  }
  assert.deepEqual(even.athletes.map((a) => a.load), [100, 250, 400, 200, 300]);
});

test('a missing day is never treated as rest', () => {
  const out = HBODEngine.createSquad(['reported', 'rest', 'missing']).step(day([400, 0, null]));
  const [reported, rest, missing] = out.athletes;
  assert.equal(rest.load, 0);
  assert.equal(rest.reported, true);                       // a reported rest day is a report of zero
  assert.equal(rest.imputed, false);
  assert.equal(missing.load, 200);                         // median of 400 and 0
  assert.ok(missing.fatigue > rest.fatigue);
  assert.ok(missing.fitness > rest.fitness);
  assert.ok(reported.fatigue > missing.fatigue);
});

test('on a day with an imputed load the process-noise variances of fitness and fatigue are multiplied by four', () => {
  // the first athlete reports exactly the value that is imputed for the second one
  const out = HBODEngine.createSquad(['reported', 'missing', 'other']).step(day([200, null, 200]));
  const [reported, missing] = out.athletes;
  assert.equal(missing.load, reported.load);
  assert.equal(missing.fitness, reported.fitness);
  assert.equal(missing.fatigue, reported.fatigue);
  const extra = missing.sdDeficit ** 2 - reported.sdDeficit ** 2;
  assert.ok(Math.abs(extra - 3 * (S.qG ** 2 + S.qH ** 2)) < 1e-15, `extra variance ${extra}`);
  assert.equal(missing.sdStrain, reported.sdStrain);       // the strain variance is not inflated
});

test('uncertainty keeps widening over consecutive missing days and is never set to zero', () => {
  const days = [];
  for (let t = 0; t < 10; t++) days.push(day([300, t < 3 ? 300 : null, 300]));
  const out = HBODEngine.runSquad(['a', 'b', 'c'], days);
  for (let t = 3; t < 10; t++) {
    const [a, b] = out[t].athletes;
    assert.equal(b.imputed, true);
    assert.equal(b.load, 300);
    assert.ok(b.sdDeficit > a.sdDeficit, `day ${t}`);
    assert.ok(b.sdDeficit > 0);
    if (t > 3) {
      const before = out[t - 1].athletes;
      assert.ok(b.sdDeficit - a.sdDeficit > before[1].sdDeficit - before[0].sdDeficit, `gap grows on day ${t}`);
    }
  }
});

test('when no available athlete reports, the squad median is zero and the loads are still marked as imputed', () => {
  const out = HBODEngine.createSquad(['a', 'b']).step(day([null, undefined]));
  assert.equal(out.reporters, 0);
  assert.equal(out.squadMedian, 0);
  assert.deepEqual(out.athletes.map((a) => [a.load, a.imputed]), [[0, true], [0, true]]);
});

test('an unavailable athlete contributes zero load and is left out of the squad median', () => {
  const out = HBODEngine.createSquad(['a', 'b', 'c', 'injured', 'silent'])
    .step(day([100, 200, 300, 9000, null], null, [false, false, false, true, true]));
  assert.equal(out.squadMedian, 200);                      // 9000 is not part of the median
  assert.equal(out.reporters, 3);
  const injured = out.athletes[3], silent = out.athletes[4];
  for (const a of [injured, silent]) {
    assert.equal(a.unavailable, true);
    assert.equal(a.load, 0);
    assert.equal(a.imputed, false);
    assert.equal(a.fitness, 0);
    assert.equal(a.fatigue, 0);
  }
  // no imputation, so no inflation: same uncertainty as an athlete who reported
  assert.equal(silent.sdDeficit, out.athletes[0].sdDeficit);
});

// ------------------------------------------------------------------ requirement 2: correction, baseline, alert
test('the wellness correction starts on day 14 and needs all four Hooper items', () => {
  const ids = ['all', 'three', 'none'];
  const days = [];
  for (let t = 0; t < 30; t++) {
    days.push(day(ids.map((_, i) => weekLoad(t, i)), [[2, 3, 2, 3], [2, 3, 2, null], null]));
  }
  const out = HBODEngine.runSquad(ids, days);
  out.forEach((d, t) => {
    const [all, three, none] = d.athletes;
    assert.equal(all.corrected, t >= 14, `day ${t}`);
    assert.equal(all.hooperMean, 2.5);
    assert.equal(three.corrected, false);
    assert.equal(three.hooperMean, null);
    assert.equal(none.corrected, false);
    assert.equal(none.hooperMean, null);
    // without the four items nothing is learned and the observation variance is carried forward
    assert.deepEqual(three.coefficients, [3.5, 1.0, 0.3]);
    assert.equal(three.observationVariance, 0.5);
    assert.equal(none.strain, 0);
    // the observation variance starts at 0.5 and adapts only from the first correction
    if (t < 14) assert.equal(all.observationVariance, 0.5);
    assert.ok(all.observationVariance >= 0.05);
    // recursive least squares learns the athlete's coefficients on every day with a full report, within bounds
    assert.notDeepEqual(all.coefficients, [3.5, 1.0, 0.3]);
    assert.ok(all.coefficients[1] >= 0.1 && all.coefficients[1] <= 5);
    assert.ok(all.coefficients[2] >= 0 && all.coefficients[2] <= 5);
  });
  assert.notEqual(out[14].athletes[0].observationVariance, 0.5);
  assert.equal(out[13].athletes[0].strain, 0);             // prediction only before day 14
  assert.notEqual(out[14].athletes[0].strain, 0);
});

test('no probability before day 28, then a baseline of up to 42 previous days', () => {
  const ids = ['a', 'b', 'c'];
  const days = [];
  for (let t = 0; t < 80; t++) days.push(day(ids.map((_, i) => weekLoad(t, i)), ids.map(() => [2, 2, 3, 2])));
  const out = HBODEngine.runSquad(ids, days);
  out.forEach((d, t) => {
    for (const a of d.athletes) {
      if (t < 28) {
        assert.equal(a.probability, null);
        assert.equal(a.logit, null);
        assert.equal(a.pDeficit, null);
        assert.equal(a.pStrain, null);
        assert.equal(a.baseline, null);
        assert.equal(a.alert, false);
      } else {
        assert.equal(typeof a.probability, 'number');
        assert.ok(a.probability > 0 && a.probability < 1);
        assert.equal(a.baseline.days, Math.min(t, 42));
      }
    }
  });
});

test('the probability is the posterior exceedance of the personal baseline (Equation 14)', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const days = [];
  for (let t = 0; t < 75; t++) {
    days.push(day(ids.map((_, i) => (i === 3 && t % 5 === 0 ? null : weekLoad(t, i))),
      ids.map((_, i) => [2 + ((t + i) % 3), 2, 3 + (t % 2), 2])));
  }
  const out = HBODEngine.runSquad(ids, days);
  const deficits = ids.map(() => []), strains = ids.map(() => []);
  out.forEach((d, t) => {
    d.athletes.forEach((a, i) => {
      if (t >= 28) {
        // baseline: mean and population SD of the previous days, up to 42 of them
        const lo = Math.max(0, t - 42);
        const stats = (v) => {
          const w = v.slice(lo, t), m = w.reduce((x, y) => x + y, 0) / w.length;
          return [m, Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / w.length)];
        };
        const [md, sd] = stats(deficits[i]), [ms, ss] = stats(strains[i]);
        assert.ok(Math.abs(a.baseline.meanDeficit - md) < 1e-12);
        assert.ok(Math.abs(a.baseline.sdDeficit - sd) < 1e-12);
        assert.ok(Math.abs(a.baseline.meanStrain - ms) < 1e-12);
        assert.ok(Math.abs(a.baseline.sdStrain - ss) < 1e-12);
        const pD = HBODEngine.normCdf((a.deficit - md - S.kappa * sd) / a.sdDeficit);
        const pS = HBODEngine.normCdf((a.strain - ms - S.kappa * ss) / a.sdStrain);
        assert.ok(Math.abs(a.pDeficit - pD) < 1e-9);
        assert.ok(Math.abs(a.pStrain - pS) < 1e-9);
        assert.ok(Math.abs(a.probability - (1 - (1 - a.pDeficit) * (1 - a.pStrain))) < 1e-12);
        assert.ok(a.probability >= Math.max(a.pDeficit, a.pStrain) - 1e-12);
      }
      deficits[i].push(a.deficit); strains[i].push(a.strain);
    });
  });
});

test('an alert is raised when the probability reaches 0.80', () => {
  // one athlete's Hooper items worsen sharply on day 40; the others stay as they were
  const ids = ['steady', 'worse', 'c', 'd'];
  const days = [];
  for (let t = 0; t < 50; t++) {
    days.push(day(ids.map((_, i) => weekLoad(t, i)),
      ids.map((_, i) => (i === 1 && t >= 40 ? [7, 6, 7, 6] : [2, 2, 2, 2]))));
  }
  const out = HBODEngine.runSquad(ids, days);
  const threshold = Math.log(0.8 / 0.2);
  let alerts = 0;
  out.forEach((d) => {
    for (const a of d.athletes) {
      if (a.probability === null) { assert.equal(a.alert, false); continue; }
      assert.equal(a.alert, Math.fround(a.logit) >= threshold);
      if (a.probability >= 0.8 + 1e-6) assert.equal(a.alert, true);
      if (a.probability < 0.8 - 1e-6) assert.equal(a.alert, false);
      if (a.alert) alerts += 1;
    }
  });
  assert.ok(alerts > 0);
  const worse = out[40].athletes[1];
  assert.equal(worse.alert, true);
  assert.ok(worse.probability >= 0.8);
  assert.ok(worse.pStrain > worse.pDeficit);               // driven by the wellness strain
  assert.equal(out[39].athletes[1].alert, false);
  assert.equal(out[40].athletes[0].alert, false);
});

test('the standard normal distribution function', () => {
  assert.equal(HBODEngine.normCdf(0), 0.5);
  assert.ok(Math.abs(HBODEngine.normCdf(1.959963984540054) - 0.975) < 1e-15);
  assert.ok(Math.abs(HBODEngine.normCdf(-1) + HBODEngine.normCdf(1) - 1) < 1e-15);
  assert.ok(Math.abs(HBODEngine.normCdf(0.8416212335729143) - 0.8) < 1e-15);
  assert.equal(HBODEngine.normCdf(-40), 0);
  assert.equal(HBODEngine.normCdf(40), 1);
});

// ------------------------------------------------------------------ requirement 5: alert rate
function athlete(id, probability, unavailable) {
  const p = probability;
  return {
    id: id, unavailable: !!unavailable, probability: p,
    logit: p === null ? null : Math.log(p / (1 - p)),
    alert: p !== null && p >= 0.8,
  };
}

test('the daily cap is about 10% of healthy athletes: two per day for 21 and for 25 healthy athletes', () => {
  assert.equal(HBODEngine.dailyCap(21, 0.10), 2);
  assert.equal(HBODEngine.dailyCap(25, 0.10), 2);
  assert.equal(HBODEngine.dailyCap(26, 0.10), 3);
  assert.equal(HBODEngine.dailyCap(15, 0.10), 1);          // halves are rounded down
  assert.equal(HBODEngine.dailyCap(35, 0.10), 3);
  assert.equal(HBODEngine.dailyCap(4, 0.10), 1);           // at least one
  assert.equal(HBODEngine.dailyCap(0, 0.10), 0);
  assert.equal(HBODEngine.dailyCap(25, 0.20), 5);
  assert.equal(HBODEngine.dailyCap(25, 0.05), 1);
});

test('the alert rate ranks healthy athletes by probability and caps the daily list', () => {
  const squad = [];
  for (let i = 0; i < 25; i++) squad.push(athlete('P' + String(i).padStart(2, '0'), 0.10 + 0.01 * i));
  squad[3] = athlete('P03', 0.97);
  squad[7] = athlete('P07', 0.85);
  squad[11] = athlete('P11', 0.99);
  squad[20] = athlete('P20', 0.91);
  squad[24] = athlete('P24', null);                        // baseline still building
  const b = HBODEngine.alertBudget(squad);
  assert.equal(b.enabled, true);
  assert.equal(b.budget, 0.10);
  assert.equal(b.healthy, 25);
  assert.equal(b.cap, 2);
  assert.deepEqual(b.listed, ['P11', 'P03']);
  assert.deepEqual(b.overflow, ['P20', 'P07']);
  assert.equal(b.ranking.length, 24);                      // every healthy athlete with a probability
  assert.deepEqual(b.ranking.slice(0, 5), ['P11', 'P03', 'P20', 'P07', 'P23']);
  const byId = new Map(squad.map((a) => [a.id, a.probability]));
  for (let k = 1; k < b.ranking.length; k++) assert.ok(byId.get(b.ranking[k - 1]) >= byId.get(b.ranking[k]));
  assert.ok(!b.ranking.includes('P24'));
});

test('unavailable athletes are never listed and do not count as healthy', () => {
  const squad = [];
  for (let i = 0; i < 25; i++) squad.push(athlete('P' + String(i).padStart(2, '0'), 0.2));
  squad[0] = athlete('P00', 0.999, true);                  // highest probability, but injured
  squad[1] = athlete('P01', 0.95);
  squad[2] = athlete('P02', 0.90, true);
  squad[3] = athlete('P03', 0.85);
  squad[4] = athlete('P04', 0.82);
  squad[5] = athlete('P05', 0.2, true);
  squad[6] = athlete('P06', 0.2, true);
  const b = HBODEngine.alertBudget(squad);
  assert.equal(b.healthy, 21);
  assert.equal(b.cap, 2);
  assert.deepEqual(b.listed, ['P01', 'P03']);
  assert.deepEqual(b.overflow, ['P04']);
  for (const id of ['P00', 'P02', 'P05', 'P06']) assert.ok(!b.ranking.includes(id));
});

test('the budget can be changed or switched off', () => {
  const squad = [];
  for (let i = 0; i < 20; i++) squad.push(athlete('P' + String(i).padStart(2, '0'), i < 6 ? 0.99 - 0.01 * i : 0.3));
  const wide = HBODEngine.alertBudget(squad, { budget: 0.20 });
  assert.equal(wide.cap, 4);
  assert.deepEqual(wide.listed, ['P00', 'P01', 'P02', 'P03']);
  assert.deepEqual(wide.overflow, ['P04', 'P05']);
  const off = HBODEngine.alertBudget(squad, { enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.listed, ['P00', 'P01', 'P02', 'P03', 'P04', 'P05']);
  assert.deepEqual(off.overflow, []);
  // the list is never longer than the number of athletes at or above the threshold
  const quiet = HBODEngine.alertBudget(squad.map((a) => athlete(a.id, 0.5)));
  assert.equal(quiet.cap, 2);
  assert.deepEqual(quiet.listed, []);
});

test('the budget is applied to the engine output of a simulated day', () => {
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push('P' + String(i).padStart(2, '0'));
  const days = [];
  for (let t = 0; t < 45; t++) {
    days.push(day(ids.map((_, i) => weekLoad(t, i)),
      ids.map((_, i) => (t >= 40 && i < 6 ? [7, 7, 6, 7 - (i % 2)] : [2, 2, 2, 2])),
      ids.map((_, i) => i === 0 && t >= 38)));
  }
  const out = HBODEngine.runSquad(ids, days);
  const today = out[40];
  const b = HBODEngine.alertBudget(today.athletes);
  assert.equal(today.athletes[0].alert, true);             // above the threshold, but unavailable
  assert.equal(b.healthy, 24);
  assert.equal(b.cap, 2);
  assert.equal(b.listed.length, 2);
  assert.equal(b.overflow.length, 3);
  assert.ok(!b.listed.includes('P00') && !b.overflow.includes('P00'));
  const p = new Map(today.athletes.map((a) => [a.id, a.probability]));
  const lowestListed = Math.min(...b.listed.map((id) => p.get(id)));
  for (const id of b.overflow) assert.ok(p.get(id) <= lowestListed);
});

// ------------------------------------------------------------------ golden comparison with File S1
test('golden: probabilities within 1e-9 of File S1 and identical alert decisions', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engine_golden.json'), 'utf8'));
  const N = golden.athletes, T = golden.days;
  assert.equal(N, 25);
  assert.equal(T, 238);
  assert.equal(golden.threshold_logit, Math.log(0.8 / 0.2));
  const ids = golden.load.map((_, i) => 'A' + String(i + 1).padStart(2, '0'));
  const days = [];
  for (let t = 0; t < T; t++) {
    days.push({
      load: golden.load.map((row) => row[t]),
      hooper: golden.hooper.map((row) => {
        const items = row.slice(4 * t, 4 * t + 4);
        return items === '----' ? null : Array.from(items, Number);
      }),
      unavailable: golden.unavailable.map((row) => row[t] === '1'),
    });
  }
  const out = HBODEngine.runSquad(ids, days);
  let maxDiff = 0, scored = 0, sameAlert = 0, alerts = 0;
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) {
      const a = out[t].athletes[i], ref = golden.p[i][t];
      assert.equal(a.probability === null, ref === null, `athlete ${i}, day ${t}`);
      if (ref !== null) { scored += 1; maxDiff = Math.max(maxDiff, Math.abs(a.probability - ref)); }
      if (a.alert === (golden.alert[i][t] === '1')) sameAlert += 1;
      if (a.alert) alerts += 1;
    }
  }
  assert.equal(scored, N * (T - 28));
  assert.ok(maxDiff < 1e-9, `maximum absolute difference ${maxDiff}`);
  assert.equal(sameAlert, N * T);
  assert.equal(alerts, golden.alert.join('').split('1').length - 1);
  assert.ok(alerts > 0);
});
