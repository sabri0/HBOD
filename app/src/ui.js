/*
 * HBOD web application: the screens.
 *
 * Everything is computed in this page by engine.js and core.js. This file reads the file that the user chooses,
 * keeps the settings and the logs in the local storage of the browser, and draws the screens. It holds no code
 * that contacts a server, and the Content-Security-Policy of the page forbids every connection, so no data can
 * leave the device.
 *
 * The decision shown on every screen is the one of the engine: the posterior probability and the alert rate.
 * Acute load, chronic load and their ratio are displayed for planning only. Nothing here reads them to colour,
 * order, flag or word anything.
 *
 * The report (report.js) and the language-model layer (summary.js) are optional parts: when one of them is
 * absent, its screen says that it is not available in this build and the rest keeps working.
 *
 * In the browser the global HBODApp exposes { loadCSVText, loadDemo, setDate, setTab, selectAthlete, state } so
 * that an automated check can drive the application. The address of the page may carry start-up parameters after
 * the hash sign: #demo loads the demonstration squad, and &tab=, &athlete= and &date= choose what is shown, for
 * example #demo&tab=athlete&athlete=Athlete%2007&date=2026-05-01.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const optional = function (file) {
      try { return require(file); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND') return null; throw e; }
    };
    module.exports = factory(root, require('./engine.js'), require('./core.js'), optional('./report.js'),
      optional('./summary.js'), optional('./demo-data.js'));
  } else {
    root.HBODApp = factory(root, root.HBODEngine, root.HBODCore, root.HBODReport || null, root.HBODSummary || null,
      root.HBOD_DEMO || null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, HBODEngine, HBODCore, HBODReport,
  HBODSummary, HBOD_DEMO) {
  'use strict';

  const TABS = ['squad', 'athlete', 'report', 'availability', 'summary', 'audit', 'settings', 'about'];
  const DATA_TABS = ['squad', 'athlete', 'report', 'availability', 'summary'];
  const STORAGE_PREFIX = 'hbod.';
  const EXPORT_SCHEMA = 'hbod-export/1';
  const PAPER_TITLE = 'Development of an autonomous artificial intelligence agent for training load monitoring: ' +
    'a closed-loop in silico trial against the acute-to-chronic workload ratio';
  const OSF_LINK = 'https://doi.org/10.17605/OSF.IO/MUWQ3';
  const REASONS = ['injured', 'ill', 'return to play', 'unavailable'];
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  const NOT_BUILT = 'not available in this build';
  const BOM = String.fromCharCode(0xfeff);
  // colours of the chart series; the same values as the custom properties of app.css
  const COLOUR = { navy: '#1f3864', navySoft: '#8ea3c9', deficit: '#2f5fa8', fatigue: '#d9591f', fitness: '#12936a',
    strain: '#6b4fbb', neutral: '#475467', grid: '#e9ecf0', axis: '#c9ced6', band: '#eceef2', shade: '#f6f7f9' };

  // ------------------------------------------------------------------ small helpers (no DOM)
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** esc(value) -> text safe to place in HTML, also inside an attribute. null and undefined give ''. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return ESCAPES[c];
    });
  }

  function isNumber(v) { return typeof v === 'number' && !Number.isNaN(v); }

  /** formatProbability(p) -> '0.87'. Two decimals everywhere; the formatting of summary.js when it is present. */
  function formatProbability(p) {
    if (HBODSummary && typeof HBODSummary.formatProbability === 'function') return HBODSummary.formatProbability(p);
    return isNumber(p) ? p.toFixed(2) : 'not available yet';
  }

  function formatLoad(au) { return HBODCore.formatLoad(au, 'n/a'); }
  function formatRatio(r) { return HBODCore.formatRatio(r, 'n/a'); }
  function fixed(v, digits) { return isNumber(v) ? v.toFixed(digits) : 'n/a'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /** formatDateLong('2026-06-27') -> 'Saturday 27 June 2026'. */
  function formatDateLong(date) {
    return WEEKDAYS[HBODCore.weekday(date)] + ' ' + Number(date.slice(8, 10)) + ' ' +
      MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  }
  function formatDateShort(date) {
    return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3);
  }
  // Local date and time of an ISO timestamp, for display next to the logs.
  function formatStamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const two = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' +
      two(d.getMinutes());
  }
  function nowISO() { return new Date().toISOString(); }

  /**
   * parseHash(hash) -> { demo, tab, athlete, date }
   * Start-up parameters written after the hash sign of the address, separated by '&': the word demo, and
   * tab=, athlete= and date= with percent-encoded values. Unknown parts are ignored; absent ones are null.
   */
  function parseHash(hash) {
    const out = { demo: false, tab: null, athlete: null, date: null };
    String(hash || '').replace(/^#/, '').split('&').forEach(function (part) {
      if (!part) return;
      const eq = part.indexOf('=');
      const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
      let value = eq < 0 ? '' : part.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch (e) { /* keep the text as written */ }
      if (key === 'demo') out.demo = value === '' || value === '1' || value === 'true';
      else if (key === 'tab' && TABS.indexOf(value.toLowerCase()) >= 0) out.tab = value.toLowerCase();
      else if (key === 'athlete' && value) out.athlete = value;
      else if (key === 'date' && value) out.date = value;
    });
    return out;
  }

  /**
   * axis(lo, hi, target?) -> { min, max, ticks, digits }
   * A value axis that covers lo to hi with round tick values (steps of 1, 2 or 5 times a power of ten).
   */
  function axis(lo, hi, target) {
    let a = Math.min(lo, hi), b = Math.max(lo, hi);
    if (!(b > a)) { a -= 0.5; b += 0.5; }
    const raw = (b - a) / (target || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10);
    const min = Math.floor(a / step + 1e-9) * step, max = Math.ceil(b / step - 1e-9) * step;
    const ticks = [];
    for (let k = 0; min + k * step <= max + step * 1e-6; k++) ticks.push(Number((min + k * step).toPrecision(12)));
    return { min: min, max: max, ticks: ticks, digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
  }

  /**
   * dateTicks(dates) -> [{ i, label }]
   * Marks of a time axis: Mondays for up to 45 days, the first day of each month for up to about 14 months, the
   * first day of each quarter beyond. The year is written on the first mark and on each January.
   */
  function dateTicks(dates) {
    const n = dates.length, out = [];
    for (let i = 0; i < n; i++) {
      const d = dates[i], month = Number(d.slice(5, 7));
      if (n <= 45) {
        if (HBODCore.weekday(d) === 0) out.push({ i: i, label: formatDateShort(d) });
      } else if (d.slice(8, 10) === '01' && (n <= 430 || month % 3 === 1)) {
        const short = MONTHS[month - 1].slice(0, 3);
        out.push({ i: i, label: month === 1 || !out.length ? short + ' ' + d.slice(0, 4) : short });
      }
    }
    if (!out.length && n) out.push({ i: 0, label: formatDateShort(dates[0]) });
    return out;
  }

  // Runs of true values of a boolean array, as [first, last] pairs.
  function runs(flags) {
    const out = [];
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      let j = i;
      while (j + 1 < flags.length && flags[j + 1]) j += 1;
      out.push([i, j]);
      i = j;
    }
    return out;
  }

  /**
   * cleanPeriod(entry) -> { athlete, from, to, reason }
   * One period of the availability log, checked: the athlete is named, the dates are readable and in order. to is
   * null for a period that is still open; reason defaults to 'unavailable'. Throws an Error that says what is wrong.
   */
  function cleanPeriod(entry) {
    const p = entry || {};
    const athlete = String(p.athlete === null || p.athlete === undefined ? '' : p.athlete).trim();
    if (!athlete) throw new Error('A period of the availability log does not name an athlete.');
    const from = HBODCore.parseDate(p.from);
    if (from === null) throw new Error('The period of ' + athlete + ' has no readable start date.');
    const open = p.to === null || p.to === undefined || p.to === '';
    const to = open ? null : HBODCore.parseDate(p.to);
    if (!open && to === null) throw new Error('The period of ' + athlete + ' has an unreadable end date.');
    if (to !== null && to < from) throw new Error('The period of ' + athlete + ' ends before it starts.');
    const reason = String(p.reason === null || p.reason === undefined ? '' : p.reason).trim() || 'unavailable';
    return { athlete: athlete, from: from, to: to, reason: reason };
  }

  // ------------------------------------------------------------------ state
  const state = {
    tab: 'squad',
    source: null,          // { kind: 'demo' | 'file', name, simulated }
    records: null,
    analysis: null,
    date: null,
    athlete: null,
    range: '180',          // days shown in the charts of an athlete: '56', '180' or 'all'
    settings: { budget: { enabled: true, share: HBODEngine ? HBODEngine.SETTINGS.alertBudget : 0.10 } },
    loaderOpen: false,
    notice: null,
    report: { periodic: true, generated: null, built: null, printWhenReady: false },
    summaryDraft: { text: '', model: '', saved: null },
    storageAvailable: false
  };
  // Logs. Those of the user's own data are kept in the local storage of the browser; those of the demonstration
  // squad live for the session only, so that simulated athletes never enter the stored logs.
  const stores = {
    device: { availability: [], audit: [], summaries: [] },
    demo: { availability: [], audit: [], summaries: [] }
  };
  const dayCache = new Map();
  let view = null, bannerList = null;

  function store() { return state.source && state.source.kind === 'demo' ? stores.demo : stores.device; }

  // ------------------------------------------------------------------ local storage
  const storage = (function () {
    let area = null;
    try {
      area = root.localStorage;
      area.setItem(STORAGE_PREFIX + 'probe', '1');
      area.removeItem(STORAGE_PREFIX + 'probe');
    } catch (e) { area = null; }
    return {
      available: area !== null,
      read: function (key, fallback) {
        if (!area) return fallback;
        try {
          const text = area.getItem(STORAGE_PREFIX + key);
          return text === null ? fallback : JSON.parse(text);
        } catch (e) { return fallback; }
      },
      write: function (key, value) {
        if (!area) return false;
        try { area.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
      },
      clear: function () {
        if (!area) return;
        try {
          const keys = [];
          for (let k = 0; k < area.length; k++) keys.push(area.key(k));
          keys.forEach(function (key) { if (key && key.indexOf(STORAGE_PREFIX) === 0) area.removeItem(key); });
        } catch (e) { /* nothing to erase */ }
      }
    };
  })();
  state.storageAvailable = storage.available;

  // Audit rows are stored as arrays in the order of HBODCore.AUDIT_COLUMNS, which keeps the log compact.
  function auditToArray(row) { return HBODCore.AUDIT_COLUMNS.map(function (c) { return row[c] === undefined ? null : row[c]; }); }
  function auditToObject(values, columns) {
    const row = {};
    (columns || HBODCore.AUDIT_COLUMNS).forEach(function (c, k) { row[c] = values[k] === undefined ? null : values[k]; });
    return row;
  }
  function readAudit(saved) {
    if (!saved || !Array.isArray(saved.rows)) return [];
    const columns = Array.isArray(saved.columns) ? saved.columns : HBODCore.AUDIT_COLUMNS;
    const same = columns.join('|') === HBODCore.AUDIT_COLUMNS.join('|');
    return saved.rows.filter(Array.isArray).map(function (r) { return same ? r : auditToArray(auditToObject(r, columns)); });
  }
  function readPeriods(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (p) { try { out.push(cleanPeriod(p)); } catch (e) { /* left out */ } });
    return out;
  }
  function readSettings(saved) {
    const b = saved && saved.budget ? saved.budget : {};
    const share = Number(b.share);
    return { budget: { enabled: b.enabled !== false,
      share: share > 0 && share <= 1 ? share : HBODEngine.SETTINGS.alertBudget } };
  }

  function loadStored() {
    state.settings = readSettings(storage.read('settings', null));
    stores.device.availability = readPeriods(storage.read('availability', []));
    stores.device.audit = readAudit(storage.read('audit', null));
    const summaries = storage.read('summaries', []);
    stores.device.summaries = Array.isArray(summaries) ? summaries : [];
  }

  // Writes one part of the stored state. The logs of the demonstration squad are never stored.
  function persist(part) {
    if (part !== 'settings' && state.source && state.source.kind === 'demo') return;
    let ok = true;
    if (part === 'settings') ok = storage.write('settings', state.settings);
    else if (part === 'availability') ok = storage.write('availability', stores.device.availability);
    else if (part === 'audit') ok = storage.write('audit', { columns: HBODCore.AUDIT_COLUMNS, rows: stores.device.audit });
    else if (part === 'summaries') ok = storage.write('summaries', stores.device.summaries);
    if (!ok && storage.available) {
      showError('The browser could not store the ' + part + ': its storage may be full. Export the logs from the ' +
        'Settings tab, then clear the audit log.');
    }
  }

  // ------------------------------------------------------------------ data
  function analyseNow() {
    state.analysis = HBODCore.analyse(state.records, { availability: store().availability, budget: state.settings.budget });
    dayCache.clear();
    const a = state.analysis;
    if (!state.date || state.date < a.startDate || state.date > a.endDate) state.date = a.endDate;
    if (a.athletes.indexOf(state.athlete) < 0) {
      const day = currentDay();
      state.athlete = day.athletes.length ? day.athletes[0].name : null;
    }
  }

  function dayOf(date) {
    if (!dayCache.has(date)) dayCache.set(date, HBODCore.dayReport(state.analysis, date));
    return dayCache.get(date);
  }
  function currentDay() { return dayOf(state.date); }

  function setData(source, records) {
    const previous = { source: state.source, records: state.records, analysis: state.analysis, date: state.date,
      athlete: state.athlete };
    state.source = source;
    state.records = records;
    state.date = null;
    state.athlete = null;
    try {
      analyseNow();
    } catch (e) {
      // keep what was on screen when the new file cannot be analysed
      state.source = previous.source; state.records = previous.records; state.analysis = previous.analysis;
      state.date = previous.date; state.athlete = previous.athlete;
      dayCache.clear();
      throw e;
    }
    state.loaderOpen = false;
    state.report.generated = null;
    state.summaryDraft = { text: '', model: '', saved: null };
    const left = state.analysis.skipped;
    state.notice = left.undated + left.unnamed > 0
      ? plural(left.undated, 'row', 'rows') + ' without a readable date and ' + plural(left.unnamed, 'row', 'rows') +
        ' without a name were left out.'
      : null;
  }

  /**
   * loadCSVText(text, name?) loads the form responses of one squad given as CSV text and shows them.
   * Throws an Error with a plain message when the text cannot be used (for example a missing column).
   */
  function loadCSVText(text, name) {
    const records = HBODCore.toRecords(HBODCore.parseCSV(text));
    if (!records.length) throw new Error('The file holds no report: it is empty or has only a header line.');
    setData({ kind: 'file', name: name || 'responses', simulated: false }, records);
    render();
  }

  /** loadDemo() loads the demonstration squad (simulated data). Its logs are kept for the session only. */
  function loadDemo() {
    if (!HBOD_DEMO) throw new Error('The demonstration squad is ' + NOT_BUILT + '.');
    stores.demo = { availability: readPeriods(HBOD_DEMO.availability), audit: [], summaries: [] };
    setData({ kind: 'demo', name: HBOD_DEMO.label || 'Demonstration squad (simulated data)', simulated: true },
      HBODCore.toRecords(HBODCore.parseCSV(HBOD_DEMO.csv)));
    render();
  }

  function closeData() {
    state.source = null; state.records = null; state.analysis = null; state.date = null; state.athlete = null;
    state.notice = null; state.loaderOpen = false; state.report.generated = null;
    dayCache.clear();
    render();
  }

  /** setDate(date) shows another day of the loaded data. Throws a RangeError when the date is outside the data. */
  function setDate(date) {
    if (!state.analysis) throw new Error('Load a responses file first.');
    const d = HBODCore.parseDate(date);
    const a = state.analysis;
    if (d === null) throw new RangeError('The date ' + String(date) + ' is not a readable date.');
    if (d < a.startDate || d > a.endDate) {
      throw new RangeError('The date ' + d + ' is outside the data (' + a.startDate + ' to ' + a.endDate + ').');
    }
    state.date = d;
    render();
  }

  /** setTab(name) opens one of: squad, athlete, report, availability, summary, audit, settings, about. */
  function setTab(name) {
    if (TABS.indexOf(name) < 0) throw new RangeError('Unknown tab: ' + String(name));
    state.tab = name;
    render();
  }

  /** selectAthlete(name) chooses the athlete of the Athlete and Language summary tabs. */
  function selectAthlete(name) {
    if (!state.analysis || state.analysis.athletes.indexOf(name) < 0) {
      throw new RangeError('Unknown athlete: ' + String(name));
    }
    state.athlete = name;
    state.summaryDraft = { text: '', model: state.summaryDraft.model, saved: null };
    render();
  }

  function setBudget(enabled, share) {
    state.settings = { budget: { enabled: enabled, share: share } };
    persist('settings');
    if (state.analysis) analyseNow();
    state.report.generated = null;
    render();
  }

  function availabilityChanged() {
    persist('availability');
    if (state.analysis) analyseNow();
    state.report.generated = null;
    render();
  }

  // ------------------------------------------------------------------ pieces shared by the screens
  function probabilityBar(p, extraClass) {
    if (!isNumber(p)) return '<span class="pval none">' + esc(formatProbability(null)) + '</span>';
    const width = Math.max(0, Math.min(100, p * 100)).toFixed(1);
    return '<span class="prob"><span class="pbar' + (extraClass ? ' ' + extraClass : '') + '" role="img" aria-label="' +
      'Probability ' + esc(formatProbability(p)) + ' on a scale from 0 to 1; the mark is the alert threshold of 0.80">' +
      '<span class="pbar-fill' + (p >= HBODEngine.SETTINGS.alertProbability ? ' at' : '') + '" style="width:' + width +
      '%"></span><span class="pbar-mark"></span></span><span class="pval">' + esc(formatProbability(p)) + '</span></span>';
  }

  function statusChip(a) {
    let label = HBODCore.STATUS_LABELS[a.status] || a.status;
    if (a.status === 'unavailable' && a.unavailableReason && a.unavailableReason !== 'unavailable') {
      label += ' (' + a.unavailableReason + ')';
    }
    return '<span class="chip ' + esc(a.status) + '">' + esc(label) + '</span>';
  }

  function gateChip(action) {
    return action ? '<span class="gate ' + esc(action) + '">' + esc(action) + '</span>'
      : '<span class="gate none">none</span>';
  }

  function athleteLink(name) {
    return '<button type="button" class="linkish" data-action="open-athlete" data-name="' + esc(name) + '">' +
      esc(name) + '</button>';
  }

  // What the athlete reported today, in words.
  function loadToday(a, day) {
    if (a.unavailable) {
      return 'Unavailable' + (a.unavailableReason && a.unavailableReason !== 'unavailable'
        ? ' (' + a.unavailableReason + ')' : '') + ': zero load';
    }
    if (a.reported) return formatLoad(a.reportedLoad) + ' AU reported';
    return 'Missing: squad median ' + formatLoad(day.squadMedian) + ' AU used';
  }

  // A phrase continued after a semicolon: first letter in lower case, units such as AU unchanged.
  function lowerFirst(text) { return text.charAt(0).toLowerCase() + text.slice(1); }

  function driverText(a) { return a.driver ? 'mainly ' + a.driver : ''; }

  // The sentence that must accompany the first probability of every screen.
  function wordingBlock(withDetail) {
    return '<p class="wording"><strong>' + esc(HBODCore.WORDING.probability) + '</strong>' +
      (withDetail ? ' ' + esc(HBODCore.WORDING.probabilityDetail) : '') + ' ' + esc(HBODCore.WORDING.support) + '</p>';
  }

  function dateControls() {
    const a = state.analysis;
    return '<span class="field"><label for="hbod-date">Date</label>' +
      '<button type="button" class="btn ghost tiny" data-action="date-prev" aria-label="Previous day"' +
      (state.date <= a.startDate ? ' disabled' : '') + '>&lsaquo;</button>' +
      '<input type="date" id="hbod-date" data-change="date" value="' + esc(state.date) + '" min="' + esc(a.startDate) +
      '" max="' + esc(a.endDate) + '">' +
      '<button type="button" class="btn ghost tiny" data-action="date-next" aria-label="Next day"' +
      (state.date >= a.endDate ? ' disabled' : '') + '>&rsaquo;</button>' +
      '<button type="button" class="btn ghost tiny" data-action="date-latest"' +
      (state.date >= a.endDate ? ' disabled' : '') + '>Latest day</button></span>';
  }

  function dayLine(day) {
    return '<span class="sub">' + esc(formatDateLong(day.date)) + ' &middot; day ' + day.dayNumber + ' of ' +
      state.analysis.dates.length + '</span>';
  }

  // ------------------------------------------------------------------ first screen
  function viewLoader(cancellable) {
    const columns = [
      ['Timestamp', 'Date, or date and time, of the answer.', 'needed'],
      ['Athlete', 'Name of the athlete (Player, Name, Nom).', 'needed'],
      ['Session duration', 'Minutes (Duration, Durée).', 'needed'],
      ['Session intensity', 'Rating of perceived exertion on the Borg CR-10 scale (Intensity, RPE, Intensité).', 'needed'],
      ['Fatigue, Stress, Muscle soreness, Sleep', 'The four Hooper items, each from 1 (best) to 7 (worst). The wellness ' +
        'correction runs on days with all four.', 'recommended'],
      ['Specific pain, Location', 'Daily health item: yes or no, and where.', 'optional'],
      ['OSTRC Q1 to Q4', 'Weekly Oslo questionnaire on health problems: option text or item score.', 'optional'],
      ['Availability', 'Injured, ill or return to play. The Availability tab does the same without a column.', 'optional']
    ];
    const demo = HBOD_DEMO
      ? '<p class="or">No file at hand?</p><p class="toolbar"><button type="button" class="btn ghost" ' +
        'data-action="load-demo">Load demonstration squad</button><span class="sub">Simulated data: 25 athletes over ' +
        '154 days. No real athlete is involved.</span></p>'
      : '<p class="or">The demonstration squad is ' + NOT_BUILT + '.</p>';
    return '<div class="loader"><section class="box"><h2>Load the form responses of your squad</h2>' +
      '<p class="sub">Export the responses of the daily form as a CSV file and open it here. ' +
      esc(HBODCore.WORDING.privacy) + '</p>' +
      '<div class="drop" id="hbod-drop"><p>Drop the CSV file here</p>' +
      '<button type="button" class="btn" data-action="pick-file" data-file="responses">Choose a CSV file</button>' +
      '<input type="file" id="hbod-file-responses" data-file="responses" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden></div>' +
      demo +
      (cancellable ? '<p class="or"><button type="button" class="btn ghost" data-action="hide-loader">Keep the current data</button></p>' : '') +
      '<p class="or">The file is read by this page and is not kept: open it again next time. Settings and logs stay ' +
      'in the local storage of this browser.</p></section>' +
      '<section class="box"><h2>Expected columns</h2><p class="sub">Headers are recognised in English and in French, ' +
      'in any order. Columns may be separated by a comma, a semicolon or a tab.</p>' +
      '<table class="plain columns-table"><thead><tr><th scope="col">Column</th><th scope="col">Content</th><th scope="col"></th></tr></thead><tbody>' +
      columns.map(function (c) {
        return '<tr><th scope="row">' + esc(c[0]) + '</th><td>' + esc(c[1]) + '</td><td class="muted">' + esc(c[2]) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="sub" style="margin-top:10px">One file is one squad. Several sessions on one day are added up. ' +
      esc(HBODCore.WORDING.missing) + '</p></section></div>';
  }

  // ------------------------------------------------------------------ squad
  function viewSquad() {
    const day = currentDay(), c = day.counts, b = day.budget;
    const gated = day.athletes.filter(function (a) { return a.health.action !== null; });
    const listed = day.athletes.filter(function (a) { return a.status === 'listed'; })
      .sort(function (p, q) { return p.rank - q.rank; });
    const above = day.athletes.filter(function (a) { return a.status === 'above-outside-budget'; })
      .sort(function (p, q) { return p.rank - q.rank; });
    const scored = c.healthy - c.baselineBuilding > 0;
    const gateCount = function (action) { return gated.filter(function (a) { return a.health.action === action; }).length; };

    const budgetLine = !scored ? 'no probability before ' + day.settings.baselineStartDay + ' days of data'
      : b.enabled ? 'alert rate ' + (b.share * 100).toFixed(0) + '%: at most ' + b.cap + ' of ' +
        plural(b.healthy, 'healthy athlete', 'healthy athletes')
        : 'alert rate off: every healthy athlete at or above 0.80';
    const tiles = '<div class="tiles">' +
      '<div class="tile"><div class="k">Athletes</div><div class="v num">' + c.athletes + '</div><div class="d">' +
      c.healthy + ' healthy, ' + c.unavailable + ' unavailable</div></div>' +
      '<div class="tile"><div class="k">Session loads reported today</div><div class="v num">' + c.reported +
      ' <small>of ' + c.healthy + '</small></div><div class="d">' +
      (c.missing ? c.missing + ' missing: squad median used' : 'no report missing') + '</div></div>' +
      '<div class="tile primary"><div class="k">On today&#39;s list</div><div class="v num">' + c.listed +
      '</div><div class="d">' + esc(budgetLine) + '</div></div>' +
      '<div class="tile"><div class="k">Above the threshold, outside the alert rate</div><div class="v num">' +
      c.aboveOutsideBudget + '</div><div class="d">at or above 0.80, not on today&#39;s list</div></div>' +
      '<div class="tile"><div class="k">Health gate</div><div class="v num">' + c.healthGate + '</div><div class="d">' +
      (c.healthGate ? gateCount('STOP') + ' stop, ' + gateCount('REFER') + ' refer, ' + gateCount('HOLD') + ' hold'
        : 'no declared problem today') + '</div></div></div>';

    const gatePanel = '<section class="panel"><div class="panel-head"><div><h2>Health gate</h2><p class="sub">' +
      esc(HBODCore.WORDING.gate) + '</p></div></div>' +
      (gated.length ? gated.map(function (a) {
        const h = a.health, why = [];
        if (h.pain) why.push('Pain reported today' + (h.location ? ': ' + h.location : ''));
        if (h.severity !== null) why.push('latest Oslo questionnaire: severity ' + h.severity + ' of 100');
        return '<div class="gate-row">' + gateChip(h.action) + athleteLink(a.name) + '<span class="what">' +
          esc(h.text) + '</span><span class="why">' + esc(why.join('; ')) + '</span></div>';
      }).join('') : '<p class="rowtext">No athlete declared a health problem today.</p>') + '</section>';

    const listPanel = '<section class="panel"><div class="panel-head"><div><h2>Today&#39;s list</h2><p class="sub">' +
      (b.enabled ? 'Ranked by probability and capped by the alert rate.'
        : 'Every healthy athlete at or above 0.80, ranked by probability.') + '</p></div></div>' +
      (listed.length ? listed.map(function (a) {
        return '<div class="list-row"><span class="rank">' + a.rank + '</span>' + athleteLink(a.name) +
          probabilityBar(a.probability) + '<span class="detail">' + esc(driverText(a)) + '; ' +
          esc(lowerFirst(loadToday(a, day))) + (a.health.action ? ' ' + gateChip(a.health.action) : '') + '</span></div>';
      }).join('') : '<p class="rowtext">' + (scored ? 'No healthy athlete reached 0.80 today.'
        : 'The list starts once ' + day.settings.baselineStartDay + ' days of data build the personal baselines.') + '</p>') +
      (above.length ? '<p class="rowtext"><b>Above the threshold, outside today&#39;s alert rate:</b> ' +
        above.map(function (a) { return athleteLink(a.name) + ' (' + esc(formatProbability(a.probability)) + ')'; }).join(', ') +
        '.</p>' : '') + '</section>';

    const rows = day.athletes.map(function (a) {
      return '<tr><td class="r num">' + (a.rank === null ? '' : a.rank) + '</td><th scope="row">' + athleteLink(a.name) +
        '</th><td>' + probabilityBar(a.probability) + '</td><td>' + statusChip(a) + '</td><td>' +
        esc(a.driver || '') + '</td><td>' + esc(loadToday(a, day)) + '</td><td>' + gateChip(a.health.action) + '</td>' +
        '<td class="r num planning planning-first">' + esc(formatLoad(a.planning.acute)) + '</td>' +
        '<td class="r num planning">' + esc(formatLoad(a.planning.chronic)) + '</td>' +
        '<td class="r num planning">' + esc(formatRatio(a.planning.ratio)) + '</td></tr>';
    }).join('');
    const table = '<section class="panel"><div class="panel-head"><div><h2>All athletes</h2><p class="sub">Health ' +
      'gate first, then today&#39;s list, then the other athletes by probability.</p></div><p class="sub">Squad ' +
      'median of the session loads reported today: ' + esc(formatLoad(day.squadMedian)) + ' AU (' +
      plural(day.reporters, 'report', 'reports') + ')</p></div>' +
      '<table><thead><tr class="group"><th colspan="7"></th><th colspan="3" class="planning-group">Planning only</th></tr>' +
      '<tr><th scope="col" class="r">Rank</th><th scope="col">Athlete</th><th scope="col">Probability</th>' +
      '<th scope="col">Status</th><th scope="col">Mainly driven by</th><th scope="col">Session load today</th>' +
      '<th scope="col">Health gate</th><th scope="col" class="r planning planning-first">Acute load (AU)</th>' +
      '<th scope="col" class="r planning">Chronic load (AU)</th><th scope="col" class="r planning">Ratio</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></section>';

    return '<div class="toolbar">' + dateControls() + dayLine(day) + '</div>' + wordingBlock(true) + tiles +
      '<div class="grid-side">' + gatePanel + listPanel + '</div>' + table +
      '<p class="sub">' + esc(HBODCore.WORDING.planning) + ' ' + esc(HBODCore.WORDING.missing) +
      (b.enabled ? ' ' + esc(HBODCore.WORDING.budget) : '') + '</p>';
  }

  // ------------------------------------------------------------------ athlete
  // First and last day index of the charts: the last days of the data, moved back when the chosen day is earlier.
  function chartWindow(total, t) {
    const size = state.range === 'all' ? total : Math.min(total, Number(state.range));
    let end = total - 1;
    if (t < total - size) end = Math.min(total - 1, t + Math.floor(size / 4));
    return [Math.max(0, end - size + 1), end];
  }

  function viewAthlete() {
    const day = currentDay();
    const a = day.athletes.find(function (x) { return x.name === state.athlete; });
    if (!a) return '<p class="box">Choose an athlete.</p>';
    const names = state.analysis.athletes;
    const k = names.indexOf(a.name);
    const h = a.health;
    const classification = h.cannot ? 'Could not participate' : h.substantial ? 'Substantial problem'
      : h.flagged ? 'Flagged' : 'No problem reported';

    const toolbar = '<div class="toolbar"><span class="field"><label for="hbod-athlete">Athlete</label>' +
      '<button type="button" class="btn ghost tiny" data-action="athlete-prev" aria-label="Previous athlete"' +
      (k <= 0 ? ' disabled' : '') + '>&lsaquo;</button><select id="hbod-athlete" data-change="athlete">' +
      names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === a.name ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
      '</select><button type="button" class="btn ghost tiny" data-action="athlete-next" aria-label="Next athlete"' +
      (k >= names.length - 1 ? ' disabled' : '') + '>&rsaquo;</button></span>' + dateControls() +
      '<span class="field"><label for="hbod-range">Charts show</label><select id="hbod-range" data-change="range">' +
      [['56', 'the last 8 weeks'], ['180', 'the last 6 months'], ['all', 'all the data']].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.range === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></span>' + dayLine(day) + '</div>';

    const base = a.baseline;
    const fact = function (label, value, small) {
      return '<div><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) +
        (small ? ' <small>' + esc(small) + '</small>' : '') + '</div></div>';
    };
    const summary = '<section class="box"><div class="toolbar"><span class="athlete-name">' + esc(a.name) + '</span>' +
      statusChip(a) + (h.action ? gateChip(h.action) : '') + '</div>' +
      '<div class="bigp"><span class="v' + (isNumber(a.probability) ? '' : ' none') + '">' +
      esc(formatProbability(a.probability)) + '</span><span class="k">probability on ' + esc(formatDateLong(day.date)) +
      (a.rank !== null ? '; rank ' + a.rank + ' of ' + day.budget.ranking.length : '') + '</span></div>' +
      (isNumber(a.probability)
        ? '<div style="margin:8px 0 12px">' + probabilityBar(a.probability, 'wide').replace('<span class="pval">' +
          esc(formatProbability(a.probability)) + '</span>', '') + '</div>' +
          '<div class="part"><span>Load deficit part</span><span class="pbar"><span class="pbar-fill deficit" style="width:' +
          (a.pDeficit * 100).toFixed(1) + '%"></span></span><span class="num">' + esc(formatProbability(a.pDeficit)) + '</span></div>' +
          '<div class="part"><span>Wellness strain part</span><span class="pbar"><span class="pbar-fill strain" style="width:' +
          (a.pStrain * 100).toFixed(1) + '%"></span></span><span class="num">' + esc(formatProbability(a.pStrain)) + '</span></div>'
        : '') +
      '<div class="facts">' +
      fact('Session load today', a.unavailable ? '0 AU' : formatLoad(a.load) + ' AU',
        a.unavailable ? 'unavailable' : a.reported ? 'reported' : 'squad median, not reported') +
      fact('Days reported, last 28', String(a.daysReported28)) +
      fact('Fitness (modelled)', fixed(a.fitness, 3) + ' kAU') +
      fact('Fatigue (modelled)', fixed(a.fatigue, 3) + ' kAU') +
      fact('Deficit: fatigue minus fitness', fixed(a.deficit, 3) + ' kAU',
        base ? 'baseline ' + fixed(base.meanDeficit, 3) + ', SD ' + fixed(base.sdDeficit, 3) : '') +
      fact('Wellness strain', fixed(a.strain, 2), base ? 'baseline ' + fixed(base.meanStrain, 2) + ', SD ' +
        fixed(base.sdStrain, 2) : '') +
      '</div><ul class="notes">' + a.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
      '</ul></section>';

    const health = '<section class="box"><h2>Health module</h2><p class="sub">Daily health item and weekly Oslo ' +
      'questionnaire. The health gate sits above the probability.</p><div style="margin-top:10px">' +
      '<div class="kv"><span>Pain reported today</span><b>' + (h.pain ? 'Yes' + (h.location ? ': ' + esc(h.location) : '') : 'No') + '</b></div>' +
      '<div class="kv"><span>Latest Oslo questionnaire, severity</span><b class="num">' +
      (h.severity !== null ? h.severity + ' of 100' : 'none in the last 7 days') + '</b></div>' +
      '<div class="kv"><span>Classification</span><b>' + classification + '</b></div></div>' +
      (h.action ? '<div class="gatebox ' + esc(h.action) + '">' + gateChip(h.action) + ' ' + esc(h.text) + '</div>'
        : '<p class="sub" style="margin-top:10px">No action of the health gate today.</p>') + '</section>';

    const items = a.hooper;
    const hooper = '<section class="box"><h2>Hooper items today</h2><p class="sub">1 = best, 7 = worst</p>' +
      ['fatigue', 'stress', 'soreness', 'sleep'].map(function (key) {
        const v = items ? items[key] : null;
        return '<div class="hrow"><span>' + key.charAt(0).toUpperCase() + key.slice(1) + '</span><div class="hbar">' +
          '<div style="width:' + (isNumber(v) ? Math.max(0, Math.min(100, v / 7 * 100)).toFixed(0) : 0) + '%"></div></div>' +
          '<span class="num">' + (isNumber(v) ? esc(v) : 'n/a') + '</span></div>';
      }).join('') +
      '<p class="sub" style="margin-top:12px">' + (a.hooperMean !== null
        ? 'Mean of the four items: ' + fixed(a.hooperMean, 2) + '.' + (a.corrected ? ' It entered the wellness correction today.' : '')
        : 'The four items were not all given today, so there is no wellness correction.') + '</p></section>';

    const key = function (cls, colour, label) {
      return '<span class="key"><i class="' + cls + '"' + (colour ? ' style="' + (cls === 'dot' || cls === 'bar'
        ? 'background:' : 'border-color:') + colour + '"' : '') + '></i>' + esc(label) + '</span>';
    };
    const chartBox = function (id, title, sub, legend) {
      return '<section class="box"><div class="chart-head"><h2>' + esc(title) + '</h2><span class="sub">' + esc(sub) +
        '</span></div>' + (legend ? '<div class="legend">' + legend + '</div>' : '') +
        '<div class="chart" data-chart="' + id + '"></div></section>';
    };
    const charts =
      chartBox('probability', 'Probability over time', 'scale from 0 to 1; grey background: unavailable',
        key('', COLOUR.navy, 'probability') + key('dash', COLOUR.navy, 'alert threshold 0.80') +
        key('dot', COLOUR.navy, 'on the daily list') + key('ring', '', 'at or above 0.80, outside the alert rate')) +
      '<div class="grid2">' +
      chartBox('states', 'Modelled fitness, fatigue and deficit', 'kAU',
        key('', COLOUR.deficit, 'deficit (fatigue minus fitness)') + key('', COLOUR.fatigue, 'fatigue') +
        key('', COLOUR.fitness, 'fitness')) +
      chartBox('strain', 'Wellness strain', 'Hooper item units; higher is worse', key('', COLOUR.strain,
        'strain that the load does not explain')) + '</div>' +
      chartBox('load', 'Daily session load', 'AU',
        key('bar', COLOUR.navy, 'reported') + key('hatch', '', 'not reported: squad median used') +
        key('band', '', 'unavailable: zero load')) +
      '<section class="planning-panel"><h2>Planning only</h2><p class="sub">' + esc(HBODCore.WORDING.planning) + '</p>' +
      '<div class="grid2" style="margin-top:12px">' +
      chartBox('planning', 'Acute and chronic load', 'AU; planning only',
        key('', COLOUR.deficit, 'acute load (mean of the last 7 days)') +
        key('dash', COLOUR.fitness, 'chronic load (mean of the 28 days before)')) +
      chartBox('ratio', 'Ratio of acute to chronic load', 'planning only', '') + '</div></section>';

    return toolbar + wordingBlock(false) + '<div class="grid3">' + summary + health + hooper + '</div>' + charts +
      '<details class="values"><summary>Daily values of the last 28 days as a table</summary>' + valuesTable(a.name) +
      '</details>';
  }

  function valuesTable(name) {
    const s = HBODCore.series(state.analysis, name);
    const t = HBODCore.dayDiff(state.analysis.startDate, state.date);
    let rows = '';
    for (let i = t; i >= Math.max(0, t - 27); i--) {
      rows += '<tr><th scope="row" class="num nowrap">' + esc(s.dates[i]) + '</th><td class="r num">' +
        esc(formatProbability(s.probability[i])) + '</td><td>' + esc(HBODCore.STATUS_LABELS[s.status[i]]) + '</td>' +
        '<td class="r num">' + esc(formatLoad(s.load[i])) + '</td><td>' +
        (s.unavailable[i] ? 'unavailable' : s.reported[i] ? 'reported' : 'squad median') + '</td>' +
        '<td class="r num">' + fixed(s.fitness[i], 3) + '</td><td class="r num">' + fixed(s.fatigue[i], 3) + '</td>' +
        '<td class="r num">' + fixed(s.deficit[i], 3) + '</td><td class="r num">' + fixed(s.strain[i], 2) + '</td>' +
        '<td class="r num planning planning-first">' + esc(formatLoad(s.acute[i])) + '</td><td class="r num planning">' +
        esc(formatLoad(s.chronic[i])) + '</td><td class="r num planning">' + esc(formatRatio(s.ratio[i])) + '</td></tr>';
    }
    return '<div class="panel"><table><thead><tr class="group"><th colspan="9"></th><th colspan="3" class="planning-group">' +
      'Planning only</th></tr><tr><th scope="col">Date</th><th scope="col" class="r">Probability</th><th scope="col">Status</th>' +
      '<th scope="col" class="r">Load used (AU)</th><th scope="col">Source</th><th scope="col" class="r">Fitness (kAU)</th>' +
      '<th scope="col" class="r">Fatigue (kAU)</th><th scope="col" class="r">Deficit (kAU)</th><th scope="col" class="r">Strain</th>' +
      '<th scope="col" class="r planning planning-first">Acute load (AU)</th><th scope="col" class="r planning">Chronic load (AU)</th>' +
      '<th scope="col" class="r planning">Ratio</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ---- charts of the athlete screen (inline SVG)
  function linePath(values, X, Y) {
    let d = '', pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNumber(v)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + (pen ? '' : 'h0');
      pen = true;
    }
    return d;
  }

  let chartCount = 0;

  /**
   * drawChart(host, spec) draws one chart into host at the width of host.
   *   spec = { label, height, dates, yMin, yMax, yTicks, yDigits, unavailable: boolean[], cursor: index | null,
   *            series: [{ label, colour, values, width?, dash? }], bars?: { values, kinds }, threshold?: { y, label },
   *            shade?: { to, label }, markers?: [{ i, y, ring }], tip: function (i) -> html }
   * Every day has a band of equal width; lines pass through the middle of the bands and bars fill them.
   */
  function drawChart(host, spec) {
    const W = Math.max(300, Math.floor(host.clientWidth || 640)), H = spec.height;
    const L = 46, R = 12, T = 12, B = 24;
    const n = spec.dates.length, pw = W - L - R, ph = H - T - B, band = pw / n;
    const X = function (i) { return L + (i + 0.5) * band; };
    const Y = function (v) { return T + ph * (1 - (v - spec.yMin) / (spec.yMax - spec.yMin)); };
    const f = function (v) { return v.toFixed(1); };
    const hatch = 'hbod-hatch-' + (++chartCount);
    const p = [];
    p.push('<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc(spec.label) + '"><defs><pattern id="' + hatch + '" width="4" height="4" patternUnits="userSpaceOnUse" ' +
      'patternTransform="rotate(45)"><rect width="4" height="4" fill="#e9eef6"/><rect width="2" height="4" fill="' +
      COLOUR.navySoft + '"/></pattern></defs>');
    runs(spec.unavailable).forEach(function (r) {
      p.push('<rect x="' + f(L + r[0] * band) + '" y="' + T + '" width="' + f((r[1] - r[0] + 1) * band) + '" height="' +
        ph + '" fill="' + COLOUR.band + '"/>');
    });
    if (spec.shade && spec.shade.to >= 0) {
      const w = (spec.shade.to + 1) * band;
      p.push('<rect x="' + L + '" y="' + T + '" width="' + f(w) + '" height="' + ph + '" fill="' + COLOUR.shade + '"/>' +
        '<line x1="' + f(L + w) + '" x2="' + f(L + w) + '" y1="' + T + '" y2="' + (T + ph) + '" stroke="' + COLOUR.axis + '"/>');
      if (w > 150) {
        p.push('<text x="' + f(L + w / 2) + '" y="' + f(T + ph / 2) + '" text-anchor="middle">' + esc(spec.shade.label) + '</text>');
      }
    }
    spec.yTicks.forEach(function (v) {
      p.push('<line x1="' + L + '" x2="' + (W - R) + '" y1="' + f(Y(v)) + '" y2="' + f(Y(v)) + '" stroke="' +
        (v === 0 ? COLOUR.axis : COLOUR.grid) + '"/><text x="' + (L - 6) + '" y="' + f(Y(v) + 4) + '" text-anchor="end">' +
        v.toFixed(spec.yDigits) + '</text>');
    });
    let lastLabel = -100;
    dateTicks(spec.dates).forEach(function (t) {
      const x = L + t.i * band;
      p.push('<line x1="' + f(x) + '" x2="' + f(x) + '" y1="' + (T + ph) + '" y2="' + (T + ph + 4) + '" stroke="' + COLOUR.axis + '"/>');
      if (x - lastLabel > 52 && x < W - R - 30) {
        p.push('<text x="' + f(x + 2) + '" y="' + (H - 6) + '">' + esc(t.label) + '</text>');
        lastLabel = x;
      }
    });
    if (spec.bars) {
      const bw = Math.max(1, Math.min(14, band * 0.72)), y0 = Y(0);
      for (let i = 0; i < n; i++) {
        const kind = spec.bars.kinds[i], v = spec.bars.values[i];
        if (kind === 'unavailable' || !isNumber(v)) continue;
        const floor = kind === 'imputed' ? 3 : 2;
        const hgt = Math.max(floor, y0 - Y(v));
        p.push('<rect x="' + f(X(i) - bw / 2) + '" y="' + f(y0 - hgt) + '" width="' + f(bw) + '" height="' + f(hgt) +
          '" fill="' + (kind === 'imputed' ? 'url(#' + hatch + ')' : (v === 0 ? COLOUR.navySoft : COLOUR.navy)) + '"/>');
      }
    }
    if (spec.threshold) {
      const y = f(Y(spec.threshold.y));
      p.push('<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + COLOUR.navy +
        '" stroke-width="1.2" stroke-dasharray="5 4"/>');
    }
    spec.series.forEach(function (s) {
      p.push('<path d="' + linePath(s.values, X, Y) + '" fill="none" stroke="' + s.colour + '" stroke-width="' +
        (s.width || 2) + '" stroke-linejoin="round" stroke-linecap="round"' +
        (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + '/>');
    });
    (spec.markers || []).forEach(function (m) {
      p.push('<circle cx="' + f(X(m.i)) + '" cy="' + f(Y(m.y)) + '" r="3.4" fill="' + (m.ring ? '#fff' : COLOUR.navy) +
        '" stroke="' + (m.ring ? COLOUR.navy : '#fff') + '" stroke-width="1.5"/>');
    });
    if (spec.threshold) {
      p.push('<text x="' + (L + 6) + '" y="' + f(Y(spec.threshold.y) - 5) + '" paint-order="stroke" stroke="#fff" ' +
        'stroke-width="3" style="fill:' + COLOUR.navy + '">' + esc(spec.threshold.label) + '</text>');
    }
    if (spec.cursor !== null && spec.cursor >= 0 && spec.cursor < n) {
      const x = f(X(spec.cursor));
      p.push('<line x1="' + x + '" x2="' + x + '" y1="' + T + '" y2="' + (T + ph) + '" stroke="' + COLOUR.navy +
        '" stroke-opacity="0.55"/>');
      spec.series.forEach(function (s) {
        const v = s.values[spec.cursor];
        if (isNumber(v)) p.push('<circle cx="' + x + '" cy="' + f(Y(v)) + '" r="4" fill="' + s.colour + '" stroke="#fff" stroke-width="2"/>');
      });
    }
    p.push('<line class="hair" y1="' + T + '" y2="' + (T + ph) + '" stroke="' + COLOUR.neutral + '" visibility="hidden"/>' +
      '</svg><div class="tip" hidden></div>');
    host.innerHTML = p.join('');

    const svg = host.querySelector('svg'), tip = host.querySelector('.tip'), hair = host.querySelector('.hair');
    const indexAt = function (event) {
      const box = svg.getBoundingClientRect();
      const scale = box.width / W || 1;
      return { i: Math.max(0, Math.min(n - 1, Math.floor(((event.clientX - box.left) / scale - L) / band))), scale: scale, box: box };
    };
    svg.addEventListener('mousemove', function (event) {
      const at = indexAt(event);
      hair.setAttribute('x1', f(X(at.i))); hair.setAttribute('x2', f(X(at.i))); hair.setAttribute('visibility', 'visible');
      tip.innerHTML = spec.tip(at.i);
      tip.hidden = false;
      const x = X(at.i) * at.scale, w = tip.offsetWidth;
      tip.style.left = Math.max(0, x + 14 + w > at.box.width ? x - 14 - w : x + 14) + 'px';
    });
    svg.addEventListener('mouseleave', function () { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); });
    svg.addEventListener('click', guard(function (event) { setDate(spec.dates[indexAt(event).i]); }));
  }

  function drawAthleteCharts() {
    const hosts = view.querySelectorAll('[data-chart]');
    if (!hosts.length || !state.analysis || !state.athlete) return;
    const a = state.analysis;
    const s = HBODCore.series(a, state.athlete);
    const total = a.dates.length, t = HBODCore.dayDiff(a.startDate, state.date);
    const win = chartWindow(total, t), w0 = win[0], w1 = win[1];
    const cut = function (values) { return values.slice(w0, w1 + 1); };
    const dates = cut(s.dates), unavailable = cut(s.unavailable);
    const cursor = t >= w0 && t <= w1 ? t - w0 : null;
    const range = function (lists, withZero) {
      let lo = Infinity, hi = -Infinity;
      lists.forEach(function (list) { list.forEach(function (v) { if (isNumber(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
      if (lo === Infinity) { lo = 0; hi = 1; }
      if (withZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      return [lo, hi];
    };
    const head = function (i) { return '<b>' + esc(formatDateLong(dates[i])) + '</b>' + (unavailable[i] ? ' &middot; unavailable' : ''); };
    const line = function (colour, label, value) {
      return '<br><span class="key"><i style="border-color:' + colour + '"></i>' + esc(label) + ': <b>' + esc(value) + '</b></span>';
    };
    const common = { dates: dates, unavailable: unavailable, cursor: cursor };
    const specs = {};

    const prob = cut(s.probability), status = cut(s.status);
    const firstScored = a.settings.baselineStartDay;
    specs.probability = Object.assign({
      label: 'Probability over time of ' + state.athlete + ', from ' + dates[0] + ' to ' + dates[dates.length - 1] +
        ', with the alert threshold at 0.80',
      height: 230, yMin: 0, yMax: 1, yTicks: [0, 0.2, 0.4, 0.6, 0.8, 1], yDigits: 1,
      series: [{ label: 'probability', colour: COLOUR.navy, values: prob }],
      threshold: { y: a.settings.alertProbability, label: 'alert threshold 0.80' },
      shade: w0 < firstScored ? { to: Math.min(firstScored - 1, w1) - w0,
        label: 'first ' + firstScored + ' days: baseline building' } : null,
      markers: prob.map(function (v, i) {
        return status[i] === 'listed' ? { i: i, y: v, ring: false }
          : status[i] === 'above-outside-budget' ? { i: i, y: v, ring: true } : null;
      }).filter(Boolean),
      tip: function (i) {
        return head(i) + line(COLOUR.navy, 'probability', formatProbability(prob[i])) +
          (isNumber(prob[i]) ? '<br>load deficit part ' + esc(formatProbability(s.pDeficit[w0 + i])) + ', wellness strain part ' +
            esc(formatProbability(s.pStrain[w0 + i])) : '') + '<br>' + esc(HBODCore.STATUS_LABELS[status[i]]);
      }
    }, common);

    const fit = cut(s.fitness), fat = cut(s.fatigue), def = cut(s.deficit);
    const ax2 = axis.apply(null, range([fit, fat, def], true));
    specs.states = Object.assign({
      label: 'Modelled fitness, fatigue and their difference for ' + state.athlete + ', in thousands of arbitrary units',
      height: 210, yMin: ax2.min, yMax: ax2.max, yTicks: ax2.ticks, yDigits: ax2.digits,
      series: [{ label: 'fitness', colour: COLOUR.fitness, values: fit }, { label: 'fatigue', colour: COLOUR.fatigue, values: fat },
        { label: 'deficit', colour: COLOUR.deficit, values: def, width: 2.6 }],
      tip: function (i) {
        return head(i) + line(COLOUR.deficit, 'deficit', fixed(def[i], 3) + ' kAU') +
          line(COLOUR.fatigue, 'fatigue', fixed(fat[i], 3) + ' kAU') + line(COLOUR.fitness, 'fitness', fixed(fit[i], 3) + ' kAU');
      }
    }, common);

    const strain = cut(s.strain), mean = cut(s.hooperMean);
    const ax3 = axis.apply(null, range([strain], true));
    specs.strain = Object.assign({
      label: 'Wellness strain of ' + state.athlete + ', in Hooper item units',
      height: 210, yMin: ax3.min, yMax: ax3.max, yTicks: ax3.ticks, yDigits: ax3.digits,
      series: [{ label: 'strain', colour: COLOUR.strain, values: strain }],
      tip: function (i) {
        return head(i) + line(COLOUR.strain, 'wellness strain', fixed(strain[i], 2)) + '<br>' +
          (isNumber(mean[i]) ? 'mean of the four Hooper items ' + fixed(mean[i], 2) : 'Hooper items not all given');
      }
    }, common);

    const load = cut(s.load), reported = cut(s.reported), median = cut(s.squadMedian);
    const ax4 = axis(0, Math.max(100, range([load], true)[1]));
    specs.load = Object.assign({
      label: 'Daily session load of ' + state.athlete + ' in arbitrary units: reported, replaced by the squad median, or unavailable',
      height: 200, yMin: 0, yMax: ax4.max, yTicks: ax4.ticks, yDigits: 0, series: [],
      bars: { values: load, kinds: load.map(function (_, i) { return unavailable[i] ? 'unavailable' : reported[i] ? 'reported' : 'imputed'; }) },
      tip: function (i) {
        return head(i) + '<br>' + (unavailable[i] ? 'zero load'
          : reported[i] ? 'reported: <b>' + esc(formatLoad(load[i])) + ' AU</b>'
            : 'not reported: squad median <b>' + esc(formatLoad(median[i])) + ' AU</b> used');
      }
    }, common);

    const acute = cut(s.acute), chronic = cut(s.chronic), ratio = cut(s.ratio);
    const ax5 = axis(0, Math.max(100, range([acute, chronic], true)[1]));
    specs.planning = Object.assign({
      label: 'Acute and chronic load of ' + state.athlete + ' in arbitrary units, for planning only',
      height: 200, yMin: 0, yMax: ax5.max, yTicks: ax5.ticks, yDigits: 0,
      series: [{ label: 'chronic load', colour: COLOUR.fitness, values: chronic, dash: '6 4' },
        { label: 'acute load', colour: COLOUR.deficit, values: acute }],
      tip: function (i) {
        return head(i) + line(COLOUR.deficit, 'acute load', formatLoad(acute[i]) + ' AU') +
          line(COLOUR.fitness, 'chronic load', formatLoad(chronic[i]) + ' AU') + '<br>planning only';
      }
    }, common);
    const ax6 = axis(0, Math.max(1.5, range([ratio], true)[1]));
    specs.ratio = Object.assign({
      label: 'Ratio of acute to chronic load of ' + state.athlete + ', for planning only',
      height: 200, yMin: 0, yMax: ax6.max, yTicks: ax6.ticks, yDigits: Math.max(1, ax6.digits),
      series: [{ label: 'ratio', colour: COLOUR.neutral, values: ratio }],
      tip: function (i) { return head(i) + line(COLOUR.neutral, 'ratio', formatRatio(ratio[i])) + '<br>planning only'; }
    }, common);

    hosts.forEach(function (host) {
      const spec = specs[host.getAttribute('data-chart')];
      if (spec) drawChart(host, spec);
    });
  }

  // ------------------------------------------------------------------ daily report
  function reportKey() {
    const b = state.settings.budget;
    return [state.source ? state.source.kind + ':' + state.source.name : '', state.date, b.enabled, b.share,
      JSON.stringify(store().availability), state.report.periodic].join('|');
  }

  // Builds the report of the chosen day with report.js. The timestamp is the one of the last generation of this
  // very report, or the present time for a report that has not been generated yet.
  function buildReport() {
    const day = currentDay();
    const stamped = state.report.generated && state.report.generated.key === reportKey();
    const at = stamped ? state.report.generated.at : nowISO();
    let periodic, due = null;
    if (typeof HBODReport.reportsDue === 'function') due = HBODReport.reportsDue(day.date);
    if (state.report.periodic && typeof HBODReport.buildPeriodic === 'function') {
      periodic = HBODReport.buildPeriodic(state.analysis, day.date);
    }
    const built = HBODReport.buildDailyReport(day, { generatedAt: at, periodic: periodic });
    return { date: day.date, at: at, stamped: stamped, due: due, html: built.html, text: built.text };
  }

  function viewReport() {
    if (!HBODReport || typeof HBODReport.buildDailyReport !== 'function') {
      state.report.built = null;
      return '<p class="box">The daily report is ' + NOT_BUILT + '.</p>';
    }
    const r = buildReport();
    state.report.built = r;
    const reviews = (r.due || []).filter(function (d) { return d !== 'daily'; });
    return '<div class="toolbar">' + dateControls() + dayLine(currentDay()) + '</div>' +
      '<div class="toolbar"><button type="button" class="btn" data-action="report-generate">Generate report</button>' +
      '<button type="button" class="btn ghost" data-action="report-print">Print</button>' +
      '<button type="button" class="btn ghost" data-action="report-html">Download .html</button>' +
      '<button type="button" class="btn ghost" data-action="report-text">Download .txt</button>' +
      '<label class="field"><input type="checkbox" data-change="report-periodic"' + (state.report.periodic ? ' checked' : '') +
      '> Add the periodic reviews when they are due</label></div>' +
      '<p class="sub">' + (r.stamped
        ? 'Generated on ' + esc(formatStamp(r.at)) + ' and recorded in the audit log.'
        : 'Preview. Generating, printing or downloading the report stamps it with the time and adds one line per ' +
          'athlete to the audit log.') +
      (r.due ? ' Reviews due on ' + esc(r.date) + ': ' + (reviews.length ? esc(reviews.join(', ')) : 'none') + '.' : '') + '</p>' +
      '<iframe class="report-frame" id="hbod-report-frame" title="HBOD daily report of ' + esc(r.date) +
      '" sandbox="allow-same-origin allow-modals"></iframe>';
  }

  // Shows the built report in its frame. The frame may not run scripts and inherits the policy of the page.
  function fillReportFrame() {
    const frame = document.getElementById('hbod-report-frame');
    const built = state.report.built;
    if (!frame || !built) return;
    frame.addEventListener('load', guard(function () {
      let doc = null;
      try { doc = frame.contentDocument; } catch (e) { doc = null; }
      if (doc && doc.documentElement) frame.style.height = Math.max(420, doc.documentElement.scrollHeight + 4) + 'px';
      if (state.report.printWhenReady) { state.report.printWhenReady = false; printReport(); }
    }));
    frame.srcdoc = built.html;
  }

  // Stamps the report of the chosen day and adds its lines to the audit log, unless that was already done.
  function generateReport(force) {
    if (!HBODReport) throw new Error('The daily report is ' + NOT_BUILT + '.');
    if (!force && state.report.generated && state.report.generated.key === reportKey()) return false;
    const at = nowISO();
    state.report.generated = { key: reportKey(), at: at };
    const rows = HBODCore.auditRows(currentDay(), at);
    const log = store().audit;
    rows.forEach(function (row) { log.push(auditToArray(row)); });
    persist('audit');
    state.notice = 'Report of ' + state.date + ' generated: ' + plural(rows.length, 'line', 'lines') +
      ' added to the audit log.';
    return true;
  }

  function printReport() {
    const frame = document.getElementById('hbod-report-frame');
    let target = null;
    try { target = frame && frame.contentWindow && frame.contentDocument ? frame.contentWindow : null; } catch (e) { target = null; }
    if (target) { target.focus(); target.print(); } else root.print();
  }

  // ------------------------------------------------------------------ availability
  function viewAvailability() {
    const a = state.analysis, log = store().availability;
    const demo = state.source.kind === 'demo';
    const rows = log.map(function (p, k) { return { p: p, k: k }; }).sort(function (x, y) {
      return (y.p.from < x.p.from ? -1 : y.p.from > x.p.from ? 1 : 0) || HBODCore.compareText(x.p.athlete, y.p.athlete);
    }).map(function (e) {
      const p = e.p, known = a.athletes.indexOf(p.athlete) >= 0;
      const days = HBODCore.dayDiff(p.from, p.to === null ? (a.endDate > p.from ? a.endDate : p.from) : p.to) + 1;
      return '<tr><th scope="row">' + (known ? athleteLink(p.athlete) : esc(p.athlete) + ' <span class="muted">(not in ' +
        'this file)</span>') + '</th><td>' + esc(p.reason) + '</td><td class="num">' + esc(p.from) + '</td><td class="num">' +
        (p.to === null ? '<span class="chip baseline-building">ongoing</span>' : esc(p.to)) + '</td><td class="r num">' +
        days + '</td><td class="nowrap">' +
        (p.to === null ? '<button type="button" class="btn ghost tiny" data-action="availability-end" data-index="' + e.k +
          '"' + (state.date < p.from ? ' disabled' : '') + '>End on ' + esc(state.date) + '</button> ' : '') +
        '<button type="button" class="btn danger tiny" data-action="availability-delete" data-index="' + e.k +
        '">Delete</button></td></tr>';
    }).join('');
    return '<div class="toolbar">' + dateControls() + dayLine(currentDay()) + '</div>' +
      '<section class="box"><h2>Add a period</h2><p class="sub">Athletes who are injured, ill or in return to play ' +
      'contribute zero load and are never on the daily list. The log is applied to every day it covers, and the ' +
      'probabilities are computed again after each change.' + (demo ? ' Demonstration squad: changes last for this ' +
      'session only.' : '') + '</p><div class="formgrid">' +
      '<label class="field-col"><span>Athlete</span><select id="hbod-av-athlete">' +
      a.athletes.map(function (n) { return '<option value="' + esc(n) + '"' + (n === state.athlete ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
      '</select></label><label class="field-col"><span>Reason</span><select id="hbod-av-reason">' +
      REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field-col"><span>From</span><input type="date" id="hbod-av-from" value="' + esc(state.date) + '"></label>' +
      '<label class="field-col"><span>To (leave empty while ongoing)</span><input type="date" id="hbod-av-to"></label>' +
      '<button type="button" class="btn" data-action="availability-add">Add period</button></div></section>' +
      '<section class="panel"><div class="panel-head"><div><h2>Availability log</h2><p class="sub">' +
      plural(log.length, 'period', 'periods') + ', latest first.</p></div><div class="toolbar">' +
      '<button type="button" class="btn ghost" data-action="availability-export"' + (log.length ? '' : ' disabled') + '>Export JSON</button>' +
      '<button type="button" class="btn ghost" data-action="pick-file" data-file="availability">Import JSON</button>' +
      '<input type="file" id="hbod-file-availability" data-file="availability" accept=".json,application/json" hidden></div></div>' +
      '<table><thead><tr><th scope="col">Athlete</th><th scope="col">Reason</th><th scope="col">From</th><th scope="col">To</th>' +
      '<th scope="col" class="r">Days</th><th scope="col"></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty">No period yet. Every athlete is treated as available.</td></tr>') +
      '</tbody></table></section>';
  }

  // ------------------------------------------------------------------ language summary
  function summaryData() {
    const day = currentDay();
    let block = null, problem = null;
    try { block = HBODSummary.buildDataBlock(day, { athlete: state.athlete }); } catch (e) { problem = e.message; }
    return { day: day, block: block, problem: problem };
  }

  function checkBox(check) {
    if (!check) return '';
    const issues = Array.isArray(check.issues) ? check.issues : [];
    return check.ok
      ? '<div class="check">Automatic check: no departure from the data block was found.</div>'
      : '<div class="check issues">Automatic check: ' + plural(issues.length, 'point', 'points') + ' to review.<ul>' +
        issues.map(function (i) { return '<li>' + esc(typeof i === 'string' ? i : (i && (i.message || i.text)) || JSON.stringify(i)) + '</li>'; }).join('') +
        '</ul></div>';
  }

  function viewSummary() {
    if (!HBODSummary || typeof HBODSummary.buildDataBlock !== 'function') {
      return '<p class="box">The language summary is ' + NOT_BUILT + '.</p>';
    }
    const d = summaryData(), day = d.day;
    const a = day.athletes.find(function (x) { return x.name === state.athlete; });
    const draft = state.summaryDraft, saved = draft.saved;
    const records = store().summaries;
    const rows = records.map(function (r, k) { return { r: r, k: k }; }).reverse().map(function (e) {
      const r = e.r, ok = r.check && r.check.ok;
      return '<tr><td class="num nowrap">' + esc(formatStamp(r.created_at)) + '</td><td class="num">' + esc(r.date) + '</td><th scope="row">' +
        esc(r.athlete) + '</th><td class="r num" title="Stored value: ' + esc(r.probability) + '">' +
        esc(r.probability_shown !== undefined ? r.probability_shown : formatProbability(r.probability)) + '</td><td>' +
        esc(HBODCore.STATUS_LABELS[r.list_status] || r.list_status || '') + '</td><td>' +
        (r.check ? (ok ? 'no issue' : plural((r.check.issues || []).length, 'point', 'points') + ' to review') : '') + '</td><td>' +
        esc(r.model || '') + '</td><td><div class="cut" title="' + esc(r.summary) + '">' + esc(r.summary) + '</div></td>' +
        '<td><button type="button" class="btn danger tiny" data-action="summary-delete" data-index="' + e.k + '">Delete</button></td></tr>';
    }).join('');
    return '<div class="toolbar"><span class="field"><label for="hbod-athlete">Athlete</label><select id="hbod-athlete" data-change="athlete">' +
      day.athletes.map(function (x) { return '<option value="' + esc(x.name) + '"' + (x.name === state.athlete ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
      '</select></span>' + dateControls() + dayLine(day) + '</div>' +
      '<section class="box"><h2>Optional plain-language summary</h2><div class="prose sub"><p>A language model may ' +
      'restate the computed result in plain language. It never computes or changes the probability: the value shown ' +
      'and stored here always comes from the engine. HBOD does not contact any model. Copy the prompt and the data ' +
      'block into the language model that your staff use, then paste its answer below.</p></div>' +
      '<p class="wording" style="margin-top:10px"><strong>' + esc(HBODCore.WORDING.probability) + '</strong></p></section>' +
      '<div class="grid2"><section class="box"><h2>1. Constrained prompt</h2><p class="sub">The same for every athlete' +
      (HBODSummary.PROMPT_VERSION ? ' (' + esc(HBODSummary.PROMPT_VERSION) + ')' : '') + '.</p>' +
      '<textarea class="code" id="hbod-prompt" rows="12" readonly aria-label="Constrained prompt">' + esc(HBODSummary.SYSTEM_PROMPT || '') + '</textarea>' +
      '<p class="toolbar" style="margin-top:8px"><button type="button" class="btn ghost" data-action="copy" data-target="hbod-prompt">Copy the prompt</button></p></section>' +
      '<section class="box"><h2>2. Data block of ' + esc(state.athlete) + ', ' + esc(day.date) + '</h2><p class="sub">Computed facts only. ' +
      'Probability of the engine: <b class="num">' + esc(formatProbability(a ? a.probability : null)) + '</b>.</p>' +
      (d.problem ? '<p class="check issues">' + esc(d.problem) + '</p>'
        : '<textarea class="code" id="hbod-block" rows="12" readonly aria-label="Data block">' + esc(d.block) + '</textarea>' +
          '<p class="toolbar" style="margin-top:8px"><button type="button" class="btn ghost" data-action="copy" data-target="hbod-block">Copy the data block</button></p>') +
      '</section></div>' +
      '<section class="box"><h2>3. Text returned by the language model</h2><p class="sub">Saving stores the text with the ' +
      'probability of the engine next to it, so that faithfulness can be tested later, and runs an automatic check.</p>' +
      '<textarea id="hbod-summary-text" rows="4" data-input="summary-text" aria-label="Text returned by the language model" ' +
      'placeholder="Paste the text here">' + esc(draft.text) + '</textarea>' +
      '<div class="toolbar" style="margin-top:8px"><label class="field" for="hbod-summary-model">Model (optional)' +
      '<input type="text" id="hbod-summary-model" data-input="summary-model" value="' + esc(draft.model) + '"></label>' +
      '<button type="button" class="btn" data-action="summary-save">Save summary</button></div>' +
      (saved ? '<div class="check">Saved for ' + esc(saved.athlete) + ', ' + esc(saved.date) + '. Probability stored next to ' +
        'the summary: <b class="num">' + esc(saved.probability_shown !== undefined ? saved.probability_shown : formatProbability(saved.probability)) +
        '</b> (engine value ' + esc(saved.probability) + ').</div>' + checkBox(saved.check) : '') + '</section>' +
      '<section class="panel"><div class="panel-head"><div><h2>Saved summaries</h2><p class="sub">' +
      plural(records.length, 'record', 'records') + (state.source.kind === 'demo' ? '; demonstration squad: kept for this session only' : '') +
      '.</p></div><div class="toolbar">' +
      '<button type="button" class="btn ghost" data-action="summary-export-jsonl"' + (records.length ? '' : ' disabled') + '>Export JSONL</button>' +
      '<button type="button" class="btn ghost" data-action="summary-export-csv"' + (records.length ? '' : ' disabled') + '>Export CSV</button>' +
      '<button type="button" class="btn danger" data-action="summary-clear"' + (records.length ? '' : ' disabled') + '>Clear</button></div></div>' +
      '<table><thead><tr><th scope="col">Saved</th><th scope="col">Data through</th><th scope="col">Athlete</th>' +
      '<th scope="col" class="r">Probability</th><th scope="col">Status</th><th scope="col">Check</th><th scope="col">Model</th>' +
      '<th scope="col">Summary</th><th scope="col"></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="empty">No summary saved yet.</td></tr>') + '</tbody></table></section>';
  }

  function saveSummary() {
    const text = state.summaryDraft.text.trim();
    if (!text) throw new Error('Paste the text returned by the language model before saving.');
    const record = HBODSummary.makeRecord({ dayReport: currentDay(), athlete: state.athlete, summary: text,
      model: state.summaryDraft.model.trim() || null, createdAt: nowISO() });
    store().summaries.push(record);
    persist('summaries');
    state.summaryDraft = { text: '', model: state.summaryDraft.model, saved: record };
  }

  // ------------------------------------------------------------------ audit log
  function viewAudit() {
    const log = (state.source ? store() : stores.device).audit;
    const SHOWN = 300;
    const cell = function (v) { return v === null || v === undefined ? '' : v === true ? 'yes' : v === false ? 'no' : v; };
    let rows = '';
    for (let k = log.length - 1; k >= Math.max(0, log.length - SHOWN); k--) {
      const r = auditToObject(log[k]);
      rows += '<tr><td class="num nowrap">' + esc(formatStamp(r.generated_at)) + '</td><td class="num">' + esc(r.data_through) +
        '</td><th scope="row">' + esc(r.athlete) + '</th><td>' + esc(HBODCore.STATUS_LABELS[r.status] || r.status) + '</td>' +
        '<td class="r num">' + esc(formatProbability(r.probability)) + '</td><td>' + cell(r.on_list) + '</td><td class="r num">' +
        esc(cell(r.rank)) + '</td><td>' + esc(cell(r.driver)) + '</td><td>' + esc(cell(r.report)) + '</td><td class="r num">' +
        esc(formatLoad(r.load_used)) + '</td><td>' + esc(cell(r.health_action)) + '</td><td class="r num">' +
        esc(cell(r.budget_enabled) === 'yes' ? r.budget_cap : 'off') + '</td><td class="num">' + esc(cell(r.engine_version)) + '</td></tr>';
    }
    return '<div class="toolbar"><button type="button" class="btn" data-action="audit-export"' + (log.length ? '' : ' disabled') +
      '>Export CSV</button><button type="button" class="btn danger" data-action="audit-clear"' + (log.length ? '' : ' disabled') +
      '>Clear the audit log</button><span class="sub">' + plural(log.length, 'line', 'lines') +
      (log.length > SHOWN ? '; the latest ' + SHOWN + ' are shown' : '') +
      (state.source && state.source.kind === 'demo' ? '; demonstration squad: kept for this session only' : '') + '</span></div>' +
      wordingBlock(false) +
      '<section class="panel"><table><thead><tr><th scope="col">Generated</th><th scope="col">Data through</th><th scope="col">Athlete</th>' +
      '<th scope="col">Status</th><th scope="col" class="r">Probability</th><th scope="col">On list</th><th scope="col" class="r">Rank</th>' +
      '<th scope="col">Driver</th><th scope="col">Report</th><th scope="col" class="r">Load used (AU)</th><th scope="col">Health gate</th>' +
      '<th scope="col" class="r">Alert rate cap</th><th scope="col">Engine</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="13" class="empty">No line yet. One line per athlete is added each time a daily report is generated.</td></tr>') +
      '</tbody></table></section>' +
      '<p class="sub">The exported file holds every column (' + HBODCore.AUDIT_COLUMNS.length + '), with the probability in ' +
      'full precision. Acute load, chronic load and their ratio are exported for planning only.</p>';
  }

  // ------------------------------------------------------------------ settings
  function engineRows() {
    const S = HBODEngine.SETTINGS;
    return [
      ['States of each athlete', 'fitness, fatigue and wellness strain'],
      ['Time constant of fitness', S.tauG + ' days'],
      ['Time constant of fatigue', S.tauH + ' days'],
      ['Autoregressive coefficient of the wellness strain', S.rhoS.toFixed(2)],
      ['Process-noise SD of fitness, fatigue and strain', S.qG + ' kAU, ' + S.qH + ' kAU and ' + S.qS.toFixed(2) + ' item units'],
      ['Initial variance of fitness and of fatigue', S.p0G + ' and ' + S.p0H],
      ['Observation coefficients at the start (c0, ch, cg)', S.theta0.join(', ')],
      ['Recursive least squares: initial covariance (diagonal)', S.rlsP0.join(', ')],
      ['Recursive least squares: forgetting factor', S.forget.toFixed(2)],
      ['Bounds of ch and of cg', S.chMin + ' to ' + S.chMax + ' and ' + S.cgMin + ' to ' + S.cgMax],
      ['Observation variance', 'adaptive, starting at ' + S.R0 + ', never below ' + S.rFloor],
      ['Wellness correction', 'from day ' + S.correctionStartDay + ', only on days with all four Hooper items'],
      ['Personal baseline', 'from day ' + S.baselineStartDay + ', using up to ' + S.baselineWindow + ' previous days'],
      ['Exceedance of the baseline (kappa)', S.kappa + ' SD'],
      ['Alert', 'when the posterior probability reaches ' + S.alertProbability.toFixed(2)],
      ['Missing session load', 'squad median of that day; uncertainty of fitness and fatigue multiplied by ' + S.imputeInflation],
      ['Injured, ill or in return to play', 'zero load'],
      ['Unit of load inside the filter', 'kAU (1 kAU = ' + S.auPerKau + ' AU)'],
      ['Alert rate by default', (S.alertBudget * 100).toFixed(0) + '% of healthy athlete-days']
    ];
  }

  function viewSettings() {
    const b = state.settings.budget;
    let capLine = 'Load a responses file to see the resulting cap.';
    if (state.analysis) {
      const day = currentDay();
      capLine = b.enabled
        ? 'On ' + day.date + ': at most ' + plural(day.budget.cap, 'athlete', 'athletes') + ' on the list (' +
          (b.share * 100).toFixed(0) + '% of ' + plural(day.budget.healthy, 'healthy athlete', 'healthy athletes') + ').'
        : 'On ' + day.date + ': every healthy athlete at or above 0.80 is listed (' + day.counts.listed + ' today).';
    }
    return '<section class="box"><h2>Alert rate</h2><p class="sub">' + esc(HBODCore.WORDING.budget) + ' Set it before ' +
      'the season and review only the athletes on the list.</p><div class="settings-row">' +
      '<label class="field"><input type="checkbox" id="hbod-budget-on" data-change="budget-enabled"' + (b.enabled ? ' checked' : '') +
      '> Cap the daily list</label><label class="field" for="hbod-budget-share">Share of healthy athletes' +
      '<input type="number" id="hbod-budget-share" data-change="budget-share" min="1" max="100" step="1" value="' +
      (b.share * 100).toFixed(0) + '"' + (b.enabled ? '' : ' disabled') + '> %</label>' +
      '<button type="button" class="btn ghost tiny" data-action="budget-default">Back to 10%</button></div>' +
      '<p class="small" style="margin-top:10px"><b>' + esc(capLine) + '</b></p></section>' +
      '<section class="panel"><div class="panel-head"><div><h2>Engine settings</h2><p class="sub">Fixed. They are those of ' +
      'Table S2 of the paper and cannot be changed here. Engine version ' + esc(HBODEngine.VERSION) + '.</p></div></div>' +
      '<table><thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead><tbody>' +
      engineRows().map(function (r) { return '<tr><th scope="row">' + esc(r[0]) + '</th><td class="num">' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</tbody></table></section>' +
      '<section class="box"><h2>Storage on this device</h2><p class="sub">' + esc(HBODCore.WORDING.privacy) + ' ' +
      (state.storageAvailable
        ? 'The settings, the availability log, the audit log and the saved summaries are kept in the local storage of ' +
          'this browser. The responses file and the demonstration squad are never stored.'
        : 'This browser does not give access to its local storage, so the settings and the logs last only until the ' +
          'page is closed. Export them before closing.') + '</p>' +
      '<p class="small" style="margin-top:8px">Stored now: ' + plural(stores.device.availability.length, 'availability period', 'availability periods') +
      ', ' + plural(stores.device.audit.length, 'audit line', 'audit lines') + ', ' +
      plural(stores.device.summaries.length, 'summary', 'summaries') + '.</p><div class="settings-row">' +
      '<button type="button" class="btn ghost" data-action="export-all">Export everything</button>' +
      '<button type="button" class="btn ghost" data-action="pick-file" data-file="everything">Import everything</button>' +
      '<input type="file" id="hbod-file-everything" data-file="everything" accept=".json,application/json" hidden>' +
      '<button type="button" class="btn danger" data-action="erase-all">Erase everything on this device</button></div></section>';
  }

  // ------------------------------------------------------------------ about
  function viewAbout() {
    const W = HBODCore.WORDING;
    const meta = document.querySelector('meta[name="hbod-build"]');
    const build = meta ? meta.getAttribute('content') : '';
    const sentences = [W.probability, W.probabilityDetail, W.budget, W.missing, W.planning, W.gate, W.support];
    return '<section class="box"><h2>What HBOD is</h2><div class="prose" style="margin-top:8px">' +
      '<p>HBOD (Hooper-Borg-Oslo-Dergaa) is an autonomous agent for the daily monitoring of training load, wellness and ' +
      'health. On one short daily form, athletes report the duration of the session, its rating of perceived exertion ' +
      'on the Borg CR-10 scale and four Hooper items. The same form carries a daily health item, and the Oslo ' +
      'questionnaire on health problems is completed once a week.</p>' +
      '<p>For each athlete HBOD keeps three modelled states: fitness, fatigue and a wellness strain that the load does ' +
      'not explain. It updates them every day, widens its uncertainty on days without a report and returns a ' +
      'probability with a fixed alert rate. The coach decides.</p>' +
      '<p>Acute and chronic loads remain visible for planning, but their ratio no longer triggers decisions. The ' +
      'daily health item, the weekly Oslo questionnaire and the health gate are unchanged.</p></div></section>' +
      '<section class="box"><h2>How to read the screens</h2><ul class="notes prose">' +
      sentences.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></section>' +
      '<div class="grid2"><section class="box"><h2>The paper</h2><div class="prose" style="margin-top:8px"><p>' + esc(PAPER_TITLE) + '.</p>' +
      '<p>Registration of the study on the Open Science Framework: <span class="num">' + esc(OSF_LINK) + '</span><br>' +
      '<a href="' + esc(OSF_LINK) + '" target="_blank" rel="noopener noreferrer">Open the registration in the browser</a> ' +
      '<span class="sub">(the application itself never contacts this address)</span></p>' +
      '<p class="sub">The engine is the JavaScript port of the state-space engine of Supplementary File S1 of the paper; ' +
      'a parity test compares the two on the same simulated data. The rules of the earlier development stage are ' +
      'called the rule-based prototype and are kept only as an archived earlier release.</p></div></section>' +
      '<section class="box"><h2>Access and privacy</h2><div class="prose" style="margin-top:8px"><p><b>' + esc(W.access) + '</b></p>' +
      '<p>' + esc(W.privacy) + ' The page makes no network request: it has no connection to any server, no analytics ' +
      'and no external font, image or script.</p>' +
      '<p>Licence: PolyForm Noncommercial License 1.0.0. For any other use, contact the authors.</p>' +
      '<p class="sub">Engine version ' + esc(HBODEngine.VERSION) + (build ? '; build ' + esc(build) : '') +
      (HBODSummary && HBODSummary.PROMPT_VERSION ? '; prompt ' + esc(HBODSummary.PROMPT_VERSION) : '') + '.' +
      (HBODReport ? '' : ' The daily report is ' + NOT_BUILT + '.') +
      (HBODSummary ? '' : ' The language summary is ' + NOT_BUILT + '.') + '</p></div></section></div>';
  }

  // ------------------------------------------------------------------ rendering
  function renderBanners() {
    let html = '';
    if (state.source) {
      const a = state.analysis;
      const facts = plural(a.athletes.length, 'athlete', 'athletes') + ', ' + plural(a.dates.length, 'day', 'days') + ' (' +
        a.startDate + ' to ' + a.endDate + '), ' + plural(a.records.length, 'report', 'reports');
      html += state.source.kind === 'demo'
        ? '<div class="banner"><span><b>Demonstration squad: simulated data.</b> No real athlete is involved. ' + esc(facts) +
          '. The health answers are illustrative additions.</span><span class="spacer"></span>' +
          '<button type="button" class="btn ghost tiny" data-action="show-loader">Load your own file</button>' +
          '<button type="button" class="btn ghost tiny" data-action="close-data">Close the demonstration</button></div>'
        : '<div class="banner"><span><b>' + esc(state.source.name) + '</b>: ' + esc(facts) + '.</span><span class="spacer"></span>' +
          '<button type="button" class="btn ghost tiny" data-action="show-loader">Load another file</button>' +
          '<button type="button" class="btn ghost tiny" data-action="close-data">Close the file</button></div>';
    }
    if (state.notice) {
      html += '<div class="banner notice" role="status"><span>' + esc(state.notice) + '</span><span class="spacer"></span>' +
        '<button type="button" class="btn ghost tiny" data-action="dismiss-notice">Dismiss</button></div>';
    }
    bannerList.innerHTML = html;
  }

  function render() {
    if (!view) return;
    const through = document.getElementById('data-through');
    if (through) through.textContent = state.analysis ? 'Data through ' + state.date : 'No data loaded';
    document.querySelectorAll('#tabs .tab').forEach(function (tab) {
      if (tab.getAttribute('data-tab') === state.tab) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    renderBanners();
    let html;
    try {
      const needsData = DATA_TABS.indexOf(state.tab) >= 0;
      if (needsData && !state.analysis) html = viewLoader(false);
      else if (state.tab === 'squad') html = viewSquad();
      else if (state.tab === 'athlete') html = viewAthlete();
      else if (state.tab === 'report') html = viewReport();
      else if (state.tab === 'availability') html = viewAvailability();
      else if (state.tab === 'summary') html = viewSummary();
      else if (state.tab === 'audit') html = viewAudit();
      else if (state.tab === 'settings') html = viewSettings();
      else html = viewAbout();
      if (state.loaderOpen && state.analysis) html = viewLoader(true) + html;
    } catch (e) {
      html = '<p class="box">This screen could not be drawn.</p>';
      showError(e && e.message ? e.message : String(e));
    }
    view.innerHTML = html;
    view.setAttribute('data-tab', state.tab);
    try {
      if (state.tab === 'athlete' && state.analysis) drawAthleteCharts();
      if (state.tab === 'report' && state.analysis) fillReportFrame();
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
    }
  }

  function showError(message) {
    if (typeof root.hbodShowError !== 'function') return;
    root.hbodShowError(message);
    const box = document.getElementById('hbod-error');
    if (box && !box.querySelector('button')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost tiny';
      button.textContent = 'Dismiss';
      button.addEventListener('click', function () { box.remove(); });
      box.insertBefore(button, box.firstChild);
      button.style.float = 'right';
    }
  }

  // Runs a handler and shows any error on the page instead of losing it.
  function guard(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        showError(e && e.message ? e.message : String(e));
        return undefined;
      }
    };
  }

  // ------------------------------------------------------------------ files in and out
  // Offers a text as a file to save. The file is made in the page; nothing is sent anywhere.
  function download(name, text, type) {
    const link = document.createElement('a');
    let address = null;
    try { address = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })); } catch (e) { address = null; }
    link.href = address || 'data:' + type + ';charset=utf-8,' + encodeURIComponent(text);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (address) setTimeout(function () { URL.revokeObjectURL(address); }, 30000);
  }

  function readFile(file, asText) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('The file ' + file.name + ' could not be read.')); };
      if (asText) reader.readAsText(file); else reader.readAsArrayBuffer(file);
    });
  }

  function parseJSONFile(text, name) {
    try {
      return JSON.parse(String(text).replace(/^\s+/, '').replace(new RegExp('^' + BOM), ''));
    } catch (e) {
      throw new Error('The file ' + name + ' could not be read as JSON: ' + e.message);
    }
  }

  function openFile(kind, file) {
    if (!file) return Promise.resolve();
    if (kind === 'responses') {
      return readFile(file, false).then(function (buffer) { loadCSVText(HBODCore.decodeText(buffer), file.name); });
    }
    return readFile(file, true).then(function (text) {
      const data = parseJSONFile(text, file.name);
      if (kind === 'availability') {
        const list = Array.isArray(data) ? data : data && (data.availability || data.periods || data.log);
        if (!Array.isArray(list)) {
          throw new Error('The file ' + file.name + ' must hold a list of periods { athlete, from, to, reason }.');
        }
        const periods = list.map(cleanPeriod);
        store().availability = periods;
        state.notice = plural(periods.length, 'period', 'periods') + ' imported into the availability log.';
        availabilityChanged();
      } else {
        importEverything(data, file.name);
      }
    });
  }

  function exportEverything() {
    return { schema: EXPORT_SCHEMA, exported_at: nowISO(), engine_version: HBODEngine.VERSION, settings: state.settings,
      availability: stores.device.availability, audit: { columns: HBODCore.AUDIT_COLUMNS, rows: stores.device.audit },
      summaries: stores.device.summaries };
  }

  function importEverything(data, name) {
    if (!data || data.schema !== EXPORT_SCHEMA) {
      throw new Error('The file ' + name + ' is not an export of HBOD (schema ' + EXPORT_SCHEMA + ').');
    }
    const periods = (Array.isArray(data.availability) ? data.availability : []).map(cleanPeriod);
    if (!root.confirm('Replace the settings and the logs stored on this device by those of ' + name + '?')) return;
    state.settings = readSettings(data.settings);
    stores.device.availability = periods;
    stores.device.audit = readAudit(data.audit);
    stores.device.summaries = Array.isArray(data.summaries) ? data.summaries : [];
    ['settings', 'availability', 'audit', 'summaries'].forEach(function (part) {
      const source = state.source; state.source = null; persist(part); state.source = source;
    });
    state.notice = 'Settings and logs imported from ' + name + '.';
    if (state.analysis) analyseNow();
    state.report.generated = null;
    render();
  }

  function eraseEverything() {
    if (!root.confirm('Erase the settings, the availability log, the audit log and the saved summaries stored on this ' +
        'device? This cannot be undone.')) return;
    storage.clear();
    stores.device = { availability: [], audit: [], summaries: [] };
    state.settings = readSettings(null);
    state.notice = 'Everything stored on this device was erased.';
    if (state.analysis) analyseNow();
    state.report.generated = null;
    render();
  }

  function copyFrom(id) {
    const field = document.getElementById(id);
    if (!field) return;
    const done = function () { state.notice = 'Copied.'; renderBanners(); };
    const byHand = function () { field.focus(); field.select(); if (document.execCommand('copy')) done(); };
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(field.value).then(done, byHand);
    } else byHand();
  }

  // ------------------------------------------------------------------ actions
  const actions = {
    'load-demo': function () { loadDemo(); },
    'pick-file': function (el) { const input = document.getElementById('hbod-file-' + el.getAttribute('data-file')); if (input) input.click(); },
    'show-loader': function () { state.loaderOpen = true; render(); root.scrollTo(0, 0); },
    'hide-loader': function () { state.loaderOpen = false; render(); },
    'close-data': function () { closeData(); },
    'dismiss-notice': function () { state.notice = null; renderBanners(); },
    'date-prev': function () { setDate(HBODCore.addDays(state.date, -1)); },
    'date-next': function () { setDate(HBODCore.addDays(state.date, 1)); },
    'date-latest': function () { setDate(state.analysis.endDate); },
    'open-athlete': function (el) { state.tab = 'athlete'; selectAthlete(el.getAttribute('data-name')); root.scrollTo(0, 0); },
    'athlete-prev': function () { stepAthlete(-1); },
    'athlete-next': function () { stepAthlete(1); },
    'report-generate': function () { generateReport(true); render(); },
    'report-print': function () {
      if (generateReport(false)) { state.report.printWhenReady = true; render(); } else printReport();
    },
    'report-html': function () {
      if (generateReport(false)) render();
      download('HBOD_daily_report_' + state.date + '.html', state.report.built.html, 'text/html');
    },
    'report-text': function () {
      if (generateReport(false)) render();
      download('HBOD_daily_report_' + state.date + '.txt', state.report.built.text, 'text/plain');
    },
    'availability-add': function () {
      const value = function (id) { return document.getElementById(id).value; };
      const period = cleanPeriod({ athlete: value('hbod-av-athlete'), reason: value('hbod-av-reason'),
        from: value('hbod-av-from'), to: value('hbod-av-to') });
      store().availability.push(period);
      availabilityChanged();
    },
    'availability-end': function (el) {
      const p = store().availability[Number(el.getAttribute('data-index'))];
      if (!p) return;
      if (state.date < p.from) throw new Error('The period starts after ' + state.date + '. Choose a later date first.');
      p.to = state.date;
      availabilityChanged();
    },
    'availability-delete': function (el) {
      store().availability.splice(Number(el.getAttribute('data-index')), 1);
      availabilityChanged();
    },
    'availability-export': function () {
      download('HBOD_availability.json', JSON.stringify(store().availability, null, 1) + '\n', 'application/json');
    },
    'copy': function (el) { copyFrom(el.getAttribute('data-target')); },
    'summary-save': function () { saveSummary(); render(); },
    'summary-delete': function (el) {
      store().summaries.splice(Number(el.getAttribute('data-index')), 1);
      persist('summaries');
      state.summaryDraft.saved = null;
      render();
    },
    'summary-export-jsonl': function () {
      download('HBOD_summaries.jsonl', HBODSummary.toJSONL(store().summaries), 'application/x-ndjson');
    },
    'summary-export-csv': function () {
      download('HBOD_summaries.csv', BOM + HBODSummary.toCSV(store().summaries), 'text/csv');
    },
    'summary-clear': function () {
      if (!root.confirm('Delete every saved summary?')) return;
      store().summaries.length = 0;
      persist('summaries');
      state.summaryDraft.saved = null;
      render();
    },
    'audit-export': function () {
      const log = (state.source ? store() : stores.device).audit;
      download('HBOD_audit_log.csv', BOM + HBODCore.toCSV(log.map(function (r) { return auditToObject(r); }), HBODCore.AUDIT_COLUMNS), 'text/csv');
    },
    'audit-clear': function () {
      if (!root.confirm('Delete every line of the audit log? Export it first if it may be needed.')) return;
      (state.source ? store() : stores.device).audit.length = 0;
      persist('audit');
      render();
    },
    'budget-default': function () { setBudget(true, HBODEngine.SETTINGS.alertBudget); },
    'export-all': function () { download('HBOD_export.json', JSON.stringify(exportEverything(), null, 1) + '\n', 'application/json'); },
    'erase-all': function () { eraseEverything(); }
  };

  const changes = {
    'date': function (el) { if (el.value) setDate(el.value); else render(); },
    'athlete': function (el) { selectAthlete(el.value); },
    'range': function (el) { state.range = el.value; render(); },
    'report-periodic': function (el) { state.report.periodic = el.checked; state.report.generated = null; render(); },
    'budget-enabled': function (el) { setBudget(el.checked, state.settings.budget.share); },
    'budget-share': function (el) {
      const percent = Number(el.value);
      if (!(percent >= 1 && percent <= 100)) { render(); throw new Error('The alert rate must be between 1% and 100%.'); }
      setBudget(state.settings.budget.enabled, Math.round(percent) / 100);
    }
  };

  function stepAthlete(step) {
    const names = state.analysis.athletes;
    const k = names.indexOf(state.athlete) + step;
    if (k >= 0 && k < names.length) selectAthlete(names[k]);
  }

  function applyHash(parameters) {
    if (parameters.demo && !(state.source && state.source.kind === 'demo')) loadDemo();
    if (parameters.tab) state.tab = parameters.tab;
    if (parameters.athlete && state.analysis) selectAthlete(parameters.athlete);
    if (parameters.date && state.analysis) setDate(parameters.date);
    render();
  }

  function start() {
    view = document.getElementById('view');
    const banners = document.getElementById('banners');
    bannerList = document.createElement('div');
    banners.appendChild(bannerList);
    if (!HBODEngine || !HBODCore) {
      showError('The engine or the core of HBOD did not load, so nothing can be computed. Build the application file again.');
      return;
    }
    loadStored();
    const foot = document.getElementById('foot-wording');
    if (foot) foot.textContent = HBODCore.WORDING.support + ' ' + HBODCore.WORDING.access;
    const version = document.getElementById('foot-version');
    if (version) version.textContent = 'Engine ' + HBODEngine.VERSION;

    document.getElementById('tabs').addEventListener('click', guard(function (event) {
      const tab = event.target.closest('[data-tab]');
      if (tab) setTab(tab.getAttribute('data-tab'));
    }));
    document.addEventListener('click', guard(function (event) {
      const el = event.target.closest('[data-action]');
      if (el && !el.disabled && actions[el.getAttribute('data-action')]) actions[el.getAttribute('data-action')](el);
    }));
    document.addEventListener('change', function (event) {
      const el = event.target;
      if (el.matches && el.matches('input[type="file"][data-file]')) {
        const kind = el.getAttribute('data-file'), file = el.files && el.files[0];
        el.value = '';
        openFile(kind, file).catch(function (e) { showError(e && e.message ? e.message : String(e)); });
      } else if (el.getAttribute && changes[el.getAttribute('data-change')]) {
        guard(changes[el.getAttribute('data-change')])(el);
      }
    });
    document.addEventListener('input', function (event) {
      const key = event.target.getAttribute && event.target.getAttribute('data-input');
      if (key === 'summary-text') state.summaryDraft.text = event.target.value;
      if (key === 'summary-model') state.summaryDraft.model = event.target.value;
    });
    // a file dropped anywhere on the page is read as a responses file instead of replacing the page
    document.addEventListener('dragover', function (event) {
      event.preventDefault();
      const zone = document.getElementById('hbod-drop');
      if (zone) zone.classList.add('over');
    });
    document.addEventListener('dragleave', function () {
      const zone = document.getElementById('hbod-drop');
      if (zone) zone.classList.remove('over');
    });
    document.addEventListener('drop', function (event) {
      event.preventDefault();
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      openFile('responses', file).catch(function (e) { showError(e && e.message ? e.message : String(e)); });
    });
    let resizeTimer = null, lastWidth = root.innerWidth;
    root.addEventListener('resize', function () {
      if (root.innerWidth === lastWidth) return;
      lastWidth = root.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(guard(function () { if (state.tab === 'athlete' && state.analysis) drawAthleteCharts(); }), 150);
    });
    root.addEventListener('hashchange', guard(function () { applyHash(parseHash(root.location.hash)); }));
    guard(function () { applyHash(parseHash(root.location.hash)); })();
    if (!view.getAttribute('data-tab')) render();
  }

  const api = {
    loadCSVText: loadCSVText,
    loadDemo: loadDemo,
    setDate: setDate,
    setTab: setTab,
    selectAthlete: selectAthlete,
    state: state,
    // pure helpers, exported for the tests
    parseHash: parseHash,
    axis: axis,
    dateTicks: dateTicks,
    cleanPeriod: cleanPeriod,
    formatProbability: formatProbability,
    formatDateLong: formatDateLong,
    esc: esc,
    TABS: TABS
  };
  if (typeof document !== 'undefined') start();
  return api;
});
