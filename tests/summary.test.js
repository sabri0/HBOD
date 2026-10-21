// Tests of the language-model layer (app/src/summary.js and cli/summarize.js). The layer only restates the computed
// result: it never computes or changes the probability, and every stored summary carries the probability next to it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const HBODCore = require('../app/src/core.js');
const HBODSummary = require('../app/src/summary.js');
const squad = require('./demo-squad.js');

const W = HBODCore.WORDING;
const day = squad.day;
const listed = squad.athlete('Athlete 24');     // on today's list, probability shown 1.00
const below = squad.athlete('Athlete 05');      // below the threshold, probability shown 0.77
const stopped = squad.athlete('Athlete 13');    // health gate STOP, probability shown 0.57

test('the demonstration day has the athletes these tests rely on', () => {
  assert.equal(listed.status, 'listed');
  assert.equal(below.status, 'below-threshold');
  assert.equal(HBODSummary.formatProbability(below.probability), '0.77');
  assert.equal(stopped.health.action, 'STOP');
  assert.equal(HBODSummary.formatProbability(stopped.probability), '0.57');
});

test('the probability is formatted in one way everywhere', () => {
  assert.equal(HBODSummary.formatProbability(0.8731245), '0.87');
  assert.equal(HBODSummary.formatProbability(1 - 1e-12), '1.00');
  assert.equal(HBODSummary.formatProbability(0), '0.00');
  assert.equal(HBODSummary.formatProbability(null), 'not available yet');
});

test('the system prompt lets the model restate only (requirement 8)', () => {
  const p = HBODSummary.SYSTEM_PROMPT;
  assert.ok(p.includes(W.probability));
  assert.ok(p.includes(W.probabilityDetail));
  assert.ok(p.includes(W.support));
  assert.match(p, /Restate only\. Never compute, recompute, round, estimate or alter any number/);
  assert.match(p, /Never change the probability, the status or the list\. Quote the probability exactly/);
  assert.match(p, /Never call the probability a risk, a likelihood or a chance of injury or illness/);
  assert.match(p, /The health gate comes first/);
  assert.match(p, /no diagnosis and no advice on treatment or medication/i);
  assert.match(p, /for planning only/);
  assert.match(p, /never as a reason for an alert/);
  assert.match(HBODSummary.PROMPT_VERSION, /^hbod-summary-prompt\/\d+$/);
});

test('the data block holds computed facts only, with the probability as the application prints it', () => {
  const block = HBODSummary.buildDataBlock(day, { athlete: 'Athlete 05' });
  assert.match(block, /^HBOD computed result\. Data through 2026-06-27/);
  assert.match(block, /Every value below is final\. Restate it; do not change it\./);
  assert.match(block, /- Athlete: Athlete 05\n/);
  assert.match(block, /\n {2}Probability: 0\.77\n/);
  assert.match(block, /Status: Below the threshold/);
  assert.match(block, /Planning only \(never a reason for an alert\): acute load /);
  assert.ok(!block.includes('Athlete 24'), 'only the selected athlete is in the block');
  assert.doesNotMatch(block, /\brisk/i);
  // the whole squad, in the display order of the day report
  const all = HBODSummary.buildDataBlock(day);
  const order = all.split('\n').filter(function (l) { return l.startsWith('- Athlete: '); })
    .map(function (l) { return l.slice('- Athlete: '.length); });
  assert.deepEqual(order, day.athletes.map(function (a) { return a.name; }));
  // same input, same block
  assert.equal(HBODSummary.buildDataBlock(day, { athlete: 'Athlete 05' }), block);
});

test('names can be replaced by codes before the block leaves the device, and restored afterwards', () => {
  const codes = HBODSummary.pseudonyms(day.athletes.map(function (a) { return a.name; }));
  assert.equal(new Set(Object.values(codes)).size, day.athletes.length, 'one code per athlete');
  const block = HBODSummary.buildDataBlock(day, { pseudonyms: codes });
  for (const a of day.athletes) assert.ok(!block.includes(a.name), a.name + ' is not in the coded block');
  assert.ok(block.includes('- Athlete: ' + codes['Athlete 13']));
  assert.ok(!/Knee|Hamstring|Lower back/.test(block), 'free text such as the location of a pain is left out');
  const answer = codes['Athlete 13'] + ': the health gate says STOP; anything clinical is for the medical staff.';
  assert.equal(HBODSummary.restoreNames(answer, codes),
    'Athlete 13: the health gate says STOP; anything clinical is for the medical staff.');
});

test('a stored summary carries the probability of the engine next to it', () => {
  const text = 'Athlete 05: the probability is 0.77, which is the probability that the modelled state exceeds ' +
    'the athlete\'s own baseline; it is below the threshold of 0.80 and it is not the probability of an injury or illness.';
  const r = HBODSummary.makeRecord({ dayReport: day, athlete: 'Athlete 05', summary: text, model: 'some-model',
    createdAt: '2026-06-27T20:15:00Z' });
  assert.equal(r.schema, 'hbod-summary/1');
  assert.equal(r.created_at, '2026-06-27T20:15:00Z');
  assert.equal(r.date, '2026-06-27');
  assert.equal(r.athlete, 'Athlete 05');
  assert.equal(r.probability, below.probability, 'the full-precision value of the engine, not the rounded text');
  assert.notEqual(String(r.probability), r.probability_shown);
  assert.equal(r.probability_shown, '0.77');
  assert.equal(r.alert, false);
  assert.equal(r.list_status, 'below-threshold');
  assert.equal(r.p_deficit, below.pDeficit);
  assert.equal(r.p_strain, below.pStrain);
  assert.equal(r.driver, below.driver);
  assert.equal(r.health_action, null);
  assert.deepEqual(r.budget, { enabled: true, share: 0.10, cap: 2 });
  assert.equal(r.engine_version, day.engineVersion);
  assert.equal(r.prompt_version, HBODSummary.PROMPT_VERSION);
  assert.equal(r.model, 'some-model');
  assert.equal(r.summary, text);
  assert.equal(r.data_block, HBODSummary.buildDataBlock(day, { athlete: 'Athlete 05' }));
  assert.deepEqual(r.check, { ok: true, issues: [], codes: [] });
});

test('the stored probability never comes from the text of the model', () => {
  const r = HBODSummary.makeRecord({ dayReport: day, athlete: 'Athlete 05',
    summary: 'Athlete 05: the probability is 0.12.', model: null, createdAt: '2026-06-27T20:15:00Z' });
  assert.equal(r.probability, below.probability);
  assert.equal(r.probability_shown, '0.77');
  assert.equal(r.check.ok, false);
  assert.ok(r.check.codes.includes('probability-mismatch'));
  assert.ok(r.check.codes.includes('probability-not-quoted'));
  assert.throws(function () {
    HBODSummary.makeRecord({ dayReport: day, athlete: 'Nobody', summary: 'x', model: null });
  }, RangeError);
});

test('the automatic check accepts a faithful restatement', () => {
  const ok = HBODSummary.checkFaithfulness(
    'Athlete 24: the probability is 1.00 and the athlete is on today\'s list, mainly driven by wellness strain. ' +
    'It is the probability that the modelled state exceeds his or her own baseline and it is not the probability of an injury or illness.',
    listed, { dayReport: day });
  assert.deepEqual(ok, { ok: true, issues: [], codes: [] });
  const gate = HBODSummary.checkFaithfulness(
    'Athlete 13: the health gate says STOP, so there is no training today and anything clinical is for the ' +
    'medical staff. The probability is 0.57, below the threshold.', stopped, { dayReport: day });
  assert.deepEqual(gate.codes, []);
});

test('the automatic check flags a changed probability, an invented number and risk wording', () => {
  const changed = HBODSummary.checkFaithfulness('Athlete 05: the probability is 0.87.', below, { dayReport: day });
  assert.ok(changed.codes.includes('probability-mismatch'));
  assert.ok(changed.codes.includes('probability-not-quoted'));

  const percent = HBODSummary.checkFaithfulness('Athlete 05: the probability is 0.77, that is 77%.', below,
    { dayReport: day });
  assert.ok(percent.codes.includes('probability-mismatch'), 'a percentage derived from the probability is flagged');

  const invented = HBODSummary.checkFaithfulness(
    'Athlete 05: the probability is 0.77 after 9 hard sessions.', below, { dayReport: day });
  assert.ok(invented.codes.includes('number-not-in-data'));

  for (const wording of ['Athlete 05: the probability is 0.77, so the risk of injury is high.',
    'Athlete 05: with a probability of 0.77 there is a real chance of injury this week.',
    'Athlete 05: the injury risk is 0.77.']) {
    const r = HBODSummary.checkFaithfulness(wording, below, { dayReport: day });
    assert.ok(r.codes.includes('risk-wording'), wording);
    assert.equal(r.ok, false);
  }
});

test('the automatic check flags a missing health gate, a wrong list status and the ratio used as a reason', () => {
  const noGate = HBODSummary.checkFaithfulness('Athlete 13: the probability is 0.57.', stopped, { dayReport: day });
  assert.ok(noGate.codes.includes('health-gate-missing'));
  const late = HBODSummary.checkFaithfulness(
    'Athlete 13: the probability is 0.57. The health gate says STOP.', stopped, { dayReport: day });
  assert.ok(late.codes.includes('health-gate-not-first'));
  const wrongList = HBODSummary.checkFaithfulness(
    'Athlete 05: the probability is 0.77 and the athlete is on today\'s list.', below, { dayReport: day });
  assert.ok(wrongList.codes.includes('list-status-mismatch'));
  const ratio = HBODSummary.checkFaithfulness(
    'Athlete 24: the probability is 1.00 because the ratio of acute to chronic load is high.', listed,
    { dayReport: day });
  assert.ok(ratio.codes.includes('ratio-outside-planning'));
  const empty = HBODSummary.checkFaithfulness('', below, { dayReport: day });
  assert.deepEqual(empty.codes.slice(0, 1), ['empty-summary']);
});

test('records are exported as JSON lines and as CSV without losing the probability', () => {
  const records = ['Athlete 05', 'Athlete 13', 'Athlete 24'].map(function (name, k) {
    return HBODSummary.makeRecord({ dayReport: day, athlete: name, model: 'm',
      summary: name + ': line one, "quoted"\nline two; value ' + k, createdAt: '2026-06-27T20:15:0' + k + 'Z' });
  });
  const back = HBODSummary.fromJSONL(HBODSummary.toJSONL(records));
  assert.deepEqual(back, records);
  assert.equal(back[0].probability, below.probability, 'full precision survives the round trip');

  const rows = HBODCore.parseCSV(HBODSummary.toCSV(records));
  assert.deepEqual(rows[0], HBODSummary.CSV_COLUMNS);
  assert.equal(rows.length, 1 + records.length);
  const col = function (name) { return rows[0].indexOf(name); };
  assert.equal(rows[1][col('athlete')], 'Athlete 05');
  assert.equal(Number(rows[1][col('probability')]), below.probability);
  assert.equal(rows[1][col('probability_shown')], '0.77');
  assert.equal(rows[1][col('summary')], records[0].summary);
  assert.equal(HBODSummary.toJSONL([]), '');
});

// ------------------------------------------------------------------ command line
const CLI = path.join(__dirname, '..', 'cli', 'summarize.js');
const HBOD_CLI = path.join(__dirname, '..', 'cli', 'hbod.js');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hbod-test-')); }

// Runs a command-line tool with every connection forbidden: a preloaded script replaces fetch by a function that
// records the attempt and fails.
function runOffline(script, args, env) {
  const dir = tempDir();
  const guard = path.join(dir, 'no-network.js');
  const marker = path.join(dir, 'network-attempt.txt');
  fs.writeFileSync(guard, "globalThis.fetch = function (url) { require('node:fs').writeFileSync(" +
    JSON.stringify(marker) + ", String(url)); return Promise.reject(new Error('no network in this test')); };\n");
  const cleaned = Object.assign({}, process.env, env || {});
  if (!env || !('ANTHROPIC_API_KEY' in env)) delete cleaned.ANTHROPIC_API_KEY;
  const out = spawnSync(process.execPath, ['--require', guard, script].concat(args),
    { encoding: 'utf8', env: cleaned, cwd: dir });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, attempted: fs.existsSync(marker), dir: dir };
}

function writeDay() {
  const dir = tempDir();
  const csv = path.join(dir, 'responses.csv'), log = path.join(dir, 'availability.json');
  const json = path.join(dir, 'day.json'), audit = path.join(dir, 'audit.csv');
  fs.writeFileSync(csv, squad.demo.csv);
  fs.writeFileSync(log, JSON.stringify(squad.demo.availability));
  const out = runOffline(HBOD_CLI, ['--input', csv, '--availability', log, '--json', json, '--audit', audit]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.attempted, false, 'the report command contacts no server');
  return { dir: dir, json: json, audit: audit, stdout: out.stdout };
}

test('the report command runs locally and writes the day and the audit rows', () => {
  const d = writeDay();
  assert.ok(d.stdout.includes('HBOD daily report'));
  assert.ok(d.stdout.includes(W.probability));
  const stored = JSON.parse(fs.readFileSync(d.json, 'utf8'));
  const dayStored = stored.dayReport || stored;
  assert.equal(dayStored.date, '2026-06-27');
  const rows = HBODCore.parseCSV(fs.readFileSync(d.audit, 'utf8')).filter(function (r) { return r.length > 1; });
  assert.deepEqual(rows[0], HBODCore.AUDIT_COLUMNS);
  assert.equal(rows.length, 1 + 25);
  const col = function (name) { return rows[0].indexOf(name); };
  const row = rows.find(function (r) { return r[col('athlete')] === 'Athlete 05'; });
  assert.equal(Number(row[col('probability')]), below.probability);
  assert.equal(row[col('engine_version')], day.engineVersion);
});

test('the summary command calls no model unless --run is given', () => {
  const d = writeDay();
  const emit = runOffline(CLI, ['--day', d.json, '--athlete', 'Athlete 05']);
  assert.equal(emit.status, 0, emit.stderr);
  assert.equal(emit.attempted, false, 'the default mode makes no network call');
  assert.ok(emit.stdout.includes('Restate only.'));
  assert.ok(emit.stdout.includes('Probability: 0.77'));
  assert.match(emit.stderr, /No model was called and nothing left this device\./);

  const text = path.join(d.dir, 'text.json'), out = path.join(d.dir, 'summaries.jsonl');
  fs.writeFileSync(text, JSON.stringify([{ athlete: 'Athlete 05', model: 'elsewhere',
    summary: 'Athlete 05: the probability is 0.77, below the threshold; it is not an injury risk.' }]));
  const stored = runOffline(CLI, ['--day', d.json, '--from-file', text, '--out', out]);
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(stored.attempted, false);
  const records = HBODSummary.fromJSONL(fs.readFileSync(out, 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].probability, below.probability, 'the probability sits next to the summary');
  assert.equal(records[0].probability_shown, '0.77');
  assert.equal(records[0].model, 'elsewhere');
  assert.equal(records[0].check.ok, true);
});

test('--run refuses to start without a key and sends nothing', () => {
  const d = writeDay();
  const out = path.join(d.dir, 'summaries.jsonl');
  const run = runOffline(CLI, ['--day', d.json, '--athlete', 'Athlete 05', '--run', '--out', out]);
  assert.notEqual(run.status, 0);
  assert.equal(run.attempted, false, 'nothing is sent without a key');
  assert.match(run.stderr, /ANTHROPIC_API_KEY is not set/);
  assert.match(run.stderr, /Nothing was sent/);
  assert.equal(fs.existsSync(out), false);
});

test('--run sends the constrained prompt and coded names only, and says what leaves the device', () => {
  const d = writeDay();
  const dir = tempDir();
  const guard = path.join(dir, 'capture.js'), seen = path.join(dir, 'request.json');
  fs.writeFileSync(guard, "globalThis.fetch = async function (url, init) { require('node:fs').writeFileSync(" +
    JSON.stringify(seen) + ", JSON.stringify({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }));" +
    " return new Response(JSON.stringify({ id: 'x', type: 'message', role: 'assistant', model: 'test-model'," +
    " stop_reason: 'end_turn', content: [{ type: 'text', text: 'ATH05: the probability is 0.77, below the threshold; it is not an injury risk.' }] })," +
    " { status: 200, headers: { 'content-type': 'application/json' } }); };\n");
  const out = path.join(d.dir, 'summaries.jsonl');
  const env = Object.assign({}, process.env, { ANTHROPIC_API_KEY: 'test-key-not-real' });
  delete env.ANTHROPIC_BASE_URL;
  const run = spawnSync(process.execPath, ['--require', guard, CLI, '--day', d.json, '--athlete', 'Athlete 05',
    '--run', '--no-fallback', '--out', out], { encoding: 'utf8', env: env, cwd: dir });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const request = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.body.system, HBODSummary.SYSTEM_PROMPT);
  assert.equal(request.body.messages.length, 1);
  const sent = request.body.messages[0].content;
  assert.ok(!/Athlete \d\d/.test(sent), 'no athlete name leaves the device');
  assert.ok(sent.includes('- Athlete: ATH05'));
  assert.ok(sent.includes('Probability: 0.77'));
  assert.ok(!sent.includes('ATH24'), 'only the selected athlete is sent');
  assert.match(run.stdout, /Leaving this device for api\.anthropic\.com: the constrained prompt and the computed result/);
  assert.match(run.stdout, /with every name replaced by a code\. The raw responses file .* are not sent\./);
  const records = HBODSummary.fromJSONL(fs.readFileSync(out, 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].athlete, 'Athlete 05', 'the name is restored in the record');
  assert.ok(records[0].summary.startsWith('Athlete 05:'));
  assert.equal(records[0].pseudonym, 'ATH05');
  assert.equal(records[0].probability, below.probability);
  assert.equal(records[0].model, 'test-model');
});
