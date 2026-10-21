// Tests of requirements 1, 3, 6 and 12 on the text of the repository: HBOD is the only name of the system, the
// earlier rules are "the rule-based prototype", the share of healthy athlete-days on the daily list is the alert
// rate, the probability is never presented as a risk, the ratio carries no threshold, and the repository holds code
// and the Supplementary Materials of the paper, no other document.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'simulation', '__pycache__']);

// Every file of the working tree outside .git and simulation/ (File S1 is kept byte-identical and is not ours to word).
function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? dir + '/' + entry.name : entry.name;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(rel, out); } else out.push(rel);
  }
  return out;
}
const files = walk('', []);
const isText = function (f) { return /\.(js|py|html|css|json|md|cff|txt|csv|sh|yml|yaml)$|^(NOTICE|LICENSE|\.gitignore|\.gitattributes|\.zenodo\.json)$/.test(f); };
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const THIS = 'tests/naming.test.js';

// Files that a user reads or runs: the application, the command line, the tools and the files at the root.
const userFacing = files.filter(function (f) {
  return isText(f) && (/^(app|cli|tools)\//.test(f) || !f.includes('/'));
});
// The built page and the demonstration data repeat the sources; scanning the sources is enough for wording.
const worded = userFacing.filter(function (f) { return f !== 'app/HBOD_App.html' && f !== 'app/src/demo-data.js'; });

test('the working names of the registration are not used anywhere', () => {
  const working = [/HBOD[ -]?v[12]\b/i, /HBOD[ _-]?version[ _-]?[12]\b/i];
  for (const f of files.filter(isText)) {
    if (f === THIS) continue;
    const text = read(f);
    for (const pattern of working) assert.doesNotMatch(text, pattern, f);
  }
});

test('the old name of the system is not used in anything a user reads', () => {
  for (const f of userFacing) {
    assert.doesNotMatch(read(f), /\bHBD\b/, f + ' holds the old name');
    assert.doesNotMatch(read(f), /hbd[_-](agent|report|data|output|app|n8n)/i, f + ' holds an old file or variable name');
  }
  // elsewhere the old name appears only as the file name of the archived prototype
  for (const f of files.filter(isText)) {
    if (userFacing.includes(f) || f === THIS) continue;
    const rest = read(f).replace(/hbd_agent(\.py)?/g, '');
    assert.doesNotMatch(rest, /\bHBD\b/, f);
  }
});

test('the earlier rules are called the rule-based prototype', () => {
  for (const f of worded) {
    const text = read(f);
    assert.doesNotMatch(text, /\b(old|previous|legacy|first|original) (version|engine|HBOD)\b/i, f);
    assert.doesNotMatch(text, /rule-based (engine|version|HBOD|system|agent)\b/i, f);
  }
});

test('the probability is never called a risk', () => {
  // The word may appear in the disclaimer, in the rule that forbids the model to use it, and in the code that
  // screens summaries for it.
  const allowed = [
    /not an injury risk/i,
    /is not (the|a) (probability|risk) of an? (injury|illness)/i,
    /never call(s|ed)? the probability a risk/i,
    /as a risk\b/i,
    /risk-wording/,
    /RISK_PATTERNS?/,
    /risk of injury or illness/i,
    /injury risk\b/i
  ];
  // app/src/summary.js is the code that screens summaries for this wording, so it has to name the word; what it
  // gives to the model and to the reader is checked below through its prompt and its data block.
  for (const f of worded.filter(function (x) { return x !== 'app/src/summary.js'; })) {
    const lines = read(f).split('\n');
    lines.forEach(function (line, k) {
      if (!/risk/i.test(line)) return;
      assert.ok(allowed.some(function (p) { return p.test(line); }), f + ':' + (k + 1) + ' uses the word risk: ' + line.trim());
    });
  }
  const HBODSummary = require('../app/src/summary.js');
  const squad = require('./demo-squad.js');
  const prompt = HBODSummary.SYSTEM_PROMPT.replace(/It is not an injury risk\./g, '')
    .replace(/Never call the probability a risk, a likelihood or a chance of injury or illness/, '');
  assert.doesNotMatch(prompt, /\brisk/i, 'the prompt names the word only to forbid it');
  assert.doesNotMatch(HBODSummary.buildDataBlock(squad.day), /\brisk/i, 'the data block never uses the word');
  // outside the screening code and the prompt, nothing may assert a risk
  for (const f of ['app/src/ui.js', 'app/src/report.js', 'app/src/core.js', 'app/src/template.html', 'cli/hbod.js']) {
    const text = read(f).replace(/It is not an injury risk\./g, '').replace(/not an injury risk/gi, '');
    assert.doesNotMatch(text, /\brisk/i, f);
  }
});

test('no wording of the ratio as a rule survives', () => {
  for (const f of worded) {
    const text = read(f);
    assert.doesNotMatch(text, /readiness score|danger zone|sweet spot/i, f);
    assert.doesNotMatch(text, /ACWR_(HIGH|LOW)|MONOTONY_HIGH|WELLNESS_DROP|ACUTE_SPIKE/, f + ' holds a threshold of the rule-based prototype');
    assert.doesNotMatch(text, /\b(INCREASE|MAINTAIN|DECREASE)\b/, f + ' holds a decision of the rule-based prototype');
    assert.doesNotMatch(text, /ratio\s*(>|>=|above|exceeds|over)\s*1\.[0-9]/i, f + ' compares the ratio with a threshold');
  }
});

test('nothing in the screens colours, orders or flags by the ratio', () => {
  const ui = read('app/src/ui.js');
  const lines = ui.split('\n');
  lines.forEach(function (line, k) {
    if (!/\.ratio\b/.test(line)) return;
    assert.doesNotMatch(line, /[<>]=?\s*\d|\?\s*['"][^'"]*(warn|alert|red|flag|high|low)/i,
      'app/src/ui.js:' + (k + 1) + ' tests the ratio: ' + line.trim());
    assert.doesNotMatch(line, /\.sort\(/, 'app/src/ui.js:' + (k + 1) + ' sorts by the ratio');
  });
  assert.match(ui, /planning only/i);
});

// The one document that the repository holds: the Supplementary Materials of the paper (Figures S1 to S3, Tables S1 to S4).
const SUPPLEMENTARY = 'supplementary/HBOD_InSilico_Supplementary_Materials.docx';

test('the share of healthy athlete-days on the daily list is called the alert rate, not a budget', () => {
  for (const f of worded) {
    assert.doesNotMatch(read(f), /alert[ -]budget/i, f + ' holds the old wording of the alert rate');
  }
  const HBODCore = require('../app/src/core.js');
  for (const sentence of Object.values(HBODCore.WORDING).concat(Object.values(HBODCore.STATUS_LABELS))) {
    assert.doesNotMatch(sentence, /budget/i, sentence);
  }
  assert.match(HBODCore.WORDING.budget, /^The alert rate /);
});

test('the probability is described as the probability that the modelled state exceeds the own baseline', () => {
  const HBODCore = require('../app/src/core.js');
  assert.match(HBODCore.WORDING.probability, /probability that the athlete's modelled state exceeds his or her own baseline/);
  assert.match(HBODCore.WORDING.probability, /not the probability of an injury or illness/);
  for (const f of worded) assert.doesNotMatch(read(f), /sits beyond/i, f + ' holds the old description of the probability');
});

test('the repository holds code and the Supplementary Materials, no other document', () => {
  const documents = files.filter(function (f) { return /\.(docx?|xlsx?|pptx?|pdf|odt|rtf|pages)$/i.test(f); });
  assert.deepEqual(documents, [SUPPLEMENTARY]);
  const head = fs.readFileSync(path.join(ROOT, SUPPLEMENTARY)).subarray(0, 4);
  assert.deepEqual(Array.from(head), [0x50, 0x4b, 0x03, 0x04], 'a Word document is a zip archive');
  const markdown = files.filter(function (f) { return /\.md$/i.test(f); });
  for (const f of markdown) assert.ok(['README.md', 'LICENSE.md'].includes(f), f + ' is a note, not code');
  const stray = files.filter(function (f) { return /(^|\/)(notes?|todo|plan|draft|ledger|manuscript|response)[^/]*$/i.test(f); });
  assert.deepEqual(stray, []);
});

test('File S1 is present and untouched by this repository', () => {
  for (const f of ['simulation/README.txt', 'simulation/sim/engines.py', 'simulation/sim/hbodsim.py',
    'simulation/sim/protocol_freeze.md', 'simulation/verify/engine_v1.js', 'simulation/figures/fig1.mmd']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
});
