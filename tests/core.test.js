// Tests of the analytical core (app/src/core.js): reading the responses file, preparing the daily inputs of the
// engine, the planning indices, the day report, the notes and the audit rows.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HBODCore = require('../app/src/core.js');
const HBODEngine = require('../app/src/engine.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engine_golden.json'), 'utf8'));

// ------------------------------------------------------------------ helpers
function record(date, athlete, fields) {
  const r = Object.assign({ date: date, athlete: athlete, moment: '', duration: null, intensity: null,
    sessionLoad: null, fatigue: null, stress: null, soreness: null, sleep: null, pain: null, painLocation: null,
    ostrc: [null, null, null, null], availability: null }, fields || {});
  if (r.duration !== null && r.intensity !== null && r.sessionLoad === null) r.sessionLoad = r.duration * r.intensity;
  return r;
}
function hooper(fatigue, stress, soreness, sleep) {
  return { fatigue: fatigue, stress: stress, soreness: soreness, sleep: sleep };
}
function names(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push('A' + String(i).padStart(2, '0'));
  return out;
}

// A plain training week in AU (Monday to Sunday); 5 January 2026 is a Monday.
const START = '2026-01-05';
const WEEK = [300, 0, 520, 480, 400, 200, 640];
function session(t, i) {
  const load = WEEK[t % 7] === 0 ? 0 : WEEK[t % 7] + 10 * i;
  return load === 0 ? { duration: 0, intensity: 0 } : { duration: load / 5, intensity: 5 };
}

// The golden squad of File S1 written as a responses file, the way the application receives it.
function goldenAsCSV() {
  const lines = ['Timestamp,Player,Session duration (min),Session intensity (CR-10),Fatigue,Stress,Muscle soreness,' +
    'Sleep'];
  const availability = [];
  const roster = golden.load.map((_, i) => 'P' + String(i).padStart(2, '0'));
  for (let i = 0; i < golden.athletes; i++) {
    for (let t = 0; t < golden.days; t++) {
      const date = HBODCore.addDays('2025-07-01', t);
      if (golden.unavailable[i][t] === '1') {
        availability.push({ athlete: roster[i], from: date, to: date, reason: 'injured' });
      }
      const load = golden.load[i][t];
      if (load === null) continue;                           // no report on that day: no row
      const h = golden.hooper[i].slice(4 * t, 4 * t + 4);    // sleep, stress, fatigue, soreness
      const items = h === '----' ? ',,,' : `${h[2]},${h[1]},${h[3]},${h[0]}`;
      lines.push(`${date} 20:00:00,${roster[i]},${load > 0 ? load : 0},${load > 0 ? 1 : 0},${items}`);
    }
  }
  return { text: lines.join('\n') + '\n', availability: availability, roster: roster };
}
let goldenAnalysisCache = null;
function goldenAnalysis() {
  if (!goldenAnalysisCache) {
    const g = goldenAsCSV();
    goldenAnalysisCache = HBODCore.analyse(HBODCore.toRecords(HBODCore.parseCSV(g.text)), {
      availability: g.availability, roster: g.roster, startDate: '2025-07-01',
      endDate: HBODCore.addDays('2025-07-01', golden.days - 1) });
    goldenAnalysisCache.roster = g.roster;
  }
  return goldenAnalysisCache;
}

// ------------------------------------------------------------------ fixed wording
test('the fixed sentences are those of the paper', () => {
  assert.deepEqual(Object.assign({}, HBODCore.WORDING), {
    probability: "HBOD reports the probability that the athlete's modelled state exceeds his or her own baseline. " +
      'It is not the probability of an injury or illness.',
    probabilityDetail: 'It is the probability that the fatigue-minus-fitness deficit or the wellness strain exceeds ' +
      "the athlete's own baseline of up to 42 previous days by one standard deviation. An alert is raised when it " +
      'reaches 0.80.',
    planning: 'Acute load, chronic load and their ratio are shown for planning only. They do not trigger any decision.',
    missing: 'A missing session load is replaced by the squad median of that day and the uncertainty of fitness and ' +
      'fatigue is multiplied by four. A missing day is never treated as rest.',
    budget: 'The alert rate ranks athletes by probability and caps the daily list at about 10% of healthy ' +
      'athlete-days, about two athletes per day in a squad of 25.',
    gate: 'The health gate sits above load and wellness: it holds, refers or stops an athlete with a declared ' +
      'problem, whatever the probability shows.',
    support: 'HBOD supports the decision; the coach keeps the final decision.',
    privacy: 'All computation runs on this device. No data are uploaded.',
    access: 'HBOD is free for academic and training use.',
  });
  assert.ok(Object.isFrozen(HBODCore.WORDING));
});

// ------------------------------------------------------------------ CSV
test('CSV: quoted cells, doubled quotes and line breaks inside quotes', () => {
  const rows = HBODCore.parseCSV('name,note\n"Diallo, A.","said ""fine""\nthen left"\nplain,a"b\n');
  assert.deepEqual(rows, [['name', 'note'], ['Diallo, A.', 'said "fine"\nthen left'], ['plain', 'a"b']]);
});

test('CSV: byte-order mark, CRLF, CR and LF line ends, empty lines and empty cells', () => {
  assert.deepEqual(HBODCore.parseCSV('\ufeffa,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(HBODCore.parseCSV('a,b\r1,2\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(HBODCore.parseCSV('a,b\n\n1,\n,2\n'), [['a', 'b'], [], ['1', ''], ['', '2']]);
  assert.deepEqual(HBODCore.parseCSV('a,b,\n'), [['a', 'b', '']]);
  assert.deepEqual(HBODCore.parseCSV(''), []);
  assert.deepEqual(HBODCore.parseCSV(null), []);
  assert.deepEqual(HBODCore.parseCSV('"a"\r\n""\r\n'), [['a'], ['']]);
});

test('CSV: semicolon and tab delimiters are detected', () => {
  assert.deepEqual(HBODCore.parseCSV('Nom;Durée (min);Intensité\nAli;"7,5";6\n'),
    [['Nom', 'Durée (min)', 'Intensité'], ['Ali', '7,5', '6']]);
  assert.deepEqual(HBODCore.parseCSV('Name\tDuration\tNote\nAli\t60\ta, b; c\n'),
    [['Name', 'Duration', 'Note'], ['Ali', '60', 'a, b; c']]);
  // a delimiter inside quotes on the first line does not count
  assert.deepEqual(HBODCore.parseCSV('"a;b;c;d",x,y\n1,2,3\n'), [['a;b;c;d', 'x', 'y'], ['1', '2', '3']]);
  assert.deepEqual(HBODCore.parseCSV('a;b\n1;2\n', ','), [['a;b'], ['1;2']]);   // a given delimiter is used as is
  assert.deepEqual(HBODCore.parseCSV('single\nvalue\n'), [['single'], ['value']]);
});

test('CSV text is written with a header, quotes where needed and no formula cells', () => {
  const text = HBODCore.toCSV([{ a: 1, b: 'x, y', c: null }, { a: 0.25, b: 'say "hi"', c: true },
    { a: -2, b: '=SUM(A1)', c: false }]);
  assert.equal(text, 'a,b,c\r\n1,"x, y",\r\n0.25,"say ""hi""",true\r\n-2,\'=SUM(A1),false\r\n');
  assert.deepEqual(HBODCore.parseCSV(text)[1], ['1', 'x, y', '']);
  assert.equal(HBODCore.toCSV([], ['p', 'q']), 'p,q\r\n');
});

test('bytes of a responses file are decoded as UTF-8, UTF-16 or Windows-1252', () => {
  assert.equal(HBODCore.decodeText(Buffer.from('Durée', 'utf8')), 'Durée');
  assert.equal(HBODCore.decodeText(Buffer.from('Durée', 'latin1')), 'Durée');
  assert.equal(HBODCore.parseCSV(HBODCore.decodeText(Buffer.from('\ufeffDurée,x\n', 'utf16le')))[0][0], 'Durée');
  assert.equal(HBODCore.decodeText(new Uint8Array([0x48, 0x42, 0x4f, 0x44]).buffer), 'HBOD');
});

// ------------------------------------------------------------------ columns
test('French and English form headers are matched to the same fields', () => {
  const english = ['Timestamp', 'Email', 'Player', 'Session timing', 'Session duration (min)',
    'Session intensity (CR-10)', 'Fatigue', 'Stress', 'Muscle soreness', 'Sleep', 'Specific pain', 'Location',
    'OSTRC Q1', 'OSTRC Q2', 'OSTRC Q3', 'OSTRC Q4', 'Availability'];
  const french = ['Horodateur', "Nom d'utilisateur", 'Qui es-tu ?',
    'Moment de la séance', 'Durée de la séance (min)',
    'Intensité ressentie (CR-10)', 'Fatigue', 'Stress', 'Courbatures', 'Sommeil', 'Douleur ou gêne spécifique ?',
    'Localisation', 'OSTRC_Q1', 'OSTRC_Q2', 'OSTRC_Q3', 'OSTRC_Q4', 'Disponibilité'];
  const expected = { timestamp: 0, email: 1, athlete: 2, moment: 3, duration: 4, intensity: 5, fatigue: 6, stress: 7,
    soreness: 8, sleep: 9, pain: 10, pain_location: 11, ostrc_q1: 12, ostrc_q2: 13, ostrc_q3: 14, ostrc_q4: 15,
    availability: 16 };
  assert.deepEqual(HBODCore.matchColumns(english), expected);
  assert.deepEqual(HBODCore.matchColumns(french), expected);
  // the e-mail column is taken before the name, and the order of the columns does not matter
  assert.deepEqual(HBODCore.matchColumns(['Nom', 'RPE', 'Durée', "Nom d'utilisateur", 'Statut']),
    { email: 3, athlete: 0, duration: 2, intensity: 1, availability: 4 });
  assert.deepEqual(HBODCore.matchColumns(['x', 'y']), {});
});

test('a file without the athlete, duration or intensity column is refused with a clear message', () => {
  assert.throws(() => HBODCore.toRecords([['Timestamp', 'Player', 'Fatigue'], ['2026-01-05', 'A', '2']]),
    /required columns: duration, intensity\. Columns recognised: timestamp, athlete, fatigue\./);
  assert.deepEqual(HBODCore.toRecords([]), []);
  assert.deepEqual(HBODCore.toRecords([[], ['', ' ']]), []);
});

test('records carry the fields of the form, with numbers, dates and answers read from text', () => {
  const text = 'Horodateur;Qui es-tu ?;Moment;Durée (min);Intensité (CR-10);Fatigue;Stress;Courbatures;Sommeil;' +
    'Douleur;Localisation;OSTRC_Q1;OSTRC_Q2;OSTRC_Q3;OSTRC_Q4;Statut\r\n' +
    '\r\n' +
    '05/01/2026 20:00:00; Amira ;Soir;90;5 - Dur;2;3;4;1;Oui;Genou;Reduced participation;0;;Mild;\r\n' +
    '1/6/2026 8:00:00 PM;Amira;;"7,5";6;;;;;Non;;;;;;Blessée\r\n' +
    ';Amira;;60;;2;2;2;2;;;;;;;\r\n';
  const records = HBODCore.toRecords(HBODCore.parseCSV(text));
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    date: '2026-01-05', athlete: 'Amira', moment: 'Soir', duration: 90, intensity: 5, sessionLoad: 450,
    fatigue: 2, stress: 3, soreness: 4, sleep: 1, pain: true, painLocation: 'Genou', ostrc: [17, 0, null, 8],
    availability: null });
  assert.deepEqual(records[1], {
    date: '2026-01-06', athlete: 'Amira', moment: '', duration: 7.5, intensity: 6, sessionLoad: 45,
    fatigue: null, stress: null, soreness: null, sleep: null, pain: false, painLocation: null,
    ostrc: [null, null, null, null], availability: 'Blessée' });
  assert.equal(records[2].date, null);
  assert.equal(records[2].sessionLoad, null);              // no intensity: no session load
});

test('date formats: day first on the 24-hour clock, month first with AM or PM', () => {
  assert.equal(HBODCore.parseDate('2026-03-04 08:00:00 PM UTC+1'), '2026-03-04');
  assert.equal(HBODCore.parseDate('03/04/2026 20:00:00'), '2026-04-03');
  assert.equal(HBODCore.parseDate('03/04/2026 8:00:00 PM'), '2026-03-04');
  assert.equal(HBODCore.parseDate('2026/03/04 8:00:00 AM'), '2026-03-04');
  assert.equal(HBODCore.parseDate('25/12/2026'), '2026-12-25');
  assert.equal(HBODCore.parseDate('12/25/2026'), '2026-12-25');
  assert.equal(HBODCore.parseDate('2026-03-04T19:30:00.000Z'), '2026-03-04');
  assert.equal(HBODCore.parseDate('30/02/2026'), null);
  assert.equal(HBODCore.parseDate('tomorrow'), null);
  assert.equal(HBODCore.parseDate(''), null);
});

test('calendar helpers', () => {
  assert.equal(HBODCore.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(HBODCore.addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(HBODCore.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(HBODCore.addDays('0099-12-31', 1), '0100-01-01');
  assert.equal(HBODCore.dayDiff('2025-07-01', '2026-02-23'), 237);
  assert.equal(HBODCore.dayDiff('2026-03-01', '2026-02-27'), -2);
  assert.deepEqual(HBODCore.dateRange('2026-02-27', '2026-03-02'),
    ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(HBODCore.dateRange('2026-03-02', '2026-03-01'), []);
  assert.equal(HBODCore.weekday('2026-01-05'), 0);           // a Monday
  assert.equal(HBODCore.weekday('2026-01-10'), 5);           // a Saturday
  assert.equal(HBODCore.weekday('1969-12-28'), 6);           // a Sunday
  assert.throws(() => HBODCore.addDays('2026-02-30', 1), TypeError);
  assert.throws(() => HBODCore.addDays('05/01/2026', 1), TypeError);
  assert.equal(HBODCore.formatLoad(420), '420');
  assert.equal(HBODCore.formatLoad(412.5), '412.5');
  assert.equal(HBODCore.formatLoad(332.449), '332.4');
  assert.equal(HBODCore.formatLoad(null), 'n/a');
  assert.equal(HBODCore.formatLoad(null, ''), '');
  assert.equal(HBODCore.formatRatio(1.0937019969278035), '1.09');
  assert.equal(HBODCore.formatRatio(null), 'n/a');
  assert.deepEqual(['b', 'a', 'B', 'é', 'Z'].sort(HBODCore.compareText), ['B', 'Z', 'a', 'b', 'é']);
});

// ------------------------------------------------------------------ calendar and roster
test('every calendar day from the first report to the last is processed for every athlete of the file', () => {
  const recs = [
    record('2026-01-07', 'Bo', { duration: 60, intensity: 5 }),
    record('2026-01-05', 'Al', { duration: 50, intensity: 4 }),
    record('2026-01-10', 'Al', { duration: 30, intensity: 6 }),
    record(null, 'Cy', { duration: 30, intensity: 6 }),         // named in the file, but the date is unreadable
    record('2026-01-08', '', { duration: 30, intensity: 6 }),
  ];
  const a = HBODCore.analyse(recs);
  assert.deepEqual(a.athletes, ['Al', 'Bo', 'Cy']);
  assert.equal(a.startDate, '2026-01-05');
  assert.equal(a.endDate, '2026-01-10');
  assert.deepEqual(a.dates, ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10']);
  assert.equal(a.days.length, 6);
  a.days.forEach((d, t) => {
    assert.equal(d.t, t);
    assert.deepEqual(d.athletes.map((x) => x.id), ['Al', 'Bo', 'Cy']);
  });
  assert.deepEqual(a.inputs.load.map((row) => row[0]), [200, null, null, null, null, 180]);
  assert.deepEqual(a.inputs.load.map((row) => row[1]), [null, null, 300, null, null, null]);
  assert.deepEqual(a.skipped, { undated: 1, unnamed: 1, outside: 0 });
  assert.equal(a.engineVersion, HBODEngine.VERSION);
  assert.equal(a.settings, HBODEngine.SETTINGS);
  assert.deepEqual(a.budget, { enabled: true, share: 0.10 });
  assert.equal(a.records, recs);
});

test('options: end date, start date and roster', () => {
  const recs = [record('2026-01-05', 'Al', { duration: 50, intensity: 4 }),
    record('2026-01-07', 'Bo', { duration: 60, intensity: 5 })];
  const later = HBODCore.analyse(recs, { endDate: '2026-01-09' });
  assert.equal(later.dates.length, 5);
  assert.equal(later.days[4].reporters, 0);
  const earlier = HBODCore.analyse(recs, { endDate: '06/01/2026' });      // dates in any accepted format
  assert.deepEqual(earlier.dates, ['2026-01-05', '2026-01-06']);
  assert.deepEqual(earlier.skipped, { undated: 0, unnamed: 0, outside: 1 });
  const shifted = HBODCore.analyse(recs, { startDate: '2026-01-03', roster: ['Zed', ' Al '] });
  assert.equal(shifted.startDate, '2026-01-03');
  assert.deepEqual(shifted.athletes, ['Al', 'Bo', 'Zed']);
  assert.equal(shifted.days[2].athletes[0].load, 200);                    // 5 January is day 2
  assert.equal(shifted.days[2].athletes[2].imputed, true);                // the roster athlete never reported
  const empty = HBODCore.analyse([], { startDate: '2026-01-05', roster: ['Al'] });
  assert.deepEqual(empty.dates, ['2026-01-05']);
  assert.throws(() => HBODCore.analyse([]), /No report with a readable date/);
  assert.throws(() => HBODCore.analyse(recs, { endDate: '2026-01-01' }), RangeError);
  assert.throws(() => HBODCore.analyse(recs, { endDate: 'soon' }), /not a readable date/);
  assert.throws(() => HBODCore.analyse(recs.concat([record('2046-01-05', 'Al')])), /more than ten years/);
});

// ------------------------------------------------------------------ session load
test('session load: sum of duration x intensity; a reported rest day is 0; no usable record is missing', () => {
  const recs = [
    record('2026-01-05', 'Two', { duration: 60, intensity: 5 }),
    record('2026-01-05', 'Two', { duration: 30, intensity: 7 }),          // second session of the day
    record('2026-01-05', 'Rest', { duration: 0, intensity: 0 }),
    record('2026-01-05', 'Half', { duration: 45 }),                       // intensity not given
    record('2026-01-05', 'Hoop', hooper(2, 2, 2, 2)),                     // wellness only
    record('2026-01-05', 'Mix', { duration: 45 }),
    record('2026-01-05', 'Mix', { duration: 40, intensity: 4 }),
    record('2026-01-06', 'Two', { duration: 50, intensity: 5 }),
  ];
  const a = HBODCore.analyse(recs, { roster: ['Silent'] });
  assert.deepEqual(a.athletes, ['Half', 'Hoop', 'Mix', 'Rest', 'Silent', 'Two']);
  assert.deepEqual(a.inputs.load[0], [null, null, 160, 0, null, 510]);
  assert.deepEqual(a.inputs.recordCount[0], [1, 1, 2, 1, 0, 2]);
  const day = a.days[0];
  assert.equal(day.reporters, 3);
  assert.equal(day.squadMedian, 160);                                     // median of 160, 0 and 510
  const by = new Map(day.athletes.map((x) => [x.id, x]));
  assert.deepEqual([by.get('Rest').reported, by.get('Rest').imputed, by.get('Rest').load], [true, false, 0]);
  for (const name of ['Half', 'Hoop', 'Silent']) {
    assert.deepEqual([by.get(name).reported, by.get(name).imputed, by.get(name).load], [false, true, 160], name);
  }
  assert.equal(by.get('Two').load, 510);
  // the next day only one athlete reports: everybody else receives that median, nobody is read as resting
  assert.deepEqual(a.days[1].athletes.map((x) => x.load), [250, 250, 250, 250, 250, 250]);
  assert.deepEqual(a.days[1].athletes.map((x) => x.imputed), [true, true, true, true, true, false]);
});

// ------------------------------------------------------------------ Hooper items
test('Hooper items: the last record of the day with all four items, otherwise no wellness correction', () => {
  const recs = [];
  for (let t = 0; t < 16; t++) {
    const d = HBODCore.addDays(START, t);
    recs.push(record(d, 'All', Object.assign({ duration: 60, intensity: 5 }, hooper(3, 2, 4, 1))));
    recs.push(record(d, 'Three', { duration: 60, intensity: 5, fatigue: 3, stress: 2, soreness: 4 }));
    recs.push(record(d, 'None', { duration: 60, intensity: 5 }));
    recs.push(record(d, 'Late', Object.assign({ duration: 60, intensity: 5 }, hooper(2, 2, 2, 2))));
    recs.push(record(d, 'Late', hooper(6, 5, 6, 7)));                      // a second, complete answer
    recs.push(record(d, 'Late', { fatigue: 1 }));                          // an incomplete one afterwards
    recs.push(record(d, 'Split', { duration: 60, intensity: 5, fatigue: 3, stress: 2 }));
    recs.push(record(d, 'Split', { soreness: 4, sleep: 5, stress: 6 }));   // four items, but never in one record
  }
  const a = HBODCore.analyse(recs);
  assert.deepEqual(a.athletes, ['All', 'Late', 'None', 'Split', 'Three']);
  // the engine receives the items in the order of File S1: sleep, stress, fatigue, soreness
  assert.deepEqual(a.inputs.hooper[0], [[1, 2, 3, 4], [7, 5, 6, 6], null, null, null]);
  assert.deepEqual(a.inputs.items[0], [hooper(3, 2, 4, 1), hooper(6, 5, 6, 7), null, hooper(3, 6, 4, 5),
    { fatigue: 3, stress: 2, soreness: 4, sleep: null }]);
  for (const t of [13, 14, 15]) {
    const day = HBODCore.dayReport(a, a.dates[t]);
    const by = new Map(day.athletes.map((x) => [x.name, x]));
    assert.equal(by.get('All').hooperMean, 2.5);
    assert.equal(by.get('Late').hooperMean, 6);
    assert.equal(by.get('All').corrected, t >= 14);
    assert.equal(by.get('Late').corrected, t >= 14);
    for (const name of ['None', 'Split', 'Three']) {
      assert.equal(by.get(name).corrected, false);
      assert.equal(by.get(name).hooperMean, null);
      assert.ok(by.get(name).notes.includes('No wellness correction today (Hooper items incomplete).'));
    }
    assert.deepEqual(by.get('Three').hooper, { fatigue: 3, stress: 2, soreness: 4, sleep: null });
    assert.equal(by.get('None').hooper, null);
    assert.ok(by.get('All').notes.includes(t >= 14 ? 'Wellness correction applied (all four Hooper items).'
      : 'No wellness correction today (the correction starts after 14 days of data).'));
  }
});

// ------------------------------------------------------------------ availability
test('availability answers in English and French', () => {
  const reason = HBODCore.availabilityReason;
  for (const [text, expected] of [
    ['Injured', 'injured'], ['injury - hamstring', 'injured'], ['Blessé', 'injured'], ['BLESSURE', 'injured'],
    ['Ill', 'ill'], ['illness', 'ill'], ['Sick', 'ill'], ['Malade', 'ill'], ['maladie', 'ill'],
    ['Return to play', 'return to play'], ['RTP', 'return to play'], ['Reprise', 'return to play'],
    ['returning after injury', 'return to play'],
    ['Unavailable', 'unavailable'], ['Indisponible', 'unavailable'], ['Not available', 'unavailable'],
    ['Available', null], ['Disponible', null], ['Fit', null], ['OK', null], ['', null], ['  ', null], [null, null],
    ['Will train', null], ['Still fine', null],
  ]) {
    assert.equal(reason(text), expected, String(text));
  }
});

test('unavailable athletes: availability log and availability column', () => {
  const squad = ['Col', 'Log', 'Open', 'Ok1', 'Ok2', 'Ok3'];
  const recs = [];
  for (let t = 0; t < 10; t++) {
    const d = HBODCore.addDays(START, t);
    for (const name of squad) {
      const fields = { duration: 60, intensity: 5, availability: 'Available' };
      if (name === 'Col' && (t === 3 || t === 4)) fields.availability = t === 3 ? 'Malade' : 'Return to play';
      if (name === 'Log') { fields.duration = 200; fields.intensity = 9; }  // reports, although injured
      recs.push(record(d, name, fields));
    }
  }
  const log = [
    { athlete: 'Log', from: '2026-01-07', to: '2026-01-09', reason: 'injured' },
    { athlete: 'Open', from: '12/01/2026', to: null },                     // still open, no reason given
    { athlete: 'Nobody', from: '2026-01-05', to: '2026-01-06', reason: 'ill' },
  ];
  const a = HBODCore.analyse(recs, { availability: log });
  const col = (name) => a.inputs.unavailable.map((row) => row[a.athletes.indexOf(name)]);
  const why = (name) => a.inputs.unavailableReason.map((row) => row[a.athletes.indexOf(name)]);
  assert.deepEqual(col('Col'), [false, false, false, true, true, false, false, false, false, false]);
  assert.deepEqual(why('Col').slice(3, 5), ['ill', 'return to play']);
  assert.deepEqual(col('Log'), [false, false, true, true, true, false, false, false, false, false]);
  assert.deepEqual(why('Log').slice(1, 6), [null, 'injured', 'injured', 'injured', null]);
  assert.deepEqual(col('Open'), [false, false, false, false, false, false, false, true, true, true]);
  assert.equal(why('Open')[9], 'unavailable');
  assert.deepEqual(a.availability[1], { athlete: 'Open', from: '2026-01-12', to: null, reason: 'unavailable' });
  assert.ok(!a.athletes.includes('Nobody'));                               // outside the roster: ignored

  // zero load, left out of the squad median, never listed, and counted apart
  const day = HBODCore.dayReport(a, '2026-01-08');
  const logged = day.athletes.find((x) => x.name === 'Log');
  assert.equal(logged.unavailable, true);
  assert.equal(logged.unavailableReason, 'injured');
  assert.equal(logged.status, 'unavailable');
  assert.equal(logged.load, 0);
  assert.equal(logged.reportedLoad, 1800);
  assert.equal(logged.rank, null);
  assert.deepEqual(logged.notes.slice(0, 1), ['Unavailable (injured): zero load.']);
  assert.equal(day.squadMedian, 300);
  assert.deepEqual([day.counts.athletes, day.counts.healthy, day.counts.unavailable], [6, 4, 2]);
  assert.equal(day.budget.healthy, 4);
  assert.equal(day.athletes[day.athletes.length - 1].status, 'unavailable');
  const open = HBODCore.dayReport(a, '2026-01-14').athletes.find((x) => x.name === 'Open');
  assert.deepEqual(open.notes.slice(0, 1), ['Unavailable: zero load.']);

  const refused = (period, message) => assert.throws(() => HBODCore.analyse(recs, { availability: [period] }), message);
  refused({ athlete: 'Log', from: 'someday' }, /not a readable date/);
  refused({ from: '2026-01-07' }, /does not name an athlete/);
  refused({ athlete: 'Log', from: '2026-01-07', to: '2026-01-06' }, /ends before it starts/);
});

// ------------------------------------------------------------------ planning indices
test('planning indices follow the uncoupled rolling average of File S1 on the load series of the engine', () => {
  const a = goldenAnalysis();
  let compared = 0, undefinedRatios = 0;
  a.roster.forEach((name, i) => {
    const s = HBODCore.series(a, name);
    for (let t = 0; t < golden.days; t++) {
      const used = s.load.slice(Math.max(0, t - 6), t + 1);
      const before = s.load.slice(Math.max(0, t - 34), Math.max(0, t - 6));
      // definition: mean of the last 7 days, mean of the 28 days before those 7
      if (t >= 6) assert.ok(Math.abs(s.acute[t] - used.reduce((x, y) => x + y, 0) / 7) < 1e-9);
      else assert.equal(s.acute[t], null);
      if (t >= 34) assert.ok(Math.abs(s.chronic[t] - before.reduce((x, y) => x + y, 0) / 28) < 1e-9);
      else assert.equal(s.chronic[t], null);
      // File S1 stores its ratio in single precision
      const expected = golden.ratio[i][t];
      if (expected === null) { assert.equal(s.ratio[t], null, `${name}, day ${t}`); undefinedRatios += 1; }
      else { assert.equal(Math.fround(s.ratio[t]), Math.fround(expected), `${name}, day ${t}`); compared += 1; }
      assert.deepEqual(HBODCore.planningIndices(s.load, t),
        { acute: s.acute[t], chronic: s.chronic[t], ratio: s.ratio[t] });
    }
  });
  assert.equal(compared + undefinedRatios, golden.athletes * golden.days);
  assert.ok(compared > 4900);
  // the load series is the one the engine used: reported, squad median or zero
  const day = HBODCore.dayReport(a, a.dates[100]);
  for (const x of day.athletes) {
    assert.equal(x.load, x.unavailable ? 0 : (x.reported ? x.reportedLoad : day.squadMedian));
    assert.deepEqual(x.planning, HBODCore.planningIndices(HBODCore.series(a, x.name).load, 100));
  }
});

test('the application path reproduces the probabilities and alerts of File S1 from a responses file', () => {
  const a = goldenAnalysis();
  let maxDiff = 0, sameAlert = 0;
  a.roster.forEach((name, i) => {
    const k = a.athletes.indexOf(name);
    for (let t = 0; t < golden.days; t++) {
      const x = a.days[t].athletes[k], ref = golden.p[i][t];
      assert.equal(x.probability === null, ref === null);
      if (ref !== null) maxDiff = Math.max(maxDiff, Math.abs(x.probability - ref));
      if (x.alert === (golden.alert[i][t] === '1')) sameAlert += 1;
    }
  });
  assert.ok(maxDiff < 1e-9, `maximum absolute difference ${maxDiff}`);
  assert.equal(sameAlert, golden.athletes * golden.days);
});

test('acute load, chronic load and their ratio are not connected to any status, rank or note', () => {
  const a = goldenAnalysis();
  let highRatioNotListed = 0, lowRatioListed = 0;
  for (let t = 0; t < golden.days; t += 1) {
    const day = HBODCore.dayReport(a, a.dates[t]);
    // statuses and ranks follow from availability, the probability and the alert rate alone
    const healthy = day.athletes.filter((x) => !x.unavailable);
    const scored = healthy.filter((x) => x.probability !== null).sort((p, q) => q.probability - p.probability);
    const above = scored.filter((x) => x.alert);
    const cap = HBODEngine.dailyCap(healthy.length, 0.10);
    assert.equal(day.budget.cap, cap);
    assert.deepEqual(day.budget.listed, above.slice(0, cap).map((x) => x.name));
    assert.deepEqual(day.budget.overflow, above.slice(cap).map((x) => x.name));
    for (const x of day.athletes) {
      const expected = x.unavailable ? 'unavailable' : x.probability === null ? 'baseline-building'
        : day.budget.listed.includes(x.name) ? 'listed' : x.alert ? 'above-outside-budget' : 'below-threshold';
      assert.equal(x.status, expected);
      assert.deepEqual(Object.keys(x.planning), ['acute', 'chronic', 'ratio']);    // numbers only: no flag, no band
      assert.ok(!x.notes.some((n) => /ratio|acute|chronic/i.test(n)));
      // 1.30 was the threshold of the rule-based prototype; it means nothing here
      const ratio = x.planning.ratio;
      if (ratio !== null && ratio > 1.30 && x.status === 'below-threshold') highRatioNotListed += 1;
      if (ratio !== null && ratio <= 1.30 && x.status === 'listed') lowRatioListed += 1;
    }
  }
  assert.ok(highRatioNotListed > 0);
  assert.ok(lowRatioListed > 0);
});

// ------------------------------------------------------------------ statuses, order, notes
// Twelve athletes over 41 days. On the last day four of them report much worse Hooper items, two are
// unavailable, two have a declared health problem, and some reports are missing or incomplete.
function scenario() {
  const squad = names(12);
  const recs = [];
  for (let t = 0; t <= 40; t++) {
    const d = HBODCore.addDays(START, t);
    squad.forEach((name, i) => {
      const last = t === 40;
      if (last && name === 'A04') return;                                  // no form at all
      let fields = Object.assign({}, session(t, i), hooper(2, 2, 2, 2));
      if (last && name === 'A03') Object.assign(fields, hooper(7, 7, 7, 7));
      if (last && name === 'A05') Object.assign(fields, hooper(6, 6, 6, 6));
      if (last && name === 'A07') Object.assign(fields, hooper(7, 6, 7, 6));
      if (last && name === 'A09') Object.assign(fields, hooper(5, 6, 6, 6));
      if (last && name === 'A06') Object.assign(fields, { duration: 0, intensity: 0 });   // reported rest day
      if (last && name === 'A08') fields = hooper(2, 2, 2, 2);             // wellness only, no session
      if (last && name === 'A10') fields.sleep = null;                     // three Hooper items
      if (last && name === 'A12') fields.availability = 'Blessé';
      if (last && name === 'A02') Object.assign(fields, { pain: true, painLocation: 'Ankle' });
      if (t === 38 && name === 'A01') fields.ostrc = [25, 17, 17, 8];
      recs.push(record(d, name, fields));
    });
  }
  const log = [{ athlete: 'A11', from: HBODCore.addDays(START, 30), to: null, reason: 'return to play' }];
  return HBODCore.analyse(recs, { availability: log });
}

test('statuses, ranks and display order of the day report', () => {
  const a = scenario();
  const day = HBODCore.dayReport(a);                                       // default: the last day
  assert.equal(day.date, HBODCore.addDays(START, 40));
  assert.equal(day.t, 40);
  assert.equal(day.dayNumber, 41);
  assert.equal(day.startDate, START);
  assert.equal(day.engineVersion, HBODEngine.VERSION);
  const by = new Map(day.athletes.map((x) => [x.name, x]));

  // ten healthy athletes: the cap is one, so one athlete is listed and the three others stay above the threshold
  assert.deepEqual(day.budget, { enabled: true, share: 0.10, healthy: 10, cap: 1, listed: day.budget.listed,
    overflow: day.budget.overflow, ranking: day.budget.ranking });
  assert.equal(day.budget.listed.length, 1);
  assert.equal(day.budget.overflow.length, 3);
  assert.deepEqual(day.budget.listed.concat(day.budget.overflow).sort(), ['A03', 'A05', 'A07', 'A09']);
  assert.equal(day.budget.ranking.length, 10);
  for (const name of ['A03', 'A05', 'A07', 'A09']) {
    assert.equal(by.get(name).alert, true);
    assert.ok(by.get(name).probability >= 0.8);
    assert.equal(by.get(name).driver, 'wellness strain');
  }
  assert.equal(by.get(day.budget.listed[0]).status, 'listed');
  assert.equal(by.get(day.budget.listed[0]).rank, 1);
  day.budget.overflow.forEach((name, k) => {
    assert.equal(by.get(name).status, 'above-outside-budget');
    assert.equal(by.get(name).rank, k + 2);
  });
  day.budget.ranking.forEach((name, k) => {
    assert.equal(by.get(name).rank, k + 1);
    if (k > 0) assert.ok(by.get(day.budget.ranking[k - 1]).probability >= by.get(name).probability);
  });
  for (const name of ['A01', 'A02', 'A04', 'A06', 'A08', 'A10']) assert.equal(by.get(name).status, 'below-threshold');
  for (const name of ['A11', 'A12']) {
    assert.equal(by.get(name).status, 'unavailable');
    assert.equal(by.get(name).rank, null);
  }
  assert.equal(by.get('A11').unavailableReason, 'return to play');
  assert.equal(by.get('A12').unavailableReason, 'injured');
  assert.equal(by.get('A01').health.action, 'STOP');
  assert.equal(by.get('A02').health.action, 'HOLD');
  assert.equal(by.get('A02').health.location, 'Ankle');

  // order: health gate (STOP, then HOLD), today's list, above the threshold outside the budget, below the
  // threshold by probability, unavailable by name
  const below = day.budget.ranking.filter((n) => !['A01', 'A02'].includes(n) && by.get(n).status === 'below-threshold');
  assert.deepEqual(day.athletes.map((x) => x.name),
    ['A01', 'A02'].concat(day.budget.listed, day.budget.overflow, below, ['A11', 'A12']));
  assert.deepEqual(day.counts, { athletes: 12, healthy: 10, unavailable: 2, reported: 8, missing: 2, listed: 1,
    aboveOutsideBudget: 3, belowThreshold: 6, baselineBuilding: 0, healthGate: 2 });
  assert.equal(day.reporters, 8);
  assert.deepEqual(Array.from(HBODCore.STATUS_ORDER),
    ['listed', 'above-outside-budget', 'below-threshold', 'baseline-building', 'unavailable']);
  for (const s of HBODCore.STATUS_ORDER) assert.equal(typeof HBODCore.STATUS_LABELS[s], 'string');

  // report fields of one athlete
  const x = by.get('A03');
  assert.deepEqual(x.hooper, hooper(7, 7, 7, 7));
  assert.equal(x.hooperMean, 7);
  assert.equal(x.reported, true);
  assert.equal(x.reportedLoad, x.load);
  assert.equal(x.recordsToday, 1);
  assert.equal(x.daysReported28, 28);
  assert.equal(by.get('A04').daysReported28, 27);
  assert.ok(Math.abs(x.deficit - (x.fatigue - x.fitness)) < 1e-15);
  assert.equal(x.baseline.days, 40);
  assert.ok(x.pStrain > x.pDeficit);
  assert.ok(Math.abs(x.logit - Math.log(x.probability / (1 - x.probability))) < 1e-9);
});

test('before day 28 the baseline is building and nobody is listed', () => {
  const a = scenario();
  const day = HBODCore.dayReport(a, HBODCore.addDays(START, 20));
  assert.equal(day.counts.baselineBuilding, 12);
  assert.equal(day.counts.listed, 0);
  assert.deepEqual(day.budget.ranking, []);
  for (const x of day.athletes) {
    assert.equal(x.status, 'baseline-building');
    assert.equal(x.probability, null);
    assert.equal(x.rank, null);
    assert.equal(x.driver, null);
    assert.ok(x.notes.includes(
      'No probability yet: the personal baseline needs 28 previous days of data (20 so far).'));
  }
  assert.deepEqual(day.athletes.map((x) => x.name), names(12));            // by name
  const first = HBODCore.dayReport(a, HBODCore.addDays(START, 28));
  assert.equal(first.counts.baselineBuilding, 0);
  assert.throws(() => HBODCore.dayReport(a, '2025-01-01'), RangeError);
  assert.throws(() => HBODCore.dayReport(a, HBODCore.addDays(START, 41)), /outside the data/);
});

test('notes state in plain sentences what was computed for the athlete today', () => {
  const day = HBODCore.dayReport(scenario());
  const by = new Map(day.athletes.map((x) => [x.name, x]));
  const median = HBODCore.formatLoad(day.squadMedian);
  const imputedNote = `No session load reported today: the squad median (${median} AU) was used and the uncertainty ` +
    'of fitness and fatigue was multiplied by four.';
  const corrected = 'Wellness correction applied (all four Hooper items).';
  const wellness = 'Mainly driven by wellness strain: check symptoms, since a wellness-driven alert can be an early ' +
    'sign of illness.';
  assert.deepEqual(by.get('A04').notes, [imputedNote, 'No wellness correction today (Hooper items incomplete).']);
  assert.deepEqual(by.get('A08').notes, [imputedNote,
    'A form was received today, but it holds no usable session duration and intensity.', corrected]);
  assert.deepEqual(by.get('A06').notes, [corrected]);                      // a reported rest day needs no note
  assert.deepEqual(by.get('A10').notes, ['No wellness correction today (Hooper items incomplete).']);
  assert.deepEqual(by.get('A11').notes, ['Unavailable (return to play): zero load.', corrected]);
  assert.deepEqual(by.get('A12').notes, ['Unavailable (injured): zero load.', corrected]);
  for (const name of ['A03', 'A05', 'A07', 'A09']) assert.deepEqual(by.get(name).notes, [corrected, wellness]);
  assert.equal(by.get('A04').imputed, true);
  assert.equal(by.get('A04').load, day.squadMedian);
  assert.equal(by.get('A04').reportedLoad, null);
  assert.equal(by.get('A04').recordsToday, 0);
  assert.equal(by.get('A06').load, 0);

  // a day on which nobody reports: the squad median is zero and the note says so
  const silent = HBODCore.dayReport(HBODCore.analyse(scenario().records, { endDate: HBODCore.addDays(START, 41) }));
  assert.equal(silent.reporters, 0);
  assert.ok(silent.athletes.find((x) => x.name === 'A03').notes[0].startsWith(
    'No session load reported today by any available athlete: a load of 0 AU was used'));

  // a load-driven alert is described as such
  const g = goldenAnalysis();
  let loadDriven = 0;
  for (let t = 28; t < golden.days && loadDriven === 0; t++) {
    for (const x of HBODCore.dayReport(g, g.dates[t]).athletes) {
      if (x.status === 'listed' && x.driver === 'load deficit') {
        assert.ok(x.notes.includes('Mainly driven by the load deficit (modelled fatigue minus modelled fitness).'));
        assert.ok(x.pDeficit > x.pStrain);
        loadDriven += 1;
      }
    }
  }
  assert.ok(loadDriven > 0);
});

test('the alert rate is a setting: share and on or off', () => {
  const recs = scenario().records;
  const log = [{ athlete: 'A11', from: HBODCore.addDays(START, 30), to: null, reason: 'return to play' }];
  const wider = { enabled: true, share: 0.30 };
  const wide = HBODCore.dayReport(HBODCore.analyse(recs, { availability: log, budget: wider }));
  assert.deepEqual([wide.budget.share, wide.budget.cap], [0.30, 3]);
  assert.deepEqual([wide.counts.listed, wide.counts.aboveOutsideBudget], [3, 1]);
  const off = HBODCore.dayReport(HBODCore.analyse(recs, { availability: log, budget: { enabled: false } }));
  assert.deepEqual([off.budget.enabled, off.counts.listed, off.counts.aboveOutsideBudget], [false, 4, 0]);
  const usual = HBODCore.dayReport(HBODCore.analyse(recs, { availability: log }));
  // the budget changes the list, never the probabilities
  const p = (day) => day.athletes.map((x) => [x.name, x.probability]).sort();
  assert.deepEqual(p(wide), p(usual));
  assert.deepEqual(p(off), p(usual));
  for (const share of [0, -0.1, 1.5, 'many']) {
    assert.throws(() => HBODCore.analyse(recs, { budget: { enabled: true, share: share } }), RangeError);
  }
  // 25 healthy athletes: two per day
  const g = goldenAnalysis();
  const full = g.dates.map((d, t) => g.lists[t]).find((l) => l.healthy === 25);
  assert.equal(full.cap, 2);
  assert.ok(g.lists.every((l) => l.listed.length <= l.cap && l.cap === HBODEngine.dailyCap(l.healthy, 0.10)));
});

// ------------------------------------------------------------------ series
test('series of one athlete over time', () => {
  const a = scenario();
  const s = HBODCore.series(a, 'A03');
  const keys = ['name', 'dates', 'load', 'reportedLoad', 'reported', 'imputed', 'unavailable', 'probability',
    'pDeficit', 'pStrain', 'alert', 'status', 'listed', 'fitness', 'fatigue', 'strain', 'deficit', 'acute', 'chronic',
    'ratio', 'hooperMean', 'items', 'squadMedian'];
  assert.deepEqual(Object.keys(s), keys);
  for (const k of keys) if (Array.isArray(s[k])) assert.equal(s[k].length, 41, k);
  assert.deepEqual(s.dates, a.dates);
  assert.equal(s.probability[27], null);
  assert.equal(typeof s.probability[28], 'number');
  assert.equal(s.status[20], 'baseline-building');
  assert.equal(s.status[40], HBODCore.dayReport(a).athletes.find((x) => x.name === 'A03').status);
  assert.equal(s.listed.filter(Boolean).length, s.status.filter((x) => x === 'listed').length);
  assert.equal(s.items.sleep[40], 7);
  assert.equal(s.items.fatigue[0], 2);
  assert.equal(s.hooperMean[40], 7);
  assert.equal(s.acute[5], null);
  assert.equal(s.chronic[33], null);
  assert.equal(typeof s.ratio[34], 'number');
  const day = HBODCore.dayReport(a, a.dates[36]);
  const x = day.athletes.find((y) => y.name === 'A03');
  assert.deepEqual([s.load[36], s.fitness[36], s.fatigue[36], s.strain[36], s.deficit[36], s.probability[36]],
    [x.load, x.fitness, x.fatigue, x.strain, x.deficit, x.probability]);
  assert.deepEqual({ acute: s.acute[36], chronic: s.chronic[36], ratio: s.ratio[36] }, x.planning);
  assert.equal(s.squadMedian[36], day.squadMedian);
  const away = HBODCore.series(a, 'A11');
  assert.deepEqual(away.unavailable.slice(28, 32), [false, false, true, true]);
  assert.equal(away.load[35], 0);
  assert.equal(away.status[40], 'unavailable');
  assert.throws(() => HBODCore.series(a, 'Nobody'), RangeError);
});

// ------------------------------------------------------------------ audit rows
test('audit rows: one row per athlete with the documented columns', () => {
  const columns = ['generated_at', 'data_through', 'day_number', 'athlete', 'status', 'probability', 'alert', 'on_list',
    'rank', 'p_deficit', 'p_strain', 'driver', 'report', 'load_used', 'squad_median', 'unavailable', 'health_action',
    'acute_load', 'chronic_load', 'ratio', 'budget_enabled', 'budget_share', 'budget_cap', 'engine_version'];
  assert.deepEqual(Array.from(HBODCore.AUDIT_COLUMNS), columns);
  const day = HBODCore.dayReport(scenario());
  const rows = HBODCore.auditRows(day, '2026-02-14T20:00:00Z');
  assert.equal(rows.length, 12);
  rows.forEach((row, k) => {
    const x = day.athletes[k];
    assert.deepEqual(Object.keys(row), columns);
    assert.deepEqual(row, {
      generated_at: '2026-02-14T20:00:00Z', data_through: day.date, day_number: 41, athlete: x.name, status: x.status,
      probability: x.probability, alert: x.alert, on_list: x.status === 'listed', rank: x.rank, p_deficit: x.pDeficit,
      p_strain: x.pStrain, driver: x.driver, report: x.reported ? 'reported' : 'missing', load_used: x.load,
      squad_median: day.squadMedian, unavailable: x.unavailable, health_action: x.health.action,
      acute_load: x.planning.acute, chronic_load: x.planning.chronic, ratio: x.planning.ratio, budget_enabled: true,
      budget_share: 0.10, budget_cap: 1, engine_version: HBODEngine.VERSION });
  });
  assert.equal(rows.filter((r) => r.on_list).length, 1);
  assert.equal(rows.find((r) => r.athlete === 'A04').report, 'missing');
  assert.equal(rows.find((r) => r.athlete === 'A01').health_action, 'STOP');
  // the probability is written in full precision and read back unchanged
  const csv = HBODCore.parseCSV(HBODCore.toCSV(rows, HBODCore.AUDIT_COLUMNS));
  assert.deepEqual(csv[0], columns);
  assert.equal(csv.length, 13);
  rows.forEach((row, k) => assert.equal(Number(csv[k + 1][5]), row.probability));
  // early in the data the probability is empty, not zero
  const early = HBODCore.auditRows(HBODCore.dayReport(scenario(), HBODCore.addDays(START, 3)), 'now');
  assert.equal(early[0].probability, null);
  assert.equal(HBODCore.parseCSV(HBODCore.toCSV(early, HBODCore.AUDIT_COLUMNS))[1][5], '');
});

// ------------------------------------------------------------------ command line
test('command line: the data of the day and the audit log are written on this computer', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbod-cli-'));
  try {
    const cli = path.join(__dirname, '..', 'cli', 'hbod.js');
    const input = path.join(__dirname, 'fixtures', 'health_gate_S5.csv');
    const json = path.join(dir, 'day.json'), audit = path.join(dir, 'audit.csv');
    const run = (args) => spawnSync(process.execPath, [cli].concat(args), { encoding: 'utf8' });

    const first = run(['--input', input, '--json', json, '--audit', audit, '--generated-at', '2026-04-01T08:00:00Z']);
    assert.equal(first.status, 0, first.stderr);
    const records = HBODCore.toRecords(HBODCore.parseCSV(fs.readFileSync(input, 'utf8')));
    const expected = HBODCore.dayReport(HBODCore.analyse(records));
    assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), JSON.parse(JSON.stringify(expected)));

    // a second run, for an earlier day and without the budget, appends to the same audit log under one header
    const second = run(['--input', input, '--date', '2026-03-20', '--no-budget', '--audit', audit,
      '--generated-at', '2026-04-01T08:05:00Z']);
    assert.equal(second.status, 0, second.stderr);
    const rows = HBODCore.parseCSV(fs.readFileSync(audit, 'utf8'));
    assert.deepEqual(rows[0], Array.from(HBODCore.AUDIT_COLUMNS));
    assert.equal(rows.length, 11);
    assert.deepEqual(rows.slice(1).map((r) => r[1]), Array(5).fill('2026-03-31').concat(Array(5).fill('2026-03-20')));
    assert.deepEqual(rows.slice(1).map((r) => r[0]),
      Array(5).fill('2026-04-01T08:00:00Z').concat(Array(5).fill('2026-04-01T08:05:00Z')));
    assert.deepEqual(rows.slice(1).map((r) => r[20]), Array(5).fill('true').concat(Array(5).fill('false')));

    // mistakes are answered with a message and a non-zero exit code
    const none = run([]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /--input is required/);
    const outside = run(['--input', input, '--date', '2027-01-01']);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /outside the data/);
    const both = run(['--input', input, '--budget', '0.2', '--no-budget']);
    assert.equal(both.status, 1);
    const unknown = run(['--input', input, '--upload', 'somewhere']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option/);
    const foreign = path.join(dir, 'other.csv');
    fs.writeFileSync(foreign, 'date,athlete,decision\n');
    const refused = run(['--input', input, '--audit', foreign]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /other columns/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
