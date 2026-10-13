// Runs the ingest and the health module of the application core on the two synthetic datasets of the rule-based
// prototype, read from the git tag v0.1.0-rule-based-prototype with `git show`.
// Run from inside this folder:  node health_gate.js
// Writes js_health_gate.json for:  python mk_health_gate_ref.py js_health_gate.json
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const HBODCore = require(path.join(__dirname, '..', 'app', 'src', 'core.js'));

const TAG = 'v0.1.0-rule-based-prototype';
const ROOT = path.join(__dirname, '..');
const DATASETS = { S5: 'validation/S5_validation_dataset.csv', S6: 'data/S6_cohort_football_100.csv' };

const datasets = {};
let athleteDays = 0;
for (const key of Object.keys(DATASETS)) {
  const text = execFileSync('git', ['-C', ROOT, 'show', `${TAG}:${DATASETS[key]}`],
    { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const records = HBODCore.toRecords(HBODCore.parseCSV(text));
  const athletes = Array.from(new Set(records.map((r) => r.athlete).filter(Boolean))).sort(HBODCore.compareText);
  const dated = records.map((r) => r.date).filter(Boolean).sort();
  const dates = HBODCore.dateRange(dated[0], dated[dated.length - 1]);
  const health = {};
  for (const a of athletes) {
    health[a] = dates.map((d) => {
      const h = HBODCore.applyHealthGate(HBODCore.healthStatus(records, a, d));
      return [h.pain, h.location, h.severity, h.substantial, h.cannot, h.flagged, h.action, h.text, h.reason];
    });
  }
  datasets[key] = {
    origin: DATASETS[key],
    records: records.map((r) => [r.date, r.athlete, r.moment, r.duration, r.intensity, r.fatigue, r.stress,
      r.soreness, r.sleep, r.pain, r.painLocation, r.ostrc[0], r.ostrc[1], r.ostrc[2], r.ostrc[3], r.sessionLoad]),
    athletes: athletes,
    dates: dates,
    health: health,
  };
  athleteDays += athletes.length * dates.length;
  console.log(`${key}: ${records.length} records, ${athletes.length} athletes, ${dates.length} days`);
}

fs.writeFileSync(path.join(__dirname, 'js_health_gate.json'),
  JSON.stringify({ node: process.version, tag: TAG, datasets: datasets }));
console.log(`${athleteDays} athlete-days written to js_health_gate.json (Node.js ${process.version})`);
