// The daily health item, the weekly Oslo questionnaire and the health gate are unchanged: the ingest and the health
// module of the application core must return what the Python core of the rule-based prototype returns.
// The reference outputs (fixtures/health_gate_ref.json) were produced by running the prototype, unchanged, from its
// git tag; parity/mk_health_gate_ref.py writes them and also compares both whole datasets.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HBODCore = require('../app/src/core.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const ref = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'health_gate_ref.json'), 'utf8'));
const HEALTH_KEYS = ['pain', 'location', 'severity', 'substantial', 'cannot', 'flagged', 'action', 'text', 'reason'];

function load(dataset) {
  const text = fs.readFileSync(path.join(FIXTURES, dataset.file), 'utf8');
  return HBODCore.toRecords(HBODCore.parseCSV(text));
}
function asRow(r) {
  return [r.date, r.athlete, r.moment, r.duration, r.intensity, r.fatigue, r.stress, r.soreness, r.sleep, r.pain,
    r.painLocation, r.ostrc[0], r.ostrc[1], r.ostrc[2], r.ostrc[3], r.sessionLoad];
}
function asState(h) { return HEALTH_KEYS.map((k) => h[k]); }

// ------------------------------------------------------------------ ingest functions, one answer at a time
test('numbers are read as the prototype reads them', () => {
  assert.ok(ref.vectors.to_float.length >= 40);
  for (const [input, expected] of ref.vectors.to_float) {
    assert.deepEqual(HBODCore.toFloat(input), expected, `toFloat(${JSON.stringify(input)})`);
  }
  assert.equal(HBODCore.toFloat(null), null);
  assert.equal(HBODCore.toFloat(undefined), null);
});

test('yes/no answers in French, Arabic and English are read as the prototype reads them', () => {
  assert.ok(ref.vectors.yes_no.length >= 30);
  for (const [input, expected] of ref.vectors.yes_no) {
    assert.equal(HBODCore.yesNo(input), expected, `yesNo(${JSON.stringify(input)})`);
  }
  assert.equal(HBODCore.yesNo(null), null);
});

test('timestamps are read as the prototype reads them, with the same order of formats', () => {
  assert.ok(ref.vectors.parse_date.length >= 60);
  for (const [input, expected] of ref.vectors.parse_date) {
    assert.equal(HBODCore.parseDate(input), expected, `parseDate(${JSON.stringify(input)})`);
  }
  assert.equal(HBODCore.parseDate(null), null);
  assert.deepEqual(Array.from(HBODCore.DATE_FORMATS), [
    '%Y/%m/%d %I:%M:%S %p', '%m/%d/%Y %I:%M:%S %p', '%d/%m/%Y %I:%M:%S %p', '%Y-%m-%d %H:%M:%S',
    '%Y/%m/%d %H:%M:%S', '%d/%m/%Y %H:%M:%S', '%m/%d/%Y %H:%M:%S', '%Y-%m-%d', '%Y/%m/%d', '%d/%m/%Y',
    '%m/%d/%Y', '%Y-%m-%d %I:%M:%S %p']);
});

test('Oslo item scores are 0, 8, 17 or 25 from the option text, or the number given', () => {
  assert.ok(ref.vectors.ostrc_score.length >= 30);
  for (const [input, expected] of ref.vectors.ostrc_score) {
    assert.equal(HBODCore.ostrcScore(input), expected, `ostrcScore(${JSON.stringify(input)})`);
  }
  assert.deepEqual(Array.from(new Set(Object.values(HBODCore.OSTRC_LABELS))).sort((a, b) => a - b), [0, 8, 17, 25]);
  assert.equal(Object.keys(HBODCore.OSTRC_LABELS).length, 15);
});

test('columns are matched as the prototype matches them', () => {
  for (const [header, expected] of ref.vectors.match_columns) {
    const found = HBODCore.matchColumns(header);
    delete found.availability;                     // the only field the prototype did not have
    assert.deepEqual(found, expected, JSON.stringify(header));
  }
  // the sixteen fields of the prototype, in its order and with its header fragments
  const fields = Object.keys(HBODCore.COLMAP);
  assert.deepEqual(fields.slice(0, 16), ['timestamp', 'email', 'athlete', 'moment', 'duration', 'intensity', 'fatigue',
    'stress', 'soreness', 'sleep', 'pain', 'pain_location', 'ostrc_q1', 'ostrc_q2', 'ostrc_q3', 'ostrc_q4']);
  assert.deepEqual(fields.slice(16), ['availability']);
  assert.deepEqual(HBODCore.COLMAP.athlete, ['qui es', 'player', 'nageur', 'swimmer', 'athlete', 'name', 'nom']);
  assert.deepEqual(HBODCore.COLMAP.pain, ['douleur', 'gêne', 'gene specifique', 'pain', 'health problem']);
});

// ------------------------------------------------------------------ whole files against the prototype
for (const key of Object.keys(ref.datasets)) {
  const dataset = ref.datasets[key];

  test(`${key}: every record is read as the prototype reads it`, () => {
    const records = load(dataset);
    assert.equal(records.length, dataset.records.length);
    records.forEach((r, k) => assert.deepEqual(asRow(r), dataset.records[k], `record ${k + 1}`));
  });

  test(`${key}: health status and gate identical to the prototype for every athlete on every day`, () => {
    const records = load(dataset);
    const athletes = Array.from(new Set(records.map((r) => r.athlete).filter(Boolean))).sort(HBODCore.compareText);
    assert.deepEqual(athletes, dataset.athletes);
    let compared = 0;
    const seen = new Set();
    for (const a of athletes) {
      dataset.dates.forEach((d, t) => {
        const expected = dataset.states[dataset.health[a][t]];
        const h = HBODCore.applyHealthGate(HBODCore.healthStatus(records, a, d));
        assert.deepEqual(asState(h), expected, `${a} on ${d}`);
        seen.add(h.action);
        compared += 1;
      });
    }
    assert.equal(compared, dataset.athletes.length * dataset.dates.length);
    if (key !== 'S5') assert.deepEqual(Array.from(seen).sort(), ['HOLD', 'REFER', 'STOP', null]);
  });

  test(`${key}: the day report carries the same health gate, shown first`, () => {
    const records = load(dataset);
    const analysis = HBODCore.analyse(records);
    assert.deepEqual(analysis.athletes, dataset.athletes);
    assert.deepEqual(analysis.dates, dataset.dates);
    dataset.dates.forEach((d, t) => {
      const report = HBODCore.dayReport(analysis, d);
      let gated = 0;
      for (const a of report.athletes) {
        assert.deepEqual(asState(a.health), dataset.states[dataset.health[a.name][t]], `${a.name} on ${d}`);
        if (a.health.action !== null) gated += 1;
      }
      assert.equal(report.counts.healthGate, gated);
      // health-gate athletes come first, in the order STOP, REFER, HOLD
      const order = report.athletes.map((a) => ['STOP', 'REFER', 'HOLD', null].indexOf(a.health.action));
      for (let k = 1; k < order.length; k++) assert.ok(order[k - 1] <= order[k], `display order on ${d}`);
    });
  });
}

test('the fixtures cover what they are meant to cover', () => {
  const s5 = ref.datasets.S5, s6 = ref.datasets.S6_slice, cases = ref.datasets.cases;
  assert.equal(s5.records.length, 120);
  assert.equal(s5.athletes.length * s5.dates.length, 140);
  assert.equal(s6.athletes_with_answers.length, 6);
  assert.equal(s6.athletes_without.length, 2);
  // Oslo answers as option text in the S6 slice, as numbers in S5
  const text = fs.readFileSync(path.join(FIXTURES, s6.file), 'utf8');
  for (const label of ['Could not participate', 'Reduced participation', 'To a moderate extent', 'Severe', 'Yes']) {
    assert.ok(text.includes(label), label);
  }
  assert.ok(cases.states.some((s) => s[2] === 0 && s[5] === false));          // severity 0.5 rounds to 0: no flag
  assert.ok(cases.records.some((r) => r[0] === null));                        // a row without a readable date
});

// ------------------------------------------------------------------ the rules, stated directly
function record(date, athlete, fields) {
  return Object.assign({ date: date, athlete: athlete, moment: '', duration: 60, intensity: 5, sessionLoad: 300,
    fatigue: 2, stress: 2, soreness: 2, sleep: 2, pain: null, painLocation: null, ostrc: [null, null, null, null],
    availability: null }, fields || {});
}

test('texts of the three tiers are those of the prototype', () => {
  assert.equal(HBODCore.HEALTH_TEXT.STOP,
    'Immediate stop: no training today; arrange an urgent medical assessment before any return to load.');
  assert.equal(HBODCore.HEALTH_TEXT.REFER,
    'Reduce and refer: cut load and refer the athlete to the medical staff; do not progress until the problem ' +
    'resolves.');
  assert.equal(HBODCore.HEALTH_TEXT.HOLD,
    'Hold, not increase: an athlete-reported health problem is present; keep the load and monitor.');
});

test('the weekly questionnaire counts for seven days and the most recent one wins', () => {
  const recs = [
    record('2026-03-02', 'A', { ostrc: [8, 0, 0, 8] }),
    record('2026-03-06', 'A', { ostrc: [17, 8, 0, 8] }),
    record('2026-03-20', 'A'),
  ];
  const at = (d) => HBODCore.applyHealthGate(HBODCore.healthStatus(recs, 'A', d));
  assert.equal(at('2026-03-01').severity, null);
  assert.equal(at('2026-03-01').action, null);
  assert.equal(at('2026-03-02').severity, 16);
  assert.equal(at('2026-03-05').action, 'HOLD');
  assert.equal(at('2026-03-06').severity, 33);
  assert.equal(at('2026-03-06').action, 'REFER');
  assert.equal(at('2026-03-13').severity, 33);             // seven days later: still counted
  assert.equal(at('2026-03-14').severity, null);           // eight days later: no longer counted
  assert.equal(at('2026-03-14').flagged, false);
});

test('substantial from 17 and cannot from 25 on the first three items only', () => {
  const gate = (ostrc, pain) => HBODCore.applyHealthGate(HBODCore.healthStatus(
    [record('2026-03-02', 'A', { ostrc: ostrc, pain: pain === undefined ? false : pain })], 'A', '2026-03-02'));
  assert.deepEqual([gate([0, 0, 0, 25]).substantial, gate([0, 0, 0, 25]).cannot, gate([0, 0, 0, 25]).action],
    [false, false, 'HOLD']);
  assert.equal(gate([8, 8, 8, 8]).action, 'HOLD');
  assert.equal(gate([16, 16, 16, 0]).action, 'HOLD');
  assert.equal(gate([0, 17, 0, 0]).action, 'REFER');
  assert.equal(gate([0, 0, 17, 0]).action, 'REFER');
  assert.equal(gate([0, 0, 25, 0]).action, 'STOP');
  assert.equal(gate([25, 0, 0, 0]).action, 'STOP');
  assert.equal(gate([0, 0, 0, 0]).action, null);
  assert.equal(gate([0, 0, 0, 0], true).action, 'HOLD');   // pain alone holds
  assert.equal(gate([null, null, null, null], true).severity, null);
  assert.equal(gate([null, 8, null, null]).severity, 8);   // items left empty count as zero
});

test('the reason line carries the location and the severity', () => {
  const recs = [record('2026-03-02', 'A', { pain: true, painLocation: 'Knee', ostrc: [25, 25, 17, 17] })];
  const h = HBODCore.applyHealthGate(HBODCore.healthStatus(recs, 'A', '2026-03-02'));
  assert.equal(h.action, 'STOP');
  assert.equal(h.text, HBODCore.HEALTH_TEXT.STOP);
  assert.equal(h.reason,
    'could not participate (Knee), OSTRC severity 84: STOP, do not train, urgent medical assessment');
  const none = HBODCore.applyHealthGate(HBODCore.healthStatus(recs, 'B', '2026-03-02'));
  assert.deepEqual(asState(none), [false, null, null, false, false, false, null, null, null]);
});

test('the gate does not depend on the probability, the alert budget or availability', () => {
  const dataset = ref.datasets.S6_slice;
  const records = load(dataset);
  const last = dataset.dates[dataset.dates.length - 1];
  const gates = (options) => {
    const report = HBODCore.dayReport(HBODCore.analyse(records, options), last);
    return report.athletes.map((a) => [a.name, a.health.action, a.health.severity]).sort();
  };
  const usual = gates();
  assert.ok(usual.some((g) => g[1] === 'STOP'));
  assert.deepEqual(gates({ budget: { enabled: false } }), usual);
  assert.deepEqual(gates({ budget: { enabled: true, share: 0.5 } }), usual);
  const injured = dataset.athletes.map((a) => ({ athlete: a, from: dataset.dates[0], to: last, reason: 'injured' }));
  assert.deepEqual(gates({ availability: injured }), usual);
  // an unavailable athlete with a declared problem is still shown first
  const report = HBODCore.dayReport(HBODCore.analyse(records, { availability: injured }), last);
  assert.equal(report.athletes[0].health.action, 'STOP');
  assert.equal(report.athletes[0].status, 'unavailable');
  assert.equal(report.counts.healthGate, usual.filter((g) => g[1] !== null).length);
});
