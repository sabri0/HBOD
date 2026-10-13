// Runs the JavaScript HBOD engine of the application on the simulated data written by mk_parity_hbod.py.
// Run from inside this folder:  node parity_hbod.js
// Writes js_hbod.json for compare_parity_hbod.py.
'use strict';
const fs = require('fs');
const path = require('path');
const HBOD = require(path.join(__dirname, '..', 'app', 'src', 'engine.js'));

const inp = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity_hbod_inputs.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'py_hbod.json'), 'utf8'));
const W = inp.squads, A = inp.athletes_per_squad, T = inp.days, N = W * A;

const p = [], logit = [], alert = [];
for (let i = 0; i < N; i++) { p.push(new Array(T).fill(null)); logit.push(new Array(T).fill(null)); alert.push(new Array(T).fill(false)); }

for (let w = 0; w < W; w++) {
  const idx = [];
  for (let i = w * A; i < (w + 1) * A; i++) idx.push(i);
  const squad = HBOD.createSquad(idx.map((i) => 'P' + String(i).padStart(3, '0')));
  for (let t = 0; t < T; t++) {
    const out = squad.step({
      load: idx.map((i) => inp.load[i][t]),          // null where the athlete sent no report
      hooper: idx.map((i) => inp.hooper[i][t]),
      unavailable: idx.map((i) => inp.unavailable[i][t]),
    });
    out.athletes.forEach((a, k) => {
      p[idx[k]][t] = a.probability; logit[idx[k]][t] = a.logit; alert[idx[k]][t] = a.alert;
    });
  }
}

const ndtr = ref.ndtr_z.map((z) => HBOD.normCdf(z));
fs.writeFileSync(path.join(__dirname, 'js_hbod.json'),
  JSON.stringify({ node: process.version, engine: HBOD.VERSION, p, logit, alert, ndtr }));
console.log(`${N} athletes x ${T} days run through the JavaScript engine (Node.js ${process.version})`);
