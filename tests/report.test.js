// Tests of the daily report and of the periodic reviews (app/src/report.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const HBODCore = require('../app/src/core.js');
const HBODReport = require('../app/src/report.js');
const squad = require('./demo-squad.js');

const W = HBODCore.WORDING;
const day = squad.day;
const report = HBODReport.buildDailyReport(day, { generatedAt: '2026-10-13T12:00:00' });

// Text of an HTML report as a reader sees it: tags removed, entities decoded, white space collapsed.
function visible(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const seen = visible(report.html);

function sectionOf(text, title) {
  const lines = text.split('\n');
  const from = lines.indexOf('== ' + title + ' ==');
  assert.ok(from >= 0, 'the text report has a section "' + title + '"');
  let to = lines.length;
  for (let k = from + 1; k < lines.length; k++) if (/^== .* ==$/.test(lines[k])) { to = k; break; }
  return lines.slice(from + 1, to);
}

test('the report is titled HBOD daily report and names the day of the data', () => {
  assert.equal(report.text.split('\n')[0], 'HBOD daily report');
  assert.match(report.text, /^Data through 2026-06-27$/m);
  assert.match(report.html, /<title>HBOD daily report/);
  assert.ok(seen.includes('Data through 2026-06-27'));
});

test('the report says what the probability shows and that it is not an injury risk (requirement 6)', () => {
  for (const out of [report.text, seen]) {
    assert.ok(out.includes(W.probability), 'the sentence on the meaning of the probability is present verbatim');
    assert.ok(out.includes(W.probabilityDetail));
    assert.ok(out.includes(W.support));
    assert.ok(out.indexOf(W.probability) < out.indexOf('Athlete '), 'the sentence comes before the first athlete');
  }
});

test('the probability is never presented as a risk, a likelihood or a chance of injury or illness', () => {
  for (const out of [report.text, seen]) {
    const withoutDisclaimer = out.split(W.probability).join(' ');
    assert.doesNotMatch(withoutDisclaimer, /\brisk/i, 'the word risk appears only inside the disclaimer');
    assert.doesNotMatch(out, /likelihood|chance of|injury probability|probability of (an )?(injury|illness)/i);
    assert.doesNotMatch(out, /readiness|danger zone|sweet spot/i);
  }
});

test('acute load, chronic load and their ratio are shown for planning only and explain nothing', () => {
  assert.ok(report.text.includes(W.planning));
  assert.ok(seen.includes(W.planning));
  // text report: outside the section listing all athletes, the planning indices do not appear at all
  for (const title of ['Health gate', "Today's list", "Above the threshold but outside today's alert budget",
    'Missing reports', 'Unavailable athletes']) {
    for (const line of sectionOf(report.text, title)) {
      assert.doesNotMatch(line, /\bratio\b|acute load|chronic load|ACWR|workload/i, title + ': ' + line);
    }
  }
  // in the section listing all athletes they stand behind the words "planning only"
  for (const line of sectionOf(report.text, 'All athletes')) {
    if (/\bratio\b|acute load|chronic load/i.test(line) && line !== W.planning) {
      assert.match(line, /planning only: acute load .* chronic load .* ratio /, line);
    }
  }
  assert.match(seen, /planning only/i);
  assert.doesNotMatch(report.text + seen, /ACWR|1\.30|0\.80\s*(to|–|-)\s*1\.30|above the band|overload/i);
});

test('the order of the athletes does not follow the ratio', () => {
  const listed = day.athletes.filter(function (a) { return a.status === 'listed'; });
  const byProbability = listed.slice().sort(function (p, q) { return q.probability - p.probability; });
  assert.deepEqual(listed.map(function (a) { return a.name; }), byProbability.map(function (a) { return a.name; }));
  // the same day with every planning index removed gives the same report apart from the planning values
  const stripped = JSON.parse(JSON.stringify(day));
  for (const a of stripped.athletes) a.planning = { acute: null, chronic: null, ratio: null };
  const other = HBODReport.buildDailyReport(stripped, { generatedAt: '2026-10-13T12:00:00' });
  const keep = function (text) {
    return text.split('\n').map(function (l) { return l.replace(/ \| planning only: .*$/, ''); }).join('\n');
  };
  assert.equal(keep(other.text), keep(report.text));
});

test('health-gate athletes come first, with the texts of the gate', () => {
  const gate = sectionOf(report.text, 'Health gate');
  assert.ok(gate.includes(W.gate));
  const actions = gate.filter(function (l) { return /^(STOP|REFER|HOLD) /.test(l); })
    .map(function (l) { return l.split(' ')[0]; });
  assert.deepEqual(actions, ['STOP', 'REFER', 'HOLD']);
  for (const action of ['STOP', 'REFER', 'HOLD']) assert.ok(report.text.includes(HBODCore.HEALTH_TEXT[action]));
  assert.ok(report.text.indexOf('== Health gate ==') < report.text.indexOf("== Today's list =="));
  assert.ok(seen.indexOf('Health gate') < seen.indexOf("Today's list"));
});

test("today's list is ranked by probability, capped by the alert budget, and states the cap", () => {
  const list = sectionOf(report.text, "Today's list");
  assert.ok(list.includes(W.budget));
  assert.ok(list.some(function (l) { return /at most 2 athletes on today's list/.test(l); }), list.join('\n'));
  const names = list.filter(function (l) { return /^Athlete \d\d \(rank/.test(l); })
    .map(function (l) { return l.slice(0, 10); });
  assert.deepEqual(names, day.budget.listed);
  assert.equal(names.length, 2);
  const over = sectionOf(report.text, "Above the threshold but outside today's alert budget")
    .filter(function (l) { return /^Athlete \d\d \(rank/.test(l); }).map(function (l) { return l.slice(0, 10); });
  assert.deepEqual(over, day.budget.overflow);
});

test('with the alert budget switched off every healthy athlete at or above 0.80 is listed', () => {
  const off = HBODCore.dayReport(squad.analyse({ budget: { enabled: false, share: 0.10 } }));
  assert.deepEqual(off.budget.listed, day.budget.listed.concat(day.budget.overflow));
  const text = HBODReport.buildDailyReport(off, { generatedAt: '2026-10-13T12:00:00' }).text;
  assert.match(text, /Alert budget off/i);
});

test('missing reports are listed for a same-day follow-up and are never read as rest', () => {
  const missing = sectionOf(report.text, 'Missing reports');
  assert.ok(missing.includes(W.missing));
  assert.ok(missing.includes('Contact these athletes today. A missing report is not a sign of recovery.'),
    missing.join('\n'));
  const named = day.athletes.filter(function (a) { return a.imputed; }).map(function (a) { return a.name; });
  assert.equal(named.length, day.counts.missing);
  for (const name of named) assert.ok(missing.join('\n').includes(name), name + ' is named among the missing reports');
  assert.doesNotMatch(missing.join('\n'), /rest day/i);
});

test('unavailable athletes are listed with zero load and are not ranked', () => {
  const lines = sectionOf(report.text, 'Unavailable athletes').join('\n');
  for (const a of day.athletes.filter(function (x) { return x.unavailable; })) {
    assert.ok(lines.includes(a.name));
    assert.equal(a.rank, null);
    assert.equal(a.load, 0);
  }
  assert.match(lines, /zero load/);
});

test('user text is escaped in the HTML report', () => {
  const copy = JSON.parse(JSON.stringify(day));
  const a = copy.athletes.find(function (x) { return x.health && x.health.action === 'STOP'; });
  a.name = '<img src=x onerror=alert(1)> & "Co"';
  a.health.location = '<script>alert(2)</script>';
  const html = HBODReport.buildDailyReport(copy, { generatedAt: '2026-10-13T12:00:00' }).html;
  assert.ok(!html.includes('<img src=x'), 'the name is not written as markup');
  assert.ok(!html.includes('<script>alert(2)'), 'the location is not written as markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;'));
});

test('the HTML report is self-contained: no script and nothing loaded from elsewhere', () => {
  assert.doesNotMatch(report.html, /<script/i);
  assert.doesNotMatch(report.html, /\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(report.html, /url\(/i);
  assert.doesNotMatch(report.html, /<link|<iframe|<img/i);
});

test('the cadence of the reviews is the one of the rule-based prototype', () => {
  assert.deepEqual(HBODReport.reportsDue('2026-06-24'), ['daily']);                           // a Wednesday
  assert.deepEqual(HBODReport.reportsDue('2026-06-20'), ['daily', 'weekly']);                 // a Saturday
  assert.deepEqual(HBODReport.reportsDue('2026-05-30'), ['daily', 'weekly', 'monthly']);      // last Saturday of May
  assert.deepEqual(HBODReport.reportsDue('2026-06-27'), ['daily', 'weekly', 'monthly', 'quarterly']);
});

test('periodic reviews are descriptive: no suggestion and no decision', () => {
  const periodic = HBODReport.buildPeriodic(squad.analysis, '2026-06-27');
  assert.deepEqual(periodic.due, ['daily', 'weekly', 'monthly', 'quarterly']);
  for (const title of ['Weekly review', 'Monthly review', 'Quarterly review']) assert.ok(periodic.text.includes(title));
  assert.match(periodic.text, /Descriptive review: it holds no suggestion and no decision\./);
  assert.doesNotMatch(periodic.text, /mesocycle|deload block|build block|consider|recommend|should|increase|decrease/i);
  assert.doesNotMatch(periodic.text + periodic.html, /\bratio\b|ACWR|\brisk/i);
  const one = HBODReport.buildPeriodic(squad.analysis, '2026-06-24');
  assert.deepEqual(one.due, ['daily']);
  assert.equal(one.text, '');
  // the weekly load of the review is the load used by the engine, never zero for a missing day
  const s = HBODCore.series(squad.analysis, 'Athlete 01');
  const last7 = s.load.slice(-7).reduce(function (x, y) { return x + y; }, 0);
  assert.ok(periodic.text.includes('Athlete 01: load used ' + HBODCore.formatLoad(last7) + ' AU'));
});

test('the daily report can carry the reviews that are due', () => {
  const periodic = HBODReport.buildPeriodic(squad.analysis, '2026-06-27');
  const full = HBODReport.buildDailyReport(day, { generatedAt: '2026-10-13T12:00:00', periodic: periodic });
  assert.ok(full.text.includes('Weekly review'));
  assert.ok(full.html.includes('Weekly review'));
  assert.ok(full.html.length > report.html.length);
});

test('before day 28 the report says that the baselines are still being built', () => {
  const early = HBODCore.dayReport(squad.analysis, HBODCore.addDays(squad.analysis.startDate, 20));
  assert.equal(early.counts.listed, 0);
  assert.ok(early.athletes.every(function (a) { return a.probability === null; }));
  const text = HBODReport.buildDailyReport(early, { generatedAt: '2026-10-13T12:00:00' }).text;
  assert.match(text, /28 days/);
  assert.ok(text.includes(W.probability));
});
