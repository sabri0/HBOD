/*
 * HBOD analytical core (JavaScript).
 *
 * Reads the form responses of one squad, prepares the daily inputs of the HBOD engine (engine.js), runs it over
 * every calendar day and assembles what the application, the daily report and the language-model layer show.
 *
 * The decision comes from the engine only: the posterior probability of Equation 14 and the alert budget. Acute
 * load, chronic load and their ratio are computed here for planning; nothing in this file reads them to decide,
 * rank, flag or word anything.
 *
 * Ingest (column matching, numbers, yes/no answers, dates, Oslo item scores) and the health module (daily health
 * item, weekly Oslo questionnaire, health gate) follow the Python core of the rule-based prototype function by
 * function, so that French and English form exports are read exactly as before. Where Python and JavaScript differ
 * in a detail (whitespace, digits of other scripts, rounding of halves), the Python behaviour is reproduced.
 *
 * Pure computation: no DOM, no network, no storage, no clock. Runs unchanged in the browser and in Node.js.
 * Dates are calendar days written 'YYYY-MM-DD'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.HBODCore = factory(root.HBODEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (HBODEngine) {
  'use strict';

  // ------------------------------------------------------------------ fixed wording
  // Sentences shared by the application, the report and the prompt of the language-model layer.
  const WORDING = Object.freeze({
    probability: "The probability shows how far the athlete's modelled state sits beyond his or her own baseline. " +
      'It is not an injury risk.',
    probabilityDetail: 'It is the probability that the fatigue-minus-fitness deficit or the wellness strain exceeds ' +
      "the athlete's own baseline of up to 42 previous days by one standard deviation. An alert is raised when it " +
      'reaches 0.80.',
    planning: 'Acute load, chronic load and their ratio are shown for planning only. They do not trigger any decision.',
    missing: 'A missing session load is replaced by the squad median of that day and the uncertainty of fitness and ' +
      'fatigue is multiplied by four. A missing day is never treated as rest.',
    budget: 'The alert budget ranks athletes by probability and caps the daily list at about 10% of healthy ' +
      'athlete-days, about two athletes per day in a squad of 25.',
    gate: 'The health gate sits above load and wellness: it holds, refers or stops an athlete with a declared ' +
      'problem, whatever the probability shows.',
    support: 'HBOD supports the decision; the coach keeps the final decision.',
    privacy: 'All computation runs on this device. No data are uploaded.',
    access: 'HBOD is free for academic and training use.'
  });

  // Texts of the three tiers of the health gate, unchanged from the rule-based prototype.
  const HEALTH_TEXT = Object.freeze({
    STOP: 'Immediate stop: no training today; arrange an urgent medical assessment before any return to load.',
    REFER: 'Reduce and refer: cut load and refer the athlete to the medical staff; do not progress until the ' +
      'problem resolves.',
    HOLD: 'Hold, not increase: an athlete-reported health problem is present; keep the load and monitor.'
  });
  const HEALTH_ACTIONS = Object.freeze(['STOP', 'REFER', 'HOLD']);

  // Statuses of an athlete on one day, in display order, with the text label shown next to each.
  const STATUS_ORDER = Object.freeze(['listed', 'above-outside-budget', 'below-threshold', 'baseline-building',
    'unavailable']);
  const STATUS_LABELS = Object.freeze({
    'listed': "On today's list",
    'above-outside-budget': "Above the threshold, outside today's alert budget",
    'below-threshold': 'Below the threshold',
    'baseline-building': 'Baseline building',
    'unavailable': 'Unavailable'
  });

  // ------------------------------------------------------------------ text helpers that follow Python
  // Whitespace as Python's str.strip, str.split and the regular-expression class \s understand it.
  const PY_SPACE = '\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const STRIP_RE = new RegExp('^[' + PY_SPACE + ']+|[' + PY_SPACE + ']+$', 'g');
  const SPACE_RUN_RE = new RegExp('[' + PY_SPACE + ']+');

  function strip(s) { return String(s).replace(STRIP_RE, ''); }

  // Decimal digits of any script, which Python converts to numbers, and the other characters that Python counts
  // as digits but cannot convert (superscripts, circled digits and similar).
  const DECIMAL_DIGIT_RE = /\p{Nd}/u;
  const OTHER_DIGIT_RE = new RegExp('[\\u00b2\\u00b3\\u00b9\\u1369-\\u1371\\u19da\\u2070\\u2074-\\u2079' +
    '\\u2080-\\u2089\\u2460-\\u2468\\u2474-\\u247c\\u2488-\\u2490\\u24ea\\u24f5-\\u24fd\\u24ff' +
    '\\u2776-\\u277e\\u2780-\\u2788\\u278a-\\u2792' +
    '\\u{10a40}-\\u{10a43}\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}]', 'u');

  // Value 0 to 9 of a decimal digit, or -1. Unicode encodes the ten digits of a script in ascending order.
  function digitValue(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 48 && cp <= 57) return cp - 48;
    if (cp < 128 || !DECIMAL_DIGIT_RE.test(ch)) return -1;
    let start = cp;
    while (DECIMAL_DIGIT_RE.test(String.fromCodePoint(start - 1))) start -= 1;
    return (cp - start) % 10;
  }

  // Integer written with decimal digits of any script, with optional surrounding spaces.
  function toInt(text) {
    let v = 0;
    for (const ch of text) { const d = digitValue(ch); if (d >= 0) v = v * 10 + d; }
    return v;
  }

  // Order of strings by Unicode code point, the order Python uses to sort text.
  function compareText(a, b) {
    const x = Array.from(a), y = Array.from(b);
    const n = Math.min(x.length, y.length);
    for (let k = 0; k < n; k++) {
      const d = x[k].codePointAt(0) - y[k].codePointAt(0);
      if (d !== 0) return d;
    }
    return x.length - y.length;
  }

  // Rounding to the nearest integer with halves going to the even neighbour, as Python's round does.
  function roundHalfEven(x) {
    const f = Math.floor(x), r = x - f;
    if (r < 0.5) return f;
    if (r > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // ------------------------------------------------------------------ ingest: numbers and answers
  /**
   * toFloat(x) -> number | null
   * Reads the leading number of a form answer. A decimal comma is accepted and text after the number is ignored
   * ('5 - Beaucoup' gives 5, '7,5' gives 7.5). Empty or non-numeric answers give null.
   */
  function toFloat(x) {
    if (x === null || x === undefined) return null;
    const s = strip(x).replace(/,/g, '.');
    if (s === '') return null;
    let num = '';
    for (const ch of s) {
      const d = digitValue(ch);
      if (d >= 0) num += d;
      else if (OTHER_DIGIT_RE.test(ch)) num += ch;              // makes the number unreadable, as in Python
      else if (ch === '.' || (ch === '-' && num === '')) num += ch;
      else if (num) break;
    }
    if (num === '') return null;
    const v = Number(num);
    return Number.isNaN(v) ? null : v;
  }

  /**
   * yesNo(x) -> true | false | null
   * Reads a free-text yes/no answer in French, Arabic or English. Empty or unrecognised answers give null.
   */
  function yesNo(x) {
    if (x === null || x === undefined) return null;
    const s = strip(x).toLowerCase();
    if (s === '') return null;
    const c = s[0];
    if (c === 'o' || c === 'y' || c === '1' || s.includes('oui') || s.includes('yes') ||
        s.includes('نعم')) return true;
    if (c === 'n' || c === '0' || s.includes('non') || s.includes('no') || s.includes('لا')) return false;
    return null;
  }

  // Oslo questionnaire on health problems: response labels and their item scores (0, 8, 17 or 25 per item).
  // The form exports the option text; older exports carried the number, and a numeric value always wins.
  const OSTRC_LABELS = Object.freeze({
    // Question 1, participation
    'full participation without health problems': 0,
    'full participation but with health problems': 8,
    'reduced participation': 17,
    'reduced participation due to health problems': 17,
    'could not participate': 25,
    'cannot participate': 25,
    // Question 2, training volume, and question 3, performance
    'no reduction': 0,
    'no effect': 0,
    'to a minor extent': 8,
    'to a moderate extent': 17,
    'to a major extent': 25,
    // Question 4, symptoms
    'no symptoms': 0,
    'mild': 8,
    'moderate': 17,
    'severe': 25
  });

  /**
   * ostrcScore(x) -> number | null
   * Score of one item of the Oslo questionnaire. A number passes through; option text is looked up in
   * OSTRC_LABELS (case and spacing ignored). Unrecognised text gives null, never a silent zero.
   */
  function ostrcScore(x) {
    if (x === null || x === undefined) return null;
    const s = strip(x);
    if (s === '') return null;
    const v = toFloat(s);
    if (v !== null) return v;
    const key = s.toLowerCase().split(SPACE_RUN_RE).filter(Boolean).join(' ');
    return Object.prototype.hasOwnProperty.call(OSTRC_LABELS, key) ? OSTRC_LABELS[key] : null;
  }

  // ------------------------------------------------------------------ dates
  function pad(n, width) { return String(n).padStart(width, '0'); }

  function daysInMonth(y, m) {
    if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  }

  // Day number of a calendar date (days since 1 January 1970) and back.
  function dayNumber(y, m, d) {
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    return Math.round(dt.getTime() / 86400000);
  }
  function isoFromDayNumber(n) {
    const dt = new Date(n * 86400000);
    return pad(dt.getUTCFullYear(), 4) + '-' + pad(dt.getUTCMonth() + 1, 2) + '-' + pad(dt.getUTCDate(), 2);
  }
  function isoToDayNumber(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
    if (!m || y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      throw new TypeError("Not a calendar date written 'YYYY-MM-DD': " + String(date));
    }
    return dayNumber(y, mo, d);
  }

  /** addDays(date, n) -> 'YYYY-MM-DD'. The date n days after date (before it when n is negative). */
  function addDays(date, n) { return isoFromDayNumber(isoToDayNumber(date) + n); }

  /** dayDiff(from, to) -> number of days from one date to another (negative when to is earlier). */
  function dayDiff(from, to) { return isoToDayNumber(to) - isoToDayNumber(from); }

  /** dateRange(start, end) -> every calendar day from start to end, both included ([] when end is earlier). */
  function dateRange(start, end) {
    const a = isoToDayNumber(start), b = isoToDayNumber(end);
    const out = [];
    for (let n = a; n <= b; n++) out.push(isoFromDayNumber(n));
    return out;
  }

  /** weekday(date) -> 0 (Monday) to 6 (Sunday). */
  function weekday(date) { return (((isoToDayNumber(date) + 3) % 7) + 7) % 7; }

  // Timestamp formats of the form exports, tried in this order. In the first three and in the last one the hour
  // is on the 12-hour clock with AM or PM.
  const DATE_FORMATS = Object.freeze([
    '%Y/%m/%d %I:%M:%S %p', '%m/%d/%Y %I:%M:%S %p', '%d/%m/%Y %I:%M:%S %p',
    '%Y-%m-%d %H:%M:%S', '%Y/%m/%d %H:%M:%S', '%d/%m/%Y %H:%M:%S',
    '%m/%d/%Y %H:%M:%S', '%Y-%m-%d', '%Y/%m/%d', '%d/%m/%Y', '%m/%d/%Y',
    '%Y-%m-%d %I:%M:%S %p'
  ]);

  // Each directive accepts what Python's strptime accepts for it.
  const D_ = '\\p{Nd}';
  const DIRECTIVES = {
    Y: '(?<Y>' + D_ + D_ + D_ + D_ + ')',
    m: '(?<m>1[0-2]|0[1-9]|[1-9])',
    d: '(?<d>3[0-1]|[1-2]' + D_ + '|0[1-9]|[1-9]| [1-9])',
    H: '(?<H>2[0-3]|[0-1]' + D_ + '|' + D_ + ')',
    I: '(?<I>1[0-2]|0[1-9]|[1-9])',
    M: '(?<M>[0-5]' + D_ + '|' + D_ + ')',
    S: '(?<S>6[0-1]|[0-5]' + D_ + '|' + D_ + ')',
    p: '(?<p>am|pm)'
  };
  const DATE_PATTERNS = DATE_FORMATS.map(function (format) {
    let source = '';
    for (let k = 0; k < format.length; k++) {
      const c = format[k];
      if (c === '%') { k += 1; source += DIRECTIVES[format[k]]; }
      else if (c === ' ') source += '[' + PY_SPACE + ']+';
      else source += c === '/' ? '\\/' : c;
    }
    return new RegExp('^(?:' + source + ')', 'iu');
  });
  const ISO_PATTERN = DATE_PATTERNS[DATE_FORMATS.indexOf('%Y-%m-%d')];
  const TIMEZONE_RE = new RegExp('[' + PY_SPACE + ']+(?:UTC|GMT)[+-]?' + D_ + '*', 'gu');

  // Date of a text under one pattern, or null. The whole text must be consumed and the date must exist.
  function matchDate(pattern, s) {
    const m = pattern.exec(s);
    if (!m || m[0].length !== s.length) return null;
    const g = m.groups;
    const y = toInt(g.Y), mo = toInt(g.m), d = toInt(g.d);
    if (y < 1 || d > daysInMonth(y, mo)) return null;
    if (g.S !== undefined && toInt(g.S) > 59) return null;
    return pad(y, 4) + '-' + pad(mo, 2) + '-' + pad(d, 2);
  }

  /**
   * parseDate(x) -> 'YYYY-MM-DD' | null
   * Calendar day of a form timestamp or of a date typed by the user. A trailing time zone such as 'UTC+1' is
   * dropped, the formats of DATE_FORMATS are tried in order (so '03/04/2026 20:00:00' is 3 April and
   * '03/04/2026 8:00:00 PM' is 4 March), and as a last resort the first ten characters are read as 'YYYY-MM-DD'.
   */
  function parseDate(x) {
    if (x === null || x === undefined || x === '') return null;
    const s = strip(strip(x).replace(TIMEZONE_RE, ''));
    for (let k = 0; k < DATE_PATTERNS.length; k++) {
      const d = matchDate(DATE_PATTERNS[k], s);
      if (d !== null) return d;
    }
    return matchDate(ISO_PATTERN, Array.from(s).slice(0, 10).join(''));
  }

  // A date given by the caller (options, availability log): any accepted format, but it must be readable.
  function requireDate(x, what) {
    const d = parseDate(x);
    if (d === null) throw new Error('The ' + what + ' is not a readable date: ' + String(x));
    return d;
  }

  // ------------------------------------------------------------------ CSV
  /**
   * decodeText(bytes) -> string
   * Text of a responses file given as bytes (Uint8Array or ArrayBuffer). UTF-16 is read when the file starts with
   * its byte-order mark, UTF-8 when the bytes are valid UTF-8, and Windows-1252 otherwise, which is how a
   * spreadsheet on Windows often saves a CSV file with accented headers.
   */
  function decodeText(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(b);
    }
  }

  // Delimiter of a CSV text: the most frequent of comma, semicolon and tab on the first non-empty line,
  // outside quotes. A comma is assumed when none is found.
  function detectDelimiter(s) {
    const count = { ',': 0, ';': 0, '\t': 0 };
    let quoted = false, seen = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === '\n' || c === '\r')) { if (seen) break; continue; }
      else if (!quoted && count[c] !== undefined) count[c] += 1;
      seen = true;
    }
    let best = ',';
    if (count[';'] > count[best]) best = ';';
    if (count['\t'] > count[best]) best = '\t';
    return best;
  }

  /**
   * parseCSV(text, delimiter?) -> string[][]
   * Rows and cells of a CSV text, read as Python's csv module reads them: quoted cells may hold delimiters, line
   * breaks and doubled quotes; lines end with CRLF, LF or CR; a byte-order mark at the start is dropped. The
   * delimiter (comma, semicolon or tab) is detected on the first line unless it is given. An empty line gives an
   * empty row.
   */
  function parseCSV(text, delimiter) {
    let s = text === null || text === undefined ? '' : String(text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const delim = delimiter || detectDelimiter(s);
    const START_RECORD = 0, START_FIELD = 1, IN_FIELD = 2, IN_QUOTED = 3, QUOTE_IN_QUOTED = 4;
    const rows = [];
    let row = [], field = '', state = START_RECORD;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (state === IN_QUOTED) {
        if (c === '"') state = QUOTE_IN_QUOTED; else field += c;
        continue;
      }
      if (c === '\r' || c === '\n') {
        if (state !== START_RECORD) { row.push(field); field = ''; }
        rows.push(row); row = []; state = START_RECORD;
        if (c === '\r' && s[i + 1] === '\n') i += 1;
        continue;
      }
      if (state === QUOTE_IN_QUOTED && c === '"') { field += '"'; state = IN_QUOTED; continue; }
      if (c === delim) { row.push(field); field = ''; state = START_FIELD; continue; }
      // a quote opens a quoted cell only at the start of the cell; elsewhere it is an ordinary character
      if (c === '"' && (state === START_RECORD || state === START_FIELD)) { state = IN_QUOTED; continue; }
      field += c; state = IN_FIELD;
    }
    if (state !== START_RECORD) { row.push(field); rows.push(row); }
    return rows;
  }

  /**
   * toCSV(rows, columns?) -> string
   * CSV text (comma-delimited, CRLF line ends, header line first) of an array of objects. columns defaults to the
   * keys of the first row. null and undefined give an empty cell. Text that a spreadsheet would read as a formula
   * (starting with =, +, - or @) is prefixed with an apostrophe.
   */
  function toCSV(rows, columns) {
    const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
    function cell(v) {
      if (v === null || v === undefined) return '';
      let s = String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    const lines = [cols.map(cell).join(',')];
    for (const r of rows) lines.push(cols.map(function (c) { return cell(r[c]); }).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------------ ingest: columns and records
  // Column mapping. Each canonical field lists fragments of French and English form headers, matched as
  // lower-case substrings in priority order. The first sixteen fields are those of the rule-based prototype;
  // availability is matched last, so it can only take a column that no other field claimed.
  const COLMAP = Object.freeze({
    timestamp: ['horodat', 'timestamp'],
    email: ['email', 'adresse', 'utilisateur', 'mail', 'athlete id'],
    athlete: ['qui es', 'player', 'nageur', 'swimmer', 'athlete', 'name', 'nom'],
    moment: ['moment', 'timing'],
    duration: ['duree', 'durée', 'duration', 'min'],
    intensity: ['intensite', 'intensité', 'intensity', 'cr-10', 'ressenti', 'rpe'],
    fatigue: ['fatigu'],
    stress: ['stress'],
    soreness: ['courbatur', 'muscle', 'soreness'],
    sleep: ['sommeil', 'sleep'],
    // health module: daily health item and weekly Oslo questionnaire
    pain: ['douleur', 'gêne', 'gene specifique', 'pain', 'health problem'],
    pain_location: ['localis', 'location', 'zone'],
    ostrc_q1: ['ostrc_q1', 'ostrc q1', 'ostrc-q1', 'participation'],
    ostrc_q2: ['ostrc_q2', 'ostrc q2', 'ostrc-q2', 'volume'],
    ostrc_q3: ['ostrc_q3', 'ostrc q3', 'ostrc-q3', 'performance ostrc', 'ostrc performance'],
    ostrc_q4: ['ostrc_q4', 'ostrc q4', 'ostrc-q4', 'symptom'],
    // optional column stating that the athlete is injured, ill or in return to play
    availability: ['availability', 'disponib', 'statut', 'status']
  });
  const REQUIRED_COLUMNS = Object.freeze(['athlete', 'duration', 'intensity']);

  /**
   * matchColumns(headerRow) -> { canonical: index }
   * Position of each recognised field of COLMAP in the header row. One header serves one field; fields are
   * matched in the order of COLMAP (the e-mail column before the name, so that "Nom d'utilisateur" is not taken
   * as the athlete's name). Fields that are not found are absent from the result.
   */
  function matchColumns(headerRow) {
    const mapping = {};
    const used = new Set();
    const lowered = headerRow.map(function (h) { return strip(String(h).toLowerCase()); });
    for (const canon of Object.keys(COLMAP)) {
      const keys = COLMAP[canon];
      for (let k = 0; k < keys.length && mapping[canon] === undefined; k++) {
        for (let j = 0; j < headerRow.length; j++) {
          if (used.has(headerRow[j])) continue;
          if (lowered[j].includes(keys[k])) { mapping[canon] = j; used.add(headerRow[j]); break; }
        }
      }
    }
    return mapping;
  }

  /**
   * toRecords(rows) -> record[]
   * One record per non-empty data row, in the order of the file. The first non-empty row is the header. Throws an
   * Error when the athlete, duration or intensity column is not found.
   *   record = {
   *     date          'YYYY-MM-DD' | null   calendar day of the timestamp (null when unreadable or absent)
   *     athlete       string                name as typed, trimmed ('' when absent)
   *     moment        string                session timing as typed ('' when absent)
   *     duration      number | null         minutes
   *     intensity     number | null         Borg CR-10
   *     sessionLoad   number | null         duration x intensity in AU; null unless both are numeric
   *     fatigue, stress, soreness, sleep    number | null   Hooper items, 1 (best) to 7 (worst)
   *     pain          true | false | null   daily health item
   *     painLocation  string | null
   *     ostrc         [q1, q2, q3, q4]      Oslo item scores, number | null each
   *     availability  string | null         raw text of the availability column
   *   }
   */
  function toRecords(rows) {
    const list = rows || [];
    const blank = function (r) { return !r.some(function (c) { return strip(c) !== ''; }); };
    const first = list.findIndex(function (r) { return !blank(r); });
    if (first < 0) return [];
    const header = list[first];
    const idx = matchColumns(header);
    const missing = REQUIRED_COLUMNS.filter(function (c) { return idx[c] === undefined; });
    if (missing.length) {
      throw new Error('The file does not hold the required columns: ' + missing.join(', ') + '. Columns recognised: ' +
        (Object.keys(idx).join(', ') || 'none') + '.');
    }
    const records = [];
    for (let k = first + 1; k < list.length; k++) {
      const r = list[k];
      if (blank(r)) continue;
      const g = function (c) { return idx[c] !== undefined && idx[c] < r.length ? r[idx[c]] : null; };
      const text = function (c) { return strip(g(c) || ''); };
      const rec = {
        date: parseDate(g('timestamp')),
        athlete: text('athlete'),
        moment: text('moment'),
        duration: toFloat(g('duration')),
        intensity: toFloat(g('intensity')),
        sessionLoad: null,
        fatigue: toFloat(g('fatigue')),
        stress: toFloat(g('stress')),
        soreness: toFloat(g('soreness')),
        sleep: toFloat(g('sleep')),
        pain: yesNo(g('pain')),
        painLocation: text('pain_location') || null,
        ostrc: [ostrcScore(g('ostrc_q1')), ostrcScore(g('ostrc_q2')), ostrcScore(g('ostrc_q3')),
          ostrcScore(g('ostrc_q4'))],
        availability: text('availability') || null
      };
      if (rec.athlete && rec.duration !== null && rec.intensity !== null) {
        rec.sessionLoad = rec.duration * rec.intensity;
      }
      records.push(rec);
    }
    return records;
  }

  // ------------------------------------------------------------------ availability
  // Fragments that mark an availability answer as injured, ill or in return to play (English and French).
  const UNAVAILABLE_KEYS = Object.freeze([
    ['return to play', ['return', 'rtp', 'reprise']],
    ['injured', ['injur', 'bless']],
    ['ill', ['sick', 'malad']],
    ['unavailable', ['unavailable', 'not available', 'indispon', 'non disponib', 'pas disponib']]
  ]);
  const ILL_RE = /(^|[^a-z\u00c0-\u024f])ill/;     // 'ill' and 'illness', not 'will' or 'still'

  /**
   * availabilityReason(text) -> 'return to play' | 'injured' | 'ill' | 'unavailable' | null
   * Reads one answer of the availability column. null means that the answer does not say that the athlete is
   * injured, ill or in return to play (for example 'Available' or an empty cell).
   */
  function availabilityReason(text) {
    if (text === null || text === undefined) return null;
    const s = strip(text).toLowerCase();
    if (s === '') return null;
    for (const entry of UNAVAILABLE_KEYS) {
      if (entry[1].some(function (k) { return s.includes(k); })) return entry[0];
      if (entry[0] === 'ill' && ILL_RE.test(s)) return 'ill';
    }
    return null;
  }

  // Availability log as given in the options, checked and with dates normalised.
  function resolveAvailability(log) {
    const out = [];
    (log || []).forEach(function (p, k) {
      const what = 'availability period ' + (k + 1);
      const athlete = strip(p && p.athlete !== undefined && p.athlete !== null ? p.athlete : '');
      if (!athlete) throw new Error('The ' + what + ' does not name an athlete.');
      const from = requireDate(p.from, 'start of ' + what);
      const open = p.to === null || p.to === undefined || p.to === '';
      const to = open ? null : requireDate(p.to, 'end of ' + what);
      if (to !== null && to < from) {
        throw new Error('The ' + what + ' ends before it starts (' + from + ' to ' + to + ').');
      }
      const reason = strip(p.reason === null || p.reason === undefined ? '' : p.reason) || 'unavailable';
      out.push({ athlete: athlete, from: from, to: to, reason: reason });
    });
    return out;
  }

  function resolveBudget(b) {
    const enabled = !b || b.enabled !== false;
    const share = b && b.share !== undefined && b.share !== null ? Number(b.share) : HBODEngine.SETTINGS.alertBudget;
    if (!(share > 0 && share <= 1)) {
      throw new RangeError('The alert budget must be a share above 0 and at most 1, for example 0.10.');
    }
    return { enabled: enabled, share: share };
  }

  // ------------------------------------------------------------------ analysis
  const MAX_DAYS = 3660;      // about ten years: a longer span points to a mistyped date

  /**
   * analyse(records, options?) -> analysis
   * Runs the HBOD engine over every calendar day of one squad. One file is one squad: all its athletes share the
   * daily median.
   *   options = {
   *     availability  [{ athlete, from, to, reason }]   log of periods during which an athlete is injured, ill or
   *                   in return to play. from and to are dates (both days included); to may be null for a period
   *                   that is still open. reason is free text, usually 'injured', 'ill' or 'return to play'.
   *                   Periods of athletes outside the roster are ignored.
   *     budget        { enabled: true, share: 0.10 }    alert budget; a share outside (0, 1] throws a RangeError
   *     endDate       last day to process (default: the last report). Later reports are left out.
   *     startDate     day 0 (default: the earliest report). Earlier reports are left out.
   *     roster        string[]   athletes to include even if they never reported
   *   }
   *   analysis = {
   *     engineVersion, settings         HBODEngine.VERSION and HBODEngine.SETTINGS (Table S2)
   *     budget                          { enabled, share }
   *     athletes                        string[]   every athlete named in the file or in the roster, sorted
   *     dates                           string[]   every calendar day from startDate to endDate
   *     startDate, endDate
   *     days                            the engine's result for each day (see engine.js), athletes in the order
   *                                     of analysis.athletes; days[t].athletes[i].id is the athlete's name
   *     lists                           per day, HBODEngine.alertBudget of that day:
   *                                     { enabled, budget, healthy, cap, ranking, listed, overflow } (names)
   *     inputs = {                      what the engine received, indexed [t][i]
   *       load                number | null    reported session load of the day in AU; null = not reported
   *       hooper              [sleep, stress, fatigue, soreness] | null    null unless all four were given
   *       unavailable         boolean
   *       unavailableReason   string | null    reason from the log, else from the availability column
   *       items               { fatigue, stress, soreness, sleep } | null  Hooper items as answered that day,
   *                           any may be null; null when the athlete answered none
   *       recordCount         number of form records of the athlete on that day
   *     }
   *     availability                    the log after checking: [{ athlete, from, to | null, reason }]
   *     skipped                         { undated, unnamed, outside }: records left out because the date was
   *                                     unreadable, the name empty, or the date outside startDate..endDate
   *     records                         the records given
   *   }
   * Rules. Session load of an athlete-day: sum of duration x intensity over the day's records in which both are
   * numeric (0 and 0 is a reported rest day); otherwise missing, never zero. Hooper items: the last record of the
   * day with all four items. Unavailable: the log covers the day, or a record of the day carries an availability
   * answer that availabilityReason recognises.
   * Throws an Error when no record has a readable date and no startDate is given, or when the days span more
   * than about ten years.
   */
  function analyse(records, options) {
    const o = options || {};
    const recs = records || [];
    const budget = resolveBudget(o.budget);
    const log = resolveAvailability(o.availability);

    const names = new Set();
    let first = null, last = null;
    for (const r of recs) {
      if (r.athlete) names.add(r.athlete);
      if (r.date === null) continue;
      if (first === null || r.date < first) first = r.date;
      if (last === null || r.date > last) last = r.date;
    }
    (o.roster || []).forEach(function (n) { const s = strip(n); if (s) names.add(s); });
    const athletes = Array.from(names).sort(compareText);
    const index = new Map(athletes.map(function (n, i) { return [n, i]; }));

    const startDate = o.startDate ? requireDate(o.startDate, 'start date') : first;
    if (startDate === null) {
      throw new Error('No report with a readable date was found. Check that the timestamp column holds dates.');
    }
    const endDate = o.endDate ? requireDate(o.endDate, 'end date')
      : (last !== null && last > startDate ? last : startDate);
    if (endDate < startDate) {
      throw new RangeError('The end date (' + endDate + ') is before the first day of the data (' + startDate + ').');
    }
    const day0 = isoToDayNumber(startDate);
    const T = isoToDayNumber(endDate) - day0 + 1;
    if (T > MAX_DAYS) {
      throw new Error('The dates run from ' + startDate + ' to ' + endDate + ', which is more than ten years. ' +
        'Check the timestamp column for a mistyped date.');
    }
    const N = athletes.length;
    const dates = dateRange(startDate, endDate);

    function grid(value) {
      const g = new Array(T);
      for (let t = 0; t < T; t++) g[t] = new Array(N).fill(value);
      return g;
    }
    const load = grid(null), hooper = grid(null), unavailable = grid(false), reason = grid(null);
    const items = grid(null), recordCount = grid(0);
    const skipped = { undated: 0, unnamed: 0, outside: 0 };

    for (const r of recs) {
      if (r.date === null) { skipped.undated += 1; continue; }
      if (!r.athlete) { skipped.unnamed += 1; continue; }
      const t = isoToDayNumber(r.date) - day0;
      if (t < 0 || t >= T) { skipped.outside += 1; continue; }
      const i = index.get(r.athlete);
      recordCount[t][i] += 1;
      if (r.sessionLoad !== null) load[t][i] = load[t][i] === null ? r.sessionLoad : load[t][i] + r.sessionLoad;
      const complete = r.fatigue !== null && r.stress !== null && r.soreness !== null && r.sleep !== null;
      // order of the items as in File S1 (Table S2): sleep, stress, fatigue, soreness
      if (complete) hooper[t][i] = [r.sleep, r.stress, r.fatigue, r.soreness];
      if (complete) {
        items[t][i] = { fatigue: r.fatigue, stress: r.stress, soreness: r.soreness, sleep: r.sleep };
      } else if (hooper[t][i] === null &&
          (r.fatigue !== null || r.stress !== null || r.soreness !== null || r.sleep !== null)) {
        // no complete answer so far today: keep the latest value given for each item
        const it = items[t][i] || { fatigue: null, stress: null, soreness: null, sleep: null };
        for (const k of ['fatigue', 'stress', 'soreness', 'sleep']) if (r[k] !== null) it[k] = r[k];
        items[t][i] = it;
      }
      const why = availabilityReason(r.availability);
      if (why !== null) { unavailable[t][i] = true; reason[t][i] = why; }
    }
    for (const p of log) {
      const i = index.get(p.athlete);
      if (i === undefined) continue;
      const a = Math.max(0, isoToDayNumber(p.from) - day0);
      const b = p.to === null ? T - 1 : Math.min(T - 1, isoToDayNumber(p.to) - day0);
      for (let t = a; t <= b; t++) { unavailable[t][i] = true; reason[t][i] = p.reason; }
    }

    const squad = HBODEngine.createSquad(athletes);
    const days = new Array(T), lists = new Array(T);
    for (let t = 0; t < T; t++) {
      days[t] = squad.step({ load: load[t], hooper: hooper[t], unavailable: unavailable[t] });
      lists[t] = HBODEngine.alertBudget(days[t].athletes, { enabled: budget.enabled, budget: budget.share });
    }

    const analysis = {
      engineVersion: HBODEngine.VERSION,
      settings: HBODEngine.SETTINGS,
      budget: budget,
      athletes: athletes,
      dates: dates,
      startDate: startDate,
      endDate: endDate,
      days: days,
      lists: lists,
      inputs: { load: load, hooper: hooper, unavailable: unavailable, unavailableReason: reason, items: items,
        recordCount: recordCount },
      availability: log,
      skipped: skipped,
      records: recs
    };
    indexRecords(analysis);
    return analysis;
  }

  // Load series used by the engine for each athlete (reported, squad median or zero), indexed [i][t].
  const usedLoadCache = new WeakMap();
  function usedLoads(analysis) {
    let u = usedLoadCache.get(analysis);
    if (!u) {
      u = analysis.athletes.map(function (_, i) {
        return analysis.days.map(function (d) { return d.athletes[i].load; });
      });
      usedLoadCache.set(analysis, u);
    }
    return u;
  }

  // Dated records of each athlete of an analysis, in the order of the file. The index is built when the analysis
  // is made, so that an analysis keeps describing the records it was given.
  const athleteRecordCache = new WeakMap();
  function indexRecords(analysis) {
    const m = new Map();
    for (const r of analysis.records) {
      if (r.date === null) continue;
      if (!m.has(r.athlete)) m.set(r.athlete, []);
      m.get(r.athlete).push(r);
    }
    athleteRecordCache.set(analysis, m);
    return m;
  }
  function athleteRecords(analysis, athlete) {
    return (athleteRecordCache.get(analysis) || indexRecords(analysis)).get(athlete) || [];
  }

  // ------------------------------------------------------------------ planning indices (planning only)
  /**
   * planningIndices(loads, t) -> { acute, chronic, ratio }
   * Acute load, chronic load and their ratio on day t of one athlete's daily load series (AU), as File S1 defines
   * its uncoupled rolling average: acute = mean of the last 7 days (from t = 6), chronic = mean of the 28 days
   * before those 7 (days t-34 to t-7, from t = 34), ratio = acute / chronic when chronic is above zero. Values
   * that cannot be computed are null. They are shown for planning only and no threshold is attached to them.
   */
  function planningIndices(loads, t) {
    const sum = HBODEngine._internal.pairwiseSum;      // the summation order of File S1
    const acute = t >= 6 ? sum(loads, t - 6, 7) / 7.0 : null;
    const chronic = t >= 34 ? sum(loads, t - 34, 28) / 28.0 : null;
    return { acute: acute, chronic: chronic, ratio: chronic !== null && chronic > 0 ? acute / chronic : null };
  }

  // ------------------------------------------------------------------ health module (unchanged)
  /**
   * healthStatus(records, athlete, date) -> { pain, location, severity, substantial, cannot, flagged }
   * Health signal of one athlete on one day, as in the rule-based prototype.
   *   pain         true when a record of that day answers yes to the daily health item
   *   location     location given with that answer, or null
   *   severity     sum of the four item scores of the most recent Oslo questionnaire of the last seven days
   *                (date-7 to date), or null when there is none
   *   substantial  any of the first three items (participation, volume, performance) at 17 or more
   *   cannot       any of the first three items at 25 or more
   *   flagged      pain, or substantial, or severity above zero
   */
  function healthStatus(records, athlete, date) {
    return healthOf(records.filter(function (r) { return r.athlete === athlete && r.date !== null; }), date);
  }

  // The same for the dated records of one athlete, given in the order of the file.
  function healthOf(mine, date) {
    const today = mine.filter(function (r) { return r.date === date; });
    const pain = today.some(function (r) { return r.pain === true; });
    let location = null;
    for (const r of today) if (r.pain === true && r.painLocation) { location = r.painLocation; break; }
    const from = addDays(date, -7);
    let latest = null;
    for (const r of mine) {
      if (r.date < from || r.date > date || !r.ostrc.some(function (q) { return q !== null; })) continue;
      if (latest === null || r.date >= latest.date) latest = r;       // most recent day, last record of that day
    }
    let severity = null, substantial = false, cannot = false;
    if (latest !== null) {
      const qs = latest.ostrc.map(function (q) { return q || 0; });
      severity = roundHalfEven(((qs[0] + qs[1]) + qs[2]) + qs[3]);
      substantial = qs[0] >= 17 || qs[1] >= 17 || qs[2] >= 17;
      cannot = qs[0] >= 25 || qs[1] >= 25 || qs[2] >= 25;
    }
    return { pain: pain, location: location, severity: severity, substantial: substantial, cannot: cannot,
      flagged: !!(pain || substantial || (severity || 0) > 0) };
  }

  /**
   * applyHealthGate(status) -> { ...status, action, text, reason }
   * The three tiers of the health gate, as in the rule-based prototype. It sits above load and wellness and does
   * not depend on the probability or on the alert budget.
   *   action  'STOP' (could not participate) | 'REFER' (substantial problem) | 'HOLD' (any flag) | null
   *   text    HEALTH_TEXT[action], or null
   *   reason  the prototype's one-line reason with location and severity, or null
   */
  function applyHealthGate(status) {
    const loc = status.location ? ' (' + status.location + ')' : '';
    const sev = status.severity !== null ? ', OSTRC severity ' + String(Math.trunc(status.severity)) : '';
    let action = null, reason = null;
    if (status.cannot) {
      action = 'STOP';
      reason = 'could not participate' + loc + sev + ': STOP, do not train, urgent medical assessment';
    } else if (status.substantial) {
      action = 'REFER';
      reason = 'substantial health problem' + loc + sev + ': reduce load and refer to medical staff';
    } else if (status.flagged) {
      action = 'HOLD';
      reason = 'health flag today' + loc + ': hold, do not increase, monitor';
    }
    return { pain: status.pain, location: status.location, severity: status.severity, substantial: status.substantial,
      cannot: status.cannot, flagged: status.flagged, action: action, text: action ? HEALTH_TEXT[action] : null,
      reason: reason };
  }

  // ------------------------------------------------------------------ formatting helpers
  /**
   * formatLoad(au, placeholder?) -> string
   * A load in AU without the unit, with one decimal only when needed: '420' or '412.5'. null gives the
   * placeholder (default 'n/a').
   */
  function formatLoad(au, placeholder) {
    const missing = au === null || au === undefined || Number.isNaN(au);
    if (missing) return placeholder === undefined ? 'n/a' : placeholder;
    const s = (Number(au) + 0).toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  }

  /**
   * formatRatio(ratio, placeholder?) -> string
   * The ratio of acute to chronic load with two decimals: '1.08'. null gives the placeholder (default 'n/a').
   */
  function formatRatio(ratio, placeholder) {
    const missing = ratio === null || ratio === undefined || Number.isNaN(ratio);
    if (missing) return placeholder === undefined ? 'n/a' : placeholder;
    return Number(ratio).toFixed(2);
  }

  // ------------------------------------------------------------------ daily report data
  function tIndex(analysis, date) {
    if (!analysis.dates.length) throw new RangeError('The analysis holds no day.');
    const d = date === null || date === undefined || date === '' ? analysis.endDate : requireDate(date, 'report date');
    const t = isoToDayNumber(d) - isoToDayNumber(analysis.startDate);
    if (t < 0 || t >= analysis.dates.length) {
      throw new RangeError('The date ' + d + ' is outside the data (' + analysis.startDate + ' to ' +
        analysis.endDate + ').');
    }
    return t;
  }

  function statusOf(a, list) {
    if (a.unavailable) return 'unavailable';
    if (a.probability === null) return 'baseline-building';
    if (list.listed.indexOf(a.id) >= 0) return 'listed';
    if (list.overflow.indexOf(a.id) >= 0) return 'above-outside-budget';
    return 'below-threshold';
  }

  // Deterministic sentences about one athlete-day. No model is involved.
  function buildNotes(a, day, settings) {
    const notes = [];
    if (a.unavailable) {
      notes.push(a.unavailableReason && a.unavailableReason !== 'unavailable'
        ? 'Unavailable (' + a.unavailableReason + '): zero load.' : 'Unavailable: zero load.');
    } else if (a.imputed) {
      notes.push(day.reporters > 0
        ? 'No session load reported today: the squad median (' + formatLoad(day.squadMedian) + ' AU) was used and ' +
          'the uncertainty of fitness and fatigue was multiplied by four.'
        : 'No session load reported today by any available athlete: a load of 0 AU was used and the uncertainty ' +
          'of fitness and fatigue was multiplied by four.');
      if (a.recordsToday > 0) {
        notes.push('A form was received today, but it holds no usable session duration and intensity.');
      }
    }
    if (a.corrected) notes.push('Wellness correction applied (all four Hooper items).');
    else if (a.hooperMean !== null) {
      notes.push('No wellness correction today (the correction starts after ' + settings.correctionStartDay +
        ' days of data).');
    } else notes.push('No wellness correction today (Hooper items incomplete).');
    if (a.probability === null) {
      notes.push('No probability yet: the personal baseline needs ' + settings.baselineStartDay +
        ' previous days of data (' + day.t + ' so far).');
    }
    if (a.status === 'listed' || a.status === 'above-outside-budget') {
      notes.push(a.driver === 'wellness strain'
        ? 'Mainly driven by wellness strain: check symptoms, since a wellness-driven alert can be an early sign ' +
          'of illness.'
        : 'Mainly driven by the load deficit (modelled fatigue minus modelled fitness).');
    }
    return notes;
  }

  /**
   * dayReport(analysis, date?) -> dayReport
   * Everything the application, the report and the language-model layer show for one day (default: the last day).
   * Throws a RangeError when the date is outside the analysis.
   *   dayReport = {
   *     date, t (day index from 0), dayNumber (t + 1), startDate, engineVersion, settings,
   *     squadMedian         median reported load of the available athletes today, AU (0 when none reported)
   *     reporters           number of available athletes who reported a session load today
   *     budget    { enabled, share, healthy, cap, listed: [names], overflow: [names], ranking: [names] }
   *               listed = today's list; overflow = at or above the threshold but outside today's alert budget;
   *               ranking = every healthy athlete with a probability, highest first
   *     counts    { athletes, healthy, unavailable, reported, missing, listed, aboveOutsideBudget, belowThreshold,
   *                 baselineBuilding, healthGate }
   *               reported and missing count healthy athletes with and without a session load today
   *     athletes  [ {
   *       name
   *       rank                1 = highest probability among healthy athletes with a probability; null otherwise
   *       status              'listed' | 'above-outside-budget' | 'below-threshold' | 'baseline-building' |
   *                           'unavailable' (labels in STATUS_LABELS)
   *       probability         number | null   posterior probability of the engine; null before day 28
   *       logit               number | null
   *       alert               true when the probability reached 0.80
   *       pDeficit, pStrain   number | null   the two parts of the probability
   *       driver              'wellness strain' | 'load deficit' | null   the larger part (wellness strain on a tie)
   *       reported            a session load was reported today
   *       imputed             the squad median was used (healthy athlete without a reported load)
   *       unavailable, unavailableReason | null
   *       load                AU used by the engine: reported load, squad median or zero
   *       reportedLoad        number | null   AU as reported
   *       recordsToday        number of form records of the athlete today
   *       hooper              { fatigue, stress, soreness, sleep } | null   today's items, any may be null
   *       hooperMean          number | null   mean of the four items when all were given
   *       corrected           the wellness correction was applied today
   *       fitness, fatigue, deficit   modelled states in kAU (deficit = fatigue - fitness)
   *       strain              wellness strain in Hooper item units
   *       sdDeficit, sdStrain posterior standard deviations
   *       baseline            { days, meanDeficit, sdDeficit, meanStrain, sdStrain } | null
   *       planning            { acute, chronic, ratio }   AU, AU and a ratio, null when not yet available;
   *                           planning only
   *       health              { pain, location, severity, substantial, cannot, flagged,
   *                             action: 'STOP' | 'REFER' | 'HOLD' | null, text, reason }
   *       daysReported28      days with a reported session load among the last 28 (today included)
   *       notes               string[]   plain sentences about today's computation
   *     } ]
   *   }
   * Order of athletes: health gate first (STOP, REFER, HOLD, by name within each), then today's list by
   * probability, then above the threshold but outside the budget, then below the threshold by probability, then
   * baseline building and unavailable athletes by name.
   */
  function dayReport(analysis, date) {
    const t = tIndex(analysis, date);
    const day = analysis.days[t], list = analysis.lists[t];
    const S = analysis.settings;
    const used = usedLoads(analysis);
    const rankOf = new Map(list.ranking.map(function (n, k) { return [n, k + 1]; }));
    const today = analysis.dates[t];

    const rows = analysis.athletes.map(function (name, i) {
      const e = day.athletes[i];
      let reported28 = 0;
      for (let k = Math.max(0, t - 27); k <= t; k++) if (analysis.inputs.load[k][i] !== null) reported28 += 1;
      const a = {
        name: name,
        rank: rankOf.has(name) ? rankOf.get(name) : null,
        status: statusOf(e, list),
        probability: e.probability,
        logit: e.logit,
        alert: e.alert,
        pDeficit: e.pDeficit,
        pStrain: e.pStrain,
        driver: e.probability === null ? null : (e.pStrain >= e.pDeficit ? 'wellness strain' : 'load deficit'),
        reported: e.reported,
        imputed: e.imputed,
        unavailable: e.unavailable,
        unavailableReason: e.unavailable ? analysis.inputs.unavailableReason[t][i] : null,
        load: e.load,
        reportedLoad: analysis.inputs.load[t][i],
        recordsToday: analysis.inputs.recordCount[t][i],
        hooper: analysis.inputs.items[t][i],
        hooperMean: e.hooperMean,
        corrected: e.corrected,
        fitness: e.fitness,
        fatigue: e.fatigue,
        strain: e.strain,
        deficit: e.deficit,
        sdDeficit: e.sdDeficit,
        sdStrain: e.sdStrain,
        baseline: e.baseline,
        planning: planningIndices(used[i], t),
        health: applyHealthGate(healthOf(athleteRecords(analysis, name), today)),
        daysReported28: reported28,
        notes: null
      };
      a.notes = buildNotes(a, day, S);
      return a;
    });

    // display order; the planning indices take no part in it
    function gate(a) { const k = HEALTH_ACTIONS.indexOf(a.health.action); return k < 0 ? HEALTH_ACTIONS.length : k; }
    rows.sort(function (p, q) {
      const g = gate(p) - gate(q);
      if (g !== 0) return g;
      if (p.health.action !== null) return compareText(p.name, q.name);
      const s = STATUS_ORDER.indexOf(p.status) - STATUS_ORDER.indexOf(q.status);
      if (s !== 0) return s;
      if (p.rank !== null && q.rank !== null && p.rank !== q.rank) return p.rank - q.rank;
      return compareText(p.name, q.name);
    });

    const count = function (f) { return rows.filter(f).length; };
    return {
      date: today,
      t: t,
      dayNumber: t + 1,
      startDate: analysis.startDate,
      engineVersion: analysis.engineVersion,
      settings: S,
      squadMedian: day.squadMedian,
      reporters: day.reporters,
      budget: { enabled: list.enabled, share: list.budget, healthy: list.healthy, cap: list.cap,
        listed: list.listed.slice(), overflow: list.overflow.slice(), ranking: list.ranking.slice() },
      counts: {
        athletes: rows.length,
        healthy: count(function (a) { return !a.unavailable; }),
        unavailable: count(function (a) { return a.unavailable; }),
        reported: count(function (a) { return !a.unavailable && a.reported; }),
        missing: count(function (a) { return a.imputed; }),
        listed: count(function (a) { return a.status === 'listed'; }),
        aboveOutsideBudget: count(function (a) { return a.status === 'above-outside-budget'; }),
        belowThreshold: count(function (a) { return a.status === 'below-threshold'; }),
        baselineBuilding: count(function (a) { return a.status === 'baseline-building'; }),
        healthGate: count(function (a) { return a.health.action !== null; })
      },
      athletes: rows
    };
  }

  /**
   * series(analysis, name) -> one athlete's values on every day of the analysis (arrays aligned with dates)
   *   {
   *     name, dates
   *     load                AU used by the engine (reported, squad median or zero)
   *     reportedLoad        number | null   AU as reported
   *     reported, imputed, unavailable      booleans
   *     probability, pDeficit, pStrain      number | null (null before day 28)
   *     alert               probability reached 0.80
   *     status              status of the day, as in dayReport
   *     listed              true on the days the athlete was on the daily list
   *     fitness, fatigue, deficit           kAU
   *     strain              Hooper item units
   *     acute, chronic, ratio               planning only; null until available
   *     hooperMean          number | null
   *     items               { fatigue: [], stress: [], soreness: [], sleep: [] }   daily Hooper items, null when
   *                         not given
   *     squadMedian         AU, the same for every athlete of the squad
   *   }
   * Throws a RangeError when the athlete is not in the analysis.
   */
  function series(analysis, name) {
    const i = analysis.athletes.indexOf(name);
    if (i < 0) throw new RangeError('Unknown athlete: ' + String(name));
    const loads = usedLoads(analysis)[i];
    const pick = function (key) { return analysis.days.map(function (d) { return d.athletes[i][key]; }); };
    const plan = analysis.dates.map(function (_, t) { return planningIndices(loads, t); });
    const item = function (key) {
      return analysis.inputs.items.map(function (row) { return row[i] === null ? null : row[i][key]; });
    };
    const status = analysis.days.map(function (d, t) { return statusOf(d.athletes[i], analysis.lists[t]); });
    return {
      name: name,
      dates: analysis.dates.slice(),
      load: loads.slice(),
      reportedLoad: analysis.inputs.load.map(function (row) { return row[i]; }),
      reported: pick('reported'),
      imputed: pick('imputed'),
      unavailable: pick('unavailable'),
      probability: pick('probability'),
      pDeficit: pick('pDeficit'),
      pStrain: pick('pStrain'),
      alert: pick('alert'),
      status: status,
      listed: status.map(function (s) { return s === 'listed'; }),
      fitness: pick('fitness'),
      fatigue: pick('fatigue'),
      strain: pick('strain'),
      deficit: pick('deficit'),
      acute: plan.map(function (p) { return p.acute; }),
      chronic: plan.map(function (p) { return p.chronic; }),
      ratio: plan.map(function (p) { return p.ratio; }),
      hooperMean: pick('hooperMean'),
      items: { fatigue: item('fatigue'), stress: item('stress'), soreness: item('soreness'), sleep: item('sleep') },
      squadMedian: analysis.days.map(function (d) { return d.squadMedian; })
    };
  }

  // ------------------------------------------------------------------ audit log
  const AUDIT_COLUMNS = Object.freeze(['generated_at', 'data_through', 'day_number', 'athlete', 'status', 'probability',
    'alert', 'on_list', 'rank', 'p_deficit', 'p_strain', 'driver', 'report', 'load_used', 'squad_median',
    'unavailable', 'health_action', 'acute_load', 'chronic_load', 'ratio', 'budget_enabled', 'budget_share',
    'budget_cap', 'engine_version']);

  /**
   * auditRows(dayReport, generatedAtISO) -> object[]
   * One row per athlete, in the display order of the day report, with the columns of AUDIT_COLUMNS:
   *   generated_at (the timestamp given), data_through (date), day_number, athlete, status,
   *   probability (full precision, null before day 28), alert, on_list, rank, p_deficit, p_strain, driver,
   *   report ('reported' | 'missing': whether a session load was reported today), load_used (AU), squad_median (AU),
   *   unavailable, health_action, acute_load, chronic_load, ratio (the last three for planning only),
   *   budget_enabled, budget_share, budget_cap, engine_version.
   * toCSV(rows, AUDIT_COLUMNS) writes them as CSV.
   */
  function auditRows(day, generatedAtISO) {
    return day.athletes.map(function (a) {
      return {
        generated_at: generatedAtISO === undefined || generatedAtISO === null ? '' : String(generatedAtISO),
        data_through: day.date,
        day_number: day.dayNumber,
        athlete: a.name,
        status: a.status,
        probability: a.probability,
        alert: a.alert,
        on_list: a.status === 'listed',
        rank: a.rank,
        p_deficit: a.pDeficit,
        p_strain: a.pStrain,
        driver: a.driver,
        report: a.reported ? 'reported' : 'missing',
        load_used: a.load,
        squad_median: day.squadMedian,
        unavailable: a.unavailable,
        health_action: a.health.action,
        acute_load: a.planning.acute,
        chronic_load: a.planning.chronic,
        ratio: a.planning.ratio,
        budget_enabled: day.budget.enabled,
        budget_share: day.budget.share,
        budget_cap: day.budget.cap,
        engine_version: day.engineVersion
      };
    });
  }

  return {
    WORDING: WORDING,
    HEALTH_TEXT: HEALTH_TEXT,
    STATUS_ORDER: STATUS_ORDER,
    STATUS_LABELS: STATUS_LABELS,
    COLMAP: COLMAP,
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    OSTRC_LABELS: OSTRC_LABELS,
    DATE_FORMATS: DATE_FORMATS,
    AUDIT_COLUMNS: AUDIT_COLUMNS,
    decodeText: decodeText,
    parseCSV: parseCSV,
    toCSV: toCSV,
    matchColumns: matchColumns,
    toRecords: toRecords,
    analyse: analyse,
    dayReport: dayReport,
    series: series,
    auditRows: auditRows,
    healthStatus: healthStatus,
    applyHealthGate: applyHealthGate,
    planningIndices: planningIndices,
    availabilityReason: availabilityReason,
    toFloat: toFloat,
    yesNo: yesNo,
    ostrcScore: ostrcScore,
    parseDate: parseDate,
    addDays: addDays,
    dayDiff: dayDiff,
    dateRange: dateRange,
    weekday: weekday,
    formatLoad: formatLoad,
    formatRatio: formatRatio,
    compareText: compareText
  };
});
