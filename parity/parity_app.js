// Runs the simulated squads of the parity test through the application path: the responses file of each squad is
// read with HBODCore.parseCSV and HBODCore.toRecords and analysed with HBODCore.analyse, as the application does.
// Run from inside this folder, after mk_parity_hbod.py:  node parity_app.js
// Writes js_hbod_app.json (same layout as js_hbod.json) for compare_parity_hbod.py.
'use strict';
const fs = require('fs');
const path = require('path');
const HBODCore = require(path.join(__dirname, '..', 'app', 'src', 'core.js'));
const HBODEngine = require(path.join(__dirname, '..', 'app', 'src', 'engine.js'));

const app = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity_hbod_app.json'), 'utf8'));
const inp = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity_hbod_inputs.json'), 'utf8'));
const W = app.squads, A = app.athletes_per_squad, T = app.days, N = W * A;
const endDate = HBODCore.addDays(app.start_date, T - 1);

const p = [], logit = [], alert = [];
let reports = 0, sameInputs = 0;

for (let w = 0; w < W; w++) {
  const roster = app.roster.slice(w * A, (w + 1) * A);
  const text = fs.readFileSync(path.join(__dirname, `parity_hbod_squad${w}.csv`), 'utf8');
  const records = HBODCore.toRecords(HBODCore.parseCSV(text));
  reports += records.length;
  // the roster and the two dates keep athletes and days without any report in the analysis
  const analysis = HBODCore.analyse(records, {
    availability: app.availability[`squad${w}`],
    roster: roster,
    startDate: app.start_date,
    endDate: endDate,
  });
  if (analysis.dates.length !== T || analysis.athletes.length !== A) {
    throw new Error(`squad ${w}: ${analysis.athletes.length} athletes and ${analysis.dates.length} days analysed, ` +
      `${A} and ${T} expected`);
  }
  roster.forEach((name, k) => {
    const i = analysis.athletes.indexOf(name);
    const g = w * A + k;                                  // row of the athlete in the File S1 arrays
    p.push(analysis.days.map((d) => d.athletes[i].probability));
    logit.push(analysis.days.map((d) => d.athletes[i].logit));
    alert.push(analysis.days.map((d) => d.athletes[i].alert));
    // the inputs prepared from the responses file against those File S1 passed to its own engine
    for (let t = 0; t < T; t++) {
      const sameLoad = analysis.inputs.load[t][i] === inp.load[g][t];
      const sameHooper = JSON.stringify(analysis.inputs.hooper[t][i]) === JSON.stringify(inp.hooper[g][t]);
      const sameStatus = analysis.inputs.unavailable[t][i] === inp.unavailable[g][t];
      if (sameLoad && sameHooper && sameStatus) sameInputs += 1;
    }
  });
}

fs.writeFileSync(path.join(__dirname, 'js_hbod_app.json'), JSON.stringify({
  node: process.version, engine: HBODEngine.VERSION, path: 'parseCSV, toRecords, analyse',
  reports: reports, same_inputs: sameInputs, athlete_days: N * T, p, logit, alert,
}));
console.log(`${W} responses files (${reports} reports) read and analysed by the application core ` +
  `(Node.js ${process.version})`);
console.log(`inputs of the engine identical to those of File S1 on ${sameInputs} of ${N * T} athlete-days`);
