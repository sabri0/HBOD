/*
 * HBOD daily report and periodic reviews (JavaScript).
 *
 * Turns the day report of the analytical core (core.js) into the report that the staff read: one self-contained
 * HTML page and the same content as plain text. Nothing is computed or decided here. The probability, the list and
 * the health gate are printed as the core gives them.
 *
 * The health gate comes first, then today's list, then the athletes above the threshold but outside today's alert
 * budget, the table of all athletes, the missing reports to follow up the same day and the unavailable athletes.
 * Acute load, chronic load and their ratio are printed under a "planning only" heading; no colour, label, order or
 * sentence of the report depends on them.
 *
 * The periodic reviews (weekly, monthly, quarterly) are descriptive tables. They hold no suggestion and no decision.
 *
 * Every value that comes from the responses file or from the staff (names, locations, reasons, timestamps) is
 * escaped before it is written into HTML. The page loads nothing from the network.
 *
 * Pure computation: no DOM, no network, no storage, no clock. Runs unchanged in the browser and in Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.HBODReport = factory(root.HBODCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (HBODCore) {
  'use strict';

  const W = HBODCore.WORDING;

  // Section titles, shared by the HTML page and the plain text.
  const TITLES = Object.freeze({
    gate: 'Health gate',
    list: "Today's list",
    overflow: "Above the threshold but outside today's alert rate",
    all: 'All athletes',
    missing: 'Missing reports',
    unavailable: 'Unavailable athletes'
  });

  // Periodic reviews: tag, number of days and title.
  const REVIEWS = Object.freeze([
    Object.freeze({ tag: 'weekly', days: 7, title: 'Weekly review (last 7 days)' }),
    Object.freeze({ tag: 'monthly', days: 28, title: 'Monthly review (last 28 days)' }),
    Object.freeze({ tag: 'quarterly', days: 90, title: 'Quarterly review (last 90 days)' })
  ]);

  const REVIEW_NOTE = 'Descriptive review: it holds no suggestion and no decision. Load is the load used by HBOD ' +
    '(the reported load, the squad median on a day without a report, zero on an unavailable day). The trend ' +
    'compares the later half of the period with the earlier half: up when it is more than 10% higher, down when ' +
    'it is more than 10% lower, otherwise stable. Sleep and fatigue are Hooper items from 1 (best) to 7 (worst).';

  const FOLLOW_UP = 'Contact these athletes today. A missing report is not a sign of recovery.';
  const NO_GATE = 'No athlete is held, referred or stopped by the health gate today.';
  const LIST_FULL = 'These athletes reached the alert threshold, but the daily list is full.';
  const ALL_REPORTED = 'Every healthy athlete reported a session load today.';
  const UNAVAILABLE_NOTE = 'Injured, ill or in return to play: these athletes contribute zero load and are never ' +
    'on the list.';
  const NONE_UNAVAILABLE = 'No athlete is recorded as injured, ill or in return to play today.';
  const EMPTY_FORM = 'a form was received, but it holds no usable session duration and intensity';
  const INCOMPLETE_ITEMS = 'Session load reported, but the four Hooper items are incomplete, so there is no ' +
    'wellness correction today: ';

  // ------------------------------------------------------------------ escaping
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** escapeHTML(value) -> string. Text made safe for HTML content and for quoted attribute values. */
  function escapeHTML(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return s.replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
  }

  // Markup that is already safe. Everything else that enters an element below is escaped.
  function Markup(text) { this.text = text; }

  // Content of an element: markup is kept, any other value is escaped, arrays are joined.
  function content(children) {
    if (Array.isArray(children)) return children.map(content).join('');
    return children instanceof Markup ? children.text : escapeHTML(children);
  }

  // One element. Attribute values are escaped; empty attributes are left out.
  function el(name, attributes, children) {
    let open = '<' + name;
    for (const key of Object.keys(attributes || {})) {
      const value = attributes[key];
      if (value !== null && value !== undefined && value !== '') open += ' ' + key + '="' + escapeHTML(value) + '"';
    }
    return new Markup(open + '>' + content(children) + '</' + name + '>');
  }

  const NEWLINE = new Markup('\n');

  // A fixed sentence of the application. Apostrophes are kept as written so that the sentence can be found
  // verbatim in the page; the sentences hold no markup.
  function fixed(sentence) {
    return new Markup(String(sentence).replace(/[&<>]/g, function (c) { return HTML_ESCAPES[c]; }));
  }

  // ------------------------------------------------------------------ small formatting helpers
  /**
   * formatProbability(p) -> string. The probability with two decimals, as everywhere in the application;
   * 'not available yet' before the personal baseline exists.
   */
  function formatProbability(p) {
    return p === null || p === undefined || Number.isNaN(p) ? 'not available yet' : Number(p).toFixed(2);
  }

  function plural(n, word) { return n === 1 ? word : word + 's'; }

  function percent(share) { return String(Number((Number(share) * 100).toFixed(2))) + '%'; }

  function timestamp(value) {
    if (value === null || value === undefined || value === '') return '';
    return value instanceof Date ? value.toISOString() : String(value);
  }

  function byName(p, q) { return HBODCore.compareText(p.name, q.name); }

  function byRank(p, q) { return (p.rank - q.rank) || byName(p, q); }

  function statusLabel(a) { return HBODCore.STATUS_LABELS[a.status] || String(a.status); }

  function hasRank(a) { return a.rank !== null && a.rank !== undefined; }

  function gateAction(a) { return a.health && a.health.action ? a.health.action : null; }

  function driverLabel(a) {
    if (a.driver === 'wellness strain') return 'Wellness strain';
    if (a.driver === 'load deficit') return 'Load deficit (fatigue minus fitness)';
    return 'n/a';
  }

  // The two parts of the probability, each with two decimals.
  function partsLabel(a) {
    if (a.probability === null || a.probability === undefined) return '';
    return 'wellness strain ' + formatProbability(a.pStrain) + ', load deficit ' + formatProbability(a.pDeficit);
  }

  // What was received from the athlete today and which load HBOD used.
  function reportToday(a, day) {
    if (a.unavailable) {
      const why = a.unavailableReason && a.unavailableReason !== 'unavailable' ? ' (' + a.unavailableReason + ')' : '';
      return 'Unavailable' + why + ': zero load';
    }
    if (a.reported) return 'Reported (' + HBODCore.formatLoad(a.reportedLoad) + ' AU)';
    return day.reporters > 0
      ? 'Missing: squad median used (' + HBODCore.formatLoad(day.squadMedian) + ' AU)'
      : 'Missing: no available athlete reported, 0 AU used';
  }

  // What the athlete declared, as recorded by the daily health item and the weekly Oslo questionnaire.
  function declaredProblem(h) {
    const parts = [];
    if (h.pain) parts.push('pain or discomfort reported today' + (h.location ? ' (' + h.location + ')' : ''));
    if (h.severity !== null && h.severity !== undefined) {
      parts.push('weekly Oslo questionnaire severity ' + h.severity + ' of 100');
    }
    return parts.length ? parts.join('; ') : 'n/a';
  }

  function budgetSetting(day) {
    const b = day.budget, threshold = formatProbability(day.settings.alertProbability);
    if (!b.enabled) {
      return 'Alert rate off: every healthy athlete whose probability reaches ' + threshold + " is on today's list.";
    }
    return 'Alert rate on: ' + percent(b.share) + ' of ' + b.healthy + ' healthy ' + plural(b.healthy, 'athlete') +
      ', so at most ' + b.cap + ' ' + plural(b.cap, 'athlete') + " on today's list.";
  }

  // The fixed sentence on the alert rate describes the default setting; another setting is described as it is.
  function budgetWording(day) {
    const b = day.budget;
    if (!b.enabled) return 'The alert rate is switched off, so the daily list is not capped.';
    if (Math.abs(b.share - 0.10) < 1e-12) return W.budget;
    return 'The alert rate ranks athletes by probability and caps the daily list at ' + percent(b.share) +
      ' of healthy athletes (the default is 10%).';
  }

  function baselineNotice(day) {
    if (day.t >= day.settings.baselineStartDay) return '';
    return 'No probability yet: the personal baseline needs ' + day.settings.baselineStartDay +
      ' previous days of data (' + day.t + ' so far).';
  }

  function emptyList(day, notice) {
    if (notice) return 'No list today. ' + notice;
    return 'No healthy athlete reached the alert threshold of ' + formatProbability(day.settings.alertProbability) +
      ' today.';
  }

  function counters(day) {
    const c = day.counts;
    return [
      'Athletes ' + c.athletes, 'healthy ' + c.healthy, "on today's list " + c.listed,
      'above the threshold, outside the alert rate ' + c.aboveOutsideBudget, 'health gate ' + c.healthGate,
      'missing reports ' + c.missing, 'unavailable ' + c.unavailable
    ];
  }

  function names(athletes) { return athletes.map(function (a) { return a.name; }).join(', '); }

  // The athletes of each section, taken from the day report without any further ranking.
  function sectionsOf(day) {
    const rows = day.athletes;
    return {
      gate: rows.filter(function (a) { return gateAction(a) !== null; }),
      listed: rows.filter(function (a) { return a.status === 'listed'; }).sort(byRank),
      overflow: rows.filter(function (a) { return a.status === 'above-outside-budget'; }).sort(byRank),
      all: rows,
      missing: rows.filter(function (a) { return a.imputed; }).sort(byName),
      incomplete: rows.filter(function (a) {
        return !a.unavailable && a.reported && a.hooperMean === null;
      }).sort(byName),
      unavailable: rows.filter(function (a) { return a.unavailable; }).sort(byName)
    };
  }

  // ------------------------------------------------------------------ HTML page
  // Every rule is scoped to the report, so the page can also be shown inside the application.
  const CSS = [
    '.hbod-report{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1a1a1a;' +
      'background:#fff;max-width:980px;margin:0 auto;padding:18px;font-size:14px;line-height:1.45}',
    '.hbod-report h1{color:#1f3864;font-size:22px;margin:0 0 2px}',
    '.hbod-report h2{color:#1f3864;font-size:16px;margin:24px 0 6px;padding-bottom:3px;' +
      'border-bottom:2px solid #1f3864}',
    '.hbod-report p{margin:6px 0}',
    '.hbod-report .hbod-meta{color:#444;margin:0 0 10px}',
    '.hbod-report .hbod-wording{background:#f2f5fa;border-left:4px solid #1f3864;padding:8px 12px;margin:10px 0}',
    '.hbod-report .hbod-counters{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;padding:0}',
    '.hbod-report .hbod-counters li{border:1px solid #c5cedd;border-radius:4px;padding:3px 9px;background:#fff}',
    '.hbod-report .hbod-note{color:#444;font-size:13px}',
    '.hbod-report table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}',
    '.hbod-report th{background:#dde6f3;color:#1f3864;text-align:left;font-weight:600}',
    '.hbod-report th,.hbod-report td{padding:5px 8px;border-bottom:1px solid #d5dbe6;vertical-align:top}',
    '.hbod-report .hbod-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.hbod-report .hbod-planning{background:#f6f6f6;color:#333}',
    '.hbod-report th.hbod-planning{background:#e7e7e7;color:#333}',
    '.hbod-report .hbod-tag{display:inline-block;border:1px solid #1f3864;border-radius:3px;padding:0 6px;' +
      'font-size:12px;font-weight:700;white-space:nowrap;color:#1f3864;background:#fff}',
    '.hbod-report .hbod-stop{color:#8a1c13;border-color:#8a1c13;background:#fdeceb}',
    '.hbod-report .hbod-refer{color:#7a4100;border-color:#7a4100;background:#fff3e0}',
    '.hbod-report .hbod-hold{color:#5c5200;border-color:#5c5200;background:#fbf7d5}',
    '.hbod-report .hbod-footer{margin-top:26px;padding-top:8px;border-top:1px solid #c5cedd;color:#444;' +
      'font-size:12px}',
    '@media print{.hbod-report{max-width:none;padding:0;font-size:11pt}' +
      '.hbod-report h2{break-after:avoid}.hbod-report tr{break-inside:avoid}' +
      '.hbod-report .hbod-wording,.hbod-report th,.hbod-report .hbod-planning{' +
      '-webkit-print-color-adjust:exact;print-color-adjust:exact}}'
  ].join('\n');

  // The page forbids loading anything; it needs only its own styles.
  const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

  function gateTag(action) {
    const tier = action === 'STOP' ? 'hbod-stop' : action === 'REFER' ? 'hbod-refer' : 'hbod-hold';
    return el('span', { 'class': 'hbod-tag ' + tier }, action);
  }

  function paragraph(text, cls) { return [el('p', { 'class': cls }, text), NEWLINE]; }

  function section(id, title, parts) {
    return [el('section', { 'data-section': id }, [NEWLINE, el('h2', null, title), NEWLINE, parts]), NEWLINE];
  }

  // headers: [label, class] per column; rows: one array of cells per row. A cell takes the class of its column.
  function table(headers, rows) {
    const head = el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', 'class': h[1] }, h[0]); }));
    const body = rows.map(function (cells) {
      return [el('tr', null, cells.map(function (c, k) { return el('td', { 'class': headers[k][1] }, c); })), NEWLINE];
    });
    return [el('table', null, [NEWLINE, el('thead', null, head), NEWLINE, el('tbody', null, [NEWLINE, body]), NEWLINE]),
      NEWLINE];
  }

  function nameCell(a) { return el('strong', null, a.name); }

  function rankCell(a) { return hasRank(a) ? String(a.rank) : '-'; }

  const ALERT_HEADERS = [['Rank', 'hbod-num'], ['Athlete', ''], ['Probability', 'hbod-num'], ['Mainly driven by', ''],
    ['Report today', ''], ['Notes', '']];

  // Rows of today's list and of the athletes above the threshold but outside the budget.
  function alertRows(athletes, day) {
    return athletes.map(function (a) {
      const action = gateAction(a);
      return [rankCell(a), nameCell(a), formatProbability(a.probability),
        [driverLabel(a), new Markup('<br>'), el('span', { 'class': 'hbod-note' }, partsLabel(a))],
        reportToday(a, day), [action ? [gateTag(action), ' '] : '', a.notes.join(' ')]];
    });
  }

  // The table of all athletes. The three planning columns sit under one heading and carry one neutral style.
  function allAthletesTable(athletes, day) {
    const span = function (label, cls) { return el('th', { scope: 'col', rowspan: 2, 'class': cls }, label); };
    const plan = function (label) { return el('th', { scope: 'col', 'class': 'hbod-planning hbod-num' }, label); };
    const top = el('tr', null, [span('Rank', 'hbod-num'), span('Athlete', ''), span('Probability', 'hbod-num'),
      span('Status', ''), span('Health gate', ''), span('Report today', ''),
      el('th', { scope: 'colgroup', colspan: 3, 'class': 'hbod-planning' }, 'Planning only')]);
    const bottom = el('tr', null, [plan('Acute load (AU)'), plan('Chronic load (AU)'), plan('Ratio')]);
    const body = athletes.map(function (a) {
      const action = gateAction(a);
      const planning = function (text) { return el('td', { 'class': 'hbod-planning hbod-num' }, text); };
      return [el('tr', null, [
        el('td', { 'class': 'hbod-num' }, rankCell(a)),
        el('td', null, nameCell(a)),
        el('td', { 'class': 'hbod-num' }, formatProbability(a.probability)),
        el('td', null, statusLabel(a)),
        el('td', null, action ? gateTag(action) : '-'),
        el('td', null, reportToday(a, day)),
        planning(HBODCore.formatLoad(a.planning.acute)),
        planning(HBODCore.formatLoad(a.planning.chronic)),
        planning(HBODCore.formatRatio(a.planning.ratio))
      ]), NEWLINE];
    });
    return [el('table', null, [NEWLINE, el('thead', null, [NEWLINE, top, NEWLINE, bottom, NEWLINE]), NEWLINE,
      el('tbody', null, [NEWLINE, body]), NEWLINE]), NEWLINE];
  }

  function renderHTML(day, options) {
    const s = sectionsOf(day);
    const generated = timestamp(options.generatedAt);
    const notice = baselineNotice(day);
    const periodic = options.periodic;
    const parts = [];

    parts.push(el('h1', null, 'HBOD daily report'), NEWLINE);
    parts.push(el('p', { 'class': 'hbod-meta' }, ['Data through ' + day.date, new Markup('<br>'),
      'Day ' + day.dayNumber + ' of the data, which start on ' + day.startDate]), NEWLINE);
    parts.push(el('div', { 'class': 'hbod-wording', 'data-section': 'wording' }, [NEWLINE,
      paragraph(el('strong', null, fixed(W.probability))), paragraph(fixed(W.probabilityDetail)),
      paragraph(fixed(W.support))]), NEWLINE);
    parts.push(el('ul', { 'class': 'hbod-counters' }, counters(day).map(function (c) { return el('li', null, c); })),
      NEWLINE);
    if (notice) parts.push(paragraph(notice));

    // health gate
    const gate = [paragraph(fixed(W.gate), 'hbod-note')];
    if (s.gate.length) {
      gate.push(table([['Athlete', ''], ['Action', ''], ['What the health gate says', ''], ['Declared', ''],
        ['Probability', 'hbod-num'], ['Status', '']], s.gate.map(function (a) {
        return [nameCell(a), gateTag(a.health.action), a.health.text, declaredProblem(a.health),
          formatProbability(a.probability), statusLabel(a)];
      })));
    } else gate.push(paragraph(NO_GATE));
    parts.push(section('health-gate', TITLES.gate, gate));

    // today's list
    const list = [paragraph(fixed(budgetWording(day)), 'hbod-note'), paragraph(budgetSetting(day), 'hbod-note')];
    if (s.listed.length) list.push(table(ALERT_HEADERS, alertRows(s.listed, day)));
    else list.push(paragraph(emptyList(day, notice)));
    parts.push(section('todays-list', TITLES.list, list));

    // above the threshold, outside the budget
    if (s.overflow.length) {
      parts.push(section('outside-budget', TITLES.overflow,
        [paragraph(LIST_FULL, 'hbod-note'), table(ALERT_HEADERS, alertRows(s.overflow, day))]));
    }

    // all athletes
    parts.push(section('all-athletes', TITLES.all,
      [paragraph(fixed(W.planning), 'hbod-note'), allAthletesTable(s.all, day)]));

    // missing reports
    const missing = [paragraph(fixed(W.missing), 'hbod-note')];
    if (s.missing.length) {
      missing.push(paragraph(el('strong', null, FOLLOW_UP)));
      missing.push(table([['Athlete', ''], ['Today', ''], ['Session loads reported in the last 28 days', 'hbod-num']],
        s.missing.map(function (a) {
          return [nameCell(a), reportToday(a, day) + (a.recordsToday > 0 ? '; ' + EMPTY_FORM : ''),
            String(a.daysReported28)];
        })));
    } else missing.push(paragraph(ALL_REPORTED));
    if (s.incomplete.length) missing.push(paragraph(INCOMPLETE_ITEMS + names(s.incomplete) + '.'));
    parts.push(section('missing-reports', TITLES.missing, missing));

    // unavailable athletes
    const unavailable = [];
    if (s.unavailable.length) {
      unavailable.push(paragraph(UNAVAILABLE_NOTE, 'hbod-note'));
      unavailable.push(table([['Athlete', ''], ['Reason', '']], s.unavailable.map(function (a) {
        return [nameCell(a), a.unavailableReason || 'unavailable'];
      })));
    } else unavailable.push(paragraph(NONE_UNAVAILABLE));
    parts.push(section('unavailable', TITLES.unavailable, unavailable));

    // periodic reviews: markup built by buildPeriodic
    if (periodic && periodic.html) parts.push(new Markup(String(periodic.html)));

    const reviews = periodic && periodic.due ? periodic.due.filter(function (d) { return d !== 'daily'; }) : [];
    const stamp = (generated ? 'Generated ' + generated + ' | ' : '') + 'HBOD engine ' + day.engineVersion +
      (reviews.length ? ' | Reviews included: ' + reviews.join(', ') : '');
    parts.push(el('div', { 'class': 'hbod-footer', 'data-section': 'footer' }, [NEWLINE, paragraph(stamp),
      paragraph([fixed(W.privacy), ' ', fixed(W.access)])]), NEWLINE);

    const head = [NEWLINE,
      new Markup('<meta charset="utf-8">\n'),
      new Markup('<meta http-equiv="Content-Security-Policy" content="' + escapeHTML(PAGE_POLICY) + '">\n'),
      new Markup('<meta name="viewport" content="width=device-width, initial-scale=1">\n'),
      el('title', null, 'HBOD daily report, data through ' + day.date), NEWLINE,
      el('style', null, new Markup('\n' + CSS + '\n')), NEWLINE];
    const body = [NEWLINE, el('div', { 'class': 'hbod-report' }, [NEWLINE, parts]), NEWLINE];
    return '<!DOCTYPE html>\n' + el('html', { lang: 'en' }, [NEWLINE, el('head', null, head), NEWLINE,
      el('body', null, body), NEWLINE]).text + '\n';
  }

  // ------------------------------------------------------------------ plain text
  function heading(title) { return ['', '== ' + title + ' ==']; }

  function rankText(a) { return hasRank(a) ? 'rank ' + a.rank : 'not ranked'; }

  // A planning load with its unit, or 'n/a' while it cannot be computed yet.
  function loadText(au) { return au === null || au === undefined ? 'n/a' : HBODCore.formatLoad(au) + ' AU'; }

  function alertLines(athletes, day) {
    const out = [];
    for (const a of athletes) {
      const action = gateAction(a);
      out.push(a.name + ' (' + rankText(a) + '): probability ' + formatProbability(a.probability) +
        ' | mainly driven by ' + driverLabel(a).toLowerCase() + ' (' + partsLabel(a) + ') | ' + reportToday(a, day) +
        (action ? ' | health gate ' + action : ''));
      if (a.notes.length) out.push('    ' + a.notes.join(' '));
    }
    return out;
  }

  function renderText(day, options) {
    const s = sectionsOf(day);
    const generated = timestamp(options.generatedAt);
    const notice = baselineNotice(day);
    const periodic = options.periodic;
    const lines = [];
    const add = function (more) { for (const l of [].concat(more)) lines.push(l); };

    add('HBOD daily report');
    add('Data through ' + day.date);
    add('Day ' + day.dayNumber + ' of the data, which start on ' + day.startDate);
    add((generated ? 'Generated ' + generated + ' | ' : '') + 'HBOD engine ' + day.engineVersion);
    add(['', W.probability, W.probabilityDetail, W.support, '']);
    add(counters(day).join(' | '));
    if (notice) add(notice);

    add(heading(TITLES.gate));
    add(W.gate);
    for (const a of s.gate) {
      add(a.health.action + ' ' + a.name + ': ' + a.health.text);
      add('    Declared: ' + declaredProblem(a.health) + ' | probability ' + formatProbability(a.probability) +
        ' | ' + statusLabel(a));
    }
    if (!s.gate.length) add(NO_GATE);

    add(heading(TITLES.list));
    add([budgetWording(day), budgetSetting(day)]);
    add(s.listed.length ? alertLines(s.listed, day) : emptyList(day, notice));

    if (s.overflow.length) {
      add(heading(TITLES.overflow));
      add(LIST_FULL);
      add(alertLines(s.overflow, day));
    }

    add(heading(TITLES.all));
    add(W.planning);
    for (const a of s.all) {
      const action = gateAction(a);
      add(a.name + ' (' + rankText(a) + '): probability ' + formatProbability(a.probability) + ' | ' +
        statusLabel(a) + (action ? ' | health gate ' + action : '') + ' | ' + reportToday(a, day) +
        ' | planning only: acute load ' + loadText(a.planning.acute) + ', chronic load ' +
        loadText(a.planning.chronic) + ', ratio ' + HBODCore.formatRatio(a.planning.ratio));
    }

    add(heading(TITLES.missing));
    add(W.missing);
    if (s.missing.length) add(FOLLOW_UP);
    for (const a of s.missing) {
      add(a.name + ': ' + reportToday(a, day) + (a.recordsToday > 0 ? '; ' + EMPTY_FORM : '') +
        ' | session loads reported in the last 28 days: ' + a.daysReported28);
    }
    if (!s.missing.length) add(ALL_REPORTED);
    if (s.incomplete.length) add(INCOMPLETE_ITEMS + names(s.incomplete) + '.');

    add(heading(TITLES.unavailable));
    if (s.unavailable.length) add(UNAVAILABLE_NOTE);
    for (const a of s.unavailable) add(a.name + ': ' + (a.unavailableReason || 'unavailable'));
    if (!s.unavailable.length) add(NONE_UNAVAILABLE);

    if (periodic && periodic.text) add(['', String(periodic.text)]);
    if (periodic && periodic.due) add(['', 'Reports issued: ' + periodic.due.join(', ')]);

    add(['', W.privacy + ' ' + W.access]);
    return lines.join('\n');
  }

  /**
   * buildDailyReport(dayReport, options?) -> { html, text }
   * The daily report of one day, as a self-contained HTML page and as plain text with the same content.
   *   dayReport            the result of HBODCore.dayReport
   *   options.generatedAt  timestamp printed in the report (a string, or a Date written in ISO form); left out
   *                        when it is not given, because this module does not read the clock
   *   options.periodic     the result of buildPeriodic for the same day; its reviews are appended to the report
   * The title "HBOD daily report", the line "Data through {date}" and the fixed sentences on the probability come
   * first. The sections follow in this order: Health gate; Today's list; Above the threshold but outside today's
   * alert rate (only when there is such an athlete); All athletes, with acute load, chronic load and ratio under
   * a "Planning only" heading; Missing reports, to follow up the same day; Unavailable athletes; periodic reviews.
   * The probability is printed with two decimals. Values from the responses file are escaped in the HTML page.
   * In the page each section is a <section data-section="..."> element (health-gate, todays-list, outside-budget,
   * all-athletes, missing-reports, unavailable, review-weekly, review-monthly, review-quarterly); in the text each
   * section starts with a line "== Title ==". The page carries its own styles, scoped to the class hbod-report,
   * no script, and a Content-Security-Policy that forbids loading anything.
   */
  function buildDailyReport(dayReport, options) {
    const o = options || {};
    return { html: renderHTML(dayReport, o), text: renderText(dayReport, o) };
  }

  // ------------------------------------------------------------------ periodic reviews
  /**
   * reportsDue(date) -> string[]
   * Reports issued on a date, with the cadence of the rule-based prototype: 'daily' always; 'weekly' on a
   * Saturday; 'monthly' on the last Saturday of the month; 'quarterly' on the last Saturday of March, June,
   * September and December. The date is written 'YYYY-MM-DD' (any format HBODCore.parseDate reads is accepted).
   * Throws a TypeError when the date cannot be read.
   */
  function reportsDue(date) {
    const d = HBODCore.parseDate(date);
    if (d === null) throw new TypeError('Not a readable date: ' + String(date));
    const due = ['daily'];
    if (HBODCore.weekday(d) === 5) {                                  // Saturday
      due.push('weekly');
      if (HBODCore.addDays(d, 7).slice(0, 7) !== d.slice(0, 7)) {     // last Saturday of the month
        due.push('monthly');
        if ([3, 6, 9, 12].indexOf(Number(d.slice(5, 7))) >= 0) due.push('quarterly');
      }
    }
    return due;
  }

  function sum(values, from, to) {
    let total = 0;
    for (let k = Math.max(0, from); k <= to; k++) total += values[k];
    return total;
  }

  // Mean of the values that were given on the days from..to, or null when none was given.
  function meanGiven(values, from, to) {
    let total = 0, n = 0;
    for (let k = Math.max(0, from); k <= to; k++) {
      if (values[k] !== null && values[k] !== undefined) { total += values[k]; n += 1; }
    }
    return n ? total / n : null;
  }

  function countTrue(values, from, to) {
    let n = 0;
    for (let k = Math.max(0, from); k <= to; k++) if (values[k]) n += 1;
    return n;
  }

  /**
   * reviewRows(analysis, t, days) -> object[]
   * One descriptive row per athlete for the period of `days` days that ends on day index t:
   *   { athlete, days (days of data inside the period), load (AU used by HBOD, summed), daysReported, daysOnList,
   *     sleep, fatigue (mean of the Hooper item over the days it was given, or null),
   *     trend: 'up' | 'down' | 'stable' | null }
   * The trend follows the rule-based prototype: the load of the later half of the period (its last days / 2
   * days, rounded down) against the load of the earlier half; up above 110%, down below 90%. It is null while
   * the data do not yet cover the whole period.
   */
  function reviewRows(analysis, t, days) {
    const from = t - days + 1, half = Math.floor(days / 2);
    return analysis.athletes.map(function (name) {
      const s = HBODCore.series(analysis, name);
      const earlier = sum(s.load, from, t - half), later = sum(s.load, t - half + 1, t);
      let trend = null;
      if (from >= 0) trend = later > earlier * 1.1 ? 'up' : later < earlier * 0.9 ? 'down' : 'stable';
      return {
        athlete: name,
        days: t - Math.max(0, from) + 1,
        load: sum(s.load, from, t),
        daysReported: countTrue(s.reported, from, t),
        daysOnList: countTrue(s.listed, from, t),
        sleep: meanGiven(s.items.sleep, from, t),
        fatigue: meanGiven(s.items.fatigue, from, t),
        trend: trend
      };
    });
  }

  function formatItem(v) { return v === null ? 'n/a' : v.toFixed(1); }

  const REVIEW_HEADERS = [['Athlete', ''], ['Load used (AU)', 'hbod-num'], ['Days reported', 'hbod-num'],
    ['Days on the list', 'hbod-num'], ['Mean sleep item', 'hbod-num'], ['Mean fatigue item', 'hbod-num'],
    ['Load trend', '']];

  /**
   * buildPeriodic(analysis, date?, options?) -> { due, html, text }
   * The periodic reviews issued on a day (default: the last day of the analysis).
   *   due   reportsDue(date), or 'daily' and the reviews named in options.due when the caller asks for given
   *         reviews, for example { due: ['weekly'] } to show the weekly review on another day
   *   html  one <section> per review ('' when only the daily report is due), to pass to buildDailyReport
   *   text  the same reviews as plain text ('' when only the daily report is due)
   * A review is a descriptive table with one row per athlete, in the order of analysis.athletes: load used by
   * HBOD over the period, days with a reported session load, days on the list, mean sleep item, mean fatigue item
   * and load trend. It holds no suggestion and no decision, and it does not use the ratio of acute to chronic load.
   * Throws a RangeError when the date is outside the analysis.
   */
  function buildPeriodic(analysis, date, options) {
    const o = options || {};
    const given = date === null || date === undefined || date === '' ? analysis.endDate : HBODCore.parseDate(date);
    if (given === null) throw new TypeError('Not a readable date: ' + String(date));
    const t = HBODCore.dayDiff(analysis.startDate, given);
    if (t < 0 || t >= analysis.dates.length) {
      throw new RangeError('The date ' + given + ' is outside the data (' + analysis.startDate + ' to ' +
        analysis.endDate + ').');
    }
    const due = !o.due ? reportsDue(given) : ['daily'].concat(REVIEWS.map(function (r) { return r.tag; })
      .filter(function (tag) { return o.due.indexOf(tag) >= 0; }));

    const pages = [], texts = [];
    for (const review of REVIEWS) {
      if (due.indexOf(review.tag) < 0) continue;
      const rows = reviewRows(analysis, t, review.days);
      const covered = Math.min(review.days, t + 1);
      const title = review.title +
        (covered < review.days ? ', ' + covered + ' ' + plural(covered, 'day') + ' of data' : '');
      pages.push(content(section('review-' + review.tag, title, [paragraph(REVIEW_NOTE, 'hbod-note'),
        table(REVIEW_HEADERS, rows.map(function (r) {
          return [el('strong', null, r.athlete), HBODCore.formatLoad(r.load), r.daysReported + ' of ' + r.days,
            String(r.daysOnList), formatItem(r.sleep), formatItem(r.fatigue), r.trend || 'n/a'];
        }))])));
      const lines = ['== ' + title + ' ==', REVIEW_NOTE];
      for (const r of rows) {
        lines.push(r.athlete + ': load used ' + HBODCore.formatLoad(r.load) + ' AU | reported ' + r.daysReported +
          ' of ' + r.days + ' days | on the list ' + r.daysOnList + ' ' + plural(r.daysOnList, 'day') +
          ' | mean sleep item ' + formatItem(r.sleep) + ' | mean fatigue item ' + formatItem(r.fatigue) +
          ' | load trend ' + (r.trend || 'n/a'));
      }
      texts.push(lines.join('\n'));
    }
    return { due: due, html: pages.join(''), text: texts.join('\n\n') };
  }

  return {
    buildDailyReport: buildDailyReport,
    buildPeriodic: buildPeriodic,
    reportsDue: reportsDue,
    reviewRows: reviewRows,
    formatProbability: formatProbability,
    escapeHTML: escapeHTML,
    TITLES: TITLES,
    REVIEWS: REVIEWS
  };
});
