/*
 * HBOD language-model layer (JavaScript).
 *
 * A language model may restate the computed result in plain language. It never computes or changes the
 * probability, the list or the health gate. This module therefore holds only what surrounds the model: the
 * constrained prompt, a deterministic block of computed facts for the model to restate, the record that stores
 * the engine's probability next to each generated summary, and an automatic check of a summary against the facts.
 * No model is called here; the application lets the staff copy the prompt and paste the answer, and
 * cli/summarize.js can send it on explicit request.
 *
 * The probability shown to the reader is always printed by the application from the engine's value. It is never
 * read back from the text of a model.
 *
 * checkFaithfulness is a screening aid for the field study. It compares words and numbers; it does not understand
 * a sentence. A summary that passes may still be wrong, and a summary that is flagged may be acceptable. It is not
 * proof of faithfulness and does not replace the reading of the summaries by the staff.
 *
 * Pure computation apart from the timestamp that makeRecord adds when none is given: no DOM, no network, no
 * storage. Runs unchanged in the browser and in Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.HBODSummary = factory(root.HBODCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (HBODCore) {
  'use strict';

  const W = HBODCore.WORDING;

  const PROMPT_VERSION = 'hbod-summary-prompt/1';
  const SCHEMA = 'hbod-summary/1';
  const NOT_AVAILABLE = 'not available';
  const DEFAULT_THRESHOLD = 0.80;       // alert threshold of the paper, used when no day report is given

  // ------------------------------------------------------------------ the constrained prompt
  const SYSTEM_PROMPT = [
    'You are the language layer of HBOD (Hooper-Borg-Oslo-Dergaa), a monitor of training load, wellness and ' +
      'health used by coaches. HBOD has already computed everything in the data block that follows: the ' +
      'probability of each athlete, the status on today\'s list, the health gate and the notes. Your only task is ' +
      'to restate that computed result in plain language for the coach.',
    '',
    'What the probability means',
    W.probability,
    W.probabilityDetail,
    '',
    'Rules',
    '1. Restate only. Never compute, recompute, round, estimate or alter any number, and never derive a new ' +
      'number from the numbers given (no difference, percentage, average, total or trend).',
    '2. Never change the probability, the status or the list. Quote the probability exactly as it is written in ' +
      'the data block, with the same digits.',
    '3. Never call the probability a risk, a likelihood or a chance of injury or illness, and never predict an ' +
      'injury or an illness. Describe it as the probability that the modelled state of the athlete exceeds his or ' +
      'her own baseline.',
    '4. The health gate comes first. When an athlete has a STOP, REFER or HOLD action, begin with it and say that ' +
      'anything clinical is for the medical staff.',
    '5. Give no diagnosis and no advice on treatment or medication.',
    '6. ' + W.support + ' Describe and explain; do not instruct.',
    '7. When a value is marked "' + NOT_AVAILABLE + '", say that it is not available. Never guess and never fill ' +
      'a gap.',
    '8. Acute load, chronic load and their ratio may be mentioned for planning only, in a sentence that says so, ' +
      'and never as a reason for an alert or for a place on the list.',
    '9. Use only the facts of the data block. Add no fact, name, date or number that is not in it.',
    '',
    'Output',
    'One or two sentences per athlete, in plain English, in the order of the data block. Begin the text of each ' +
      'athlete with the name or code of the athlete exactly as written in the data block, followed by a colon. ' +
      'No heading, no list, no introduction and no closing remark.'
  ].join('\n');

  // ------------------------------------------------------------------ formatting
  /**
   * formatProbability(p) -> string
   * The one formatting of the probability used everywhere: two decimals ('0.87'); null, before the personal
   * baseline exists, gives 'not available yet'.
   */
  function formatProbability(p) {
    return p === null || p === undefined || Number.isNaN(p) ? 'not available yet' : Number(p).toFixed(2);
  }

  function percent(share) { return String(Number((Number(share) * 100).toFixed(2))) + '%'; }

  // A text as a regular expression that matches it literally (also valid with the unicode flag).
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

  // ------------------------------------------------------------------ names and codes
  const CODE_PREFIXES = ['ATH', 'COD', 'PSN'];

  function pairsOf(map) {
    if (!map) return [];
    if (map instanceof Map) return Array.from(map.entries());
    return Object.keys(map).map(function (k) { return [k, map[k]]; });
  }

  function codeOf(map, name) {
    for (const pair of pairsOf(map)) if (pair[0] === name) return pair[1];
    return null;
  }

  /**
   * pseudonyms(names) -> { name: code }
   * A code for each athlete, used in place of the name in a data block that leaves the device. The codes are
   * 'ATH01', 'ATH02', ... in the order of the names sorted by code point, so the same squad always gets the same
   * codes and a text written with codes can be matched to the athletes again. Another prefix is taken when a name
   * already looks like such a code. The result has no prototype, so any name can be a key.
   */
  function pseudonyms(names) {
    const sorted = Array.from(new Set(names)).sort(HBODCore.compareText);
    const taken = function (prefix) {
      const re = new RegExp(escapeRegExp(prefix) + '\\d', 'i');
      return sorted.some(function (n) { return re.test(n); });
    };
    let prefix = CODE_PREFIXES.find(function (p) { return !taken(p); }) || CODE_PREFIXES[0];
    while (taken(prefix)) prefix += 'X';
    const width = Math.max(2, String(sorted.length).length);
    const map = Object.create(null);
    sorted.forEach(function (name, k) { map[name] = prefix + String(k + 1).padStart(width, '0'); });
    return map;
  }

  // Replaces whole occurrences of the given texts in one pass, the longest first, ignoring case. An occurrence
  // inside a longer word or number is left alone.
  function replaceWhole(text, pairs) {
    const usable = pairs.filter(function (p) { return p[0] !== '' && p[0] !== null && p[0] !== undefined; });
    if (!usable.length) return String(text);
    const lookup = new Map(usable.map(function (p) { return [String(p[0]).toLowerCase(), String(p[1])]; }));
    const alternatives = usable.map(function (p) { return String(p[0]); })
      .sort(function (a, b) { return b.length - a.length; }).map(escapeRegExp).join('|');
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + alternatives + ')(?![\\p{L}\\p{N}])', 'giu');
    return String(text).replace(re, function (whole, before, found) {
      const to = lookup.get(found.toLowerCase());
      return before + (to === undefined ? found : to);
    });
  }

  /**
   * restoreNames(text, pseudonyms) -> string
   * Puts the names of the athletes back in a text written with their codes.
   */
  function restoreNames(text, map) {
    return replaceWhole(text, pairsOf(map).map(function (p) { return [p[1], p[0]]; }));
  }

  // Replaces the names of athletes by their codes in a piece of free text.
  function hideNames(text, map) { return replaceWhole(text, pairsOf(map)); }

  // ------------------------------------------------------------------ the data block
  const STANDARD_REASONS = ['injured', 'ill', 'return to play'];

  function findAthlete(day, name) {
    const wanted = name && typeof name === 'object' ? name.name : name;
    const a = day.athletes.find(function (x) { return x.name === wanted; });
    if (!a) throw new RangeError('Unknown athlete for this day: ' + String(wanted));
    return a;
  }

  function loadText(au) { return au === null || au === undefined ? NOT_AVAILABLE : HBODCore.formatLoad(au) + ' AU'; }

  // The facts of one athlete. They depend on the athlete's entry of the day report only.
  //   o.label     name or code written for the athlete
  //   o.freeText  whether text typed by the athlete or the staff (location, free reason) is written
  //   o.codes     names to replace by codes inside such text
  function athleteBlock(a, o) {
    const h = a.health || {};
    const typed = function (text) { return hideNames(text, o.codes); };
    const lines = ['- Athlete: ' + o.label];

    // the health gate comes first
    if (h.action) {
      const declared = [];
      if (h.pain) {
        declared.push('pain or discomfort reported today' +
          (o.freeText && h.location ? ' (location: ' + typed(h.location) + ')' : ''));
      }
      if (h.severity !== null && h.severity !== undefined) {
        declared.push('weekly Oslo questionnaire severity ' + h.severity + ' of 100');
      }
      lines.push('  Health gate: ' + h.action + '. ' + h.text +
        (declared.length ? ' Declared: ' + declared.join('; ') + '.' : ''));
    } else lines.push('  Health gate: none');

    lines.push('  Probability: ' + formatProbability(a.probability));
    lines.push('  Status: ' + (HBODCore.STATUS_LABELS[a.status] || a.status) +
      (a.rank !== null && a.rank !== undefined ? '; rank ' + a.rank + ' by probability among healthy athletes' : ''));
    if (a.probability !== null && a.probability !== undefined) {
      lines.push('  The two parts of the probability: load deficit ' + formatProbability(a.pDeficit) +
        '; wellness strain ' + formatProbability(a.pStrain));
      lines.push('  Mainly driven by: ' + a.driver);
    }

    if (a.unavailable) {
      const reason = a.unavailableReason;
      const shown = reason && (STANDARD_REASONS.indexOf(reason) >= 0 || (o.freeText && reason !== 'unavailable'));
      lines.push('  Session load today: unavailable' + (shown ? ' (' + typed(reason) + ')' : '') +
        '; zero load is used');
    } else if (a.reported) {
      lines.push('  Session load today: reported, ' + loadText(a.reportedLoad));
    } else {
      lines.push('  Session load today: not reported; ' + loadText(a.load) + ' used in its place');
    }

    const items = a.hooper;
    lines.push('  Hooper items today (four items, 1 best to 7 worst): ' + (items
      ? ['fatigue', 'stress', 'soreness', 'sleep'].map(function (k) {
        return k + ' ' + (items[k] === null || items[k] === undefined ? NOT_AVAILABLE : String(items[k]));
      }).join('; ')
      : NOT_AVAILABLE));
    lines.push('  Days with a reported session load among the last 28: ' + a.daysReported28);
    lines.push('  Planning only (never a reason for an alert): acute load ' + loadText(a.planning.acute) +
      '; chronic load ' + loadText(a.planning.chronic) + '; ratio ' +
      HBODCore.formatRatio(a.planning.ratio, NOT_AVAILABLE));

    // the note on unavailability repeats the line above and may carry a reason typed by the staff
    const typedReason = a.unavailable && a.unavailableReason && STANDARD_REASONS.indexOf(a.unavailableReason) < 0
      ? a.unavailableReason : null;
    const notes = (a.notes || []).filter(function (n) {
      if (a.unavailable && /^Unavailable\b/.test(n)) return false;
      return o.freeText || typedReason === null || n.indexOf(typedReason) < 0;
    });
    lines.push('  Notes: ' + (notes.length ? notes.map(typed).join(' ') : 'none'));
    return lines.join('\n');
  }

  function dayHeader(day) {
    const c = day.counts, b = day.budget;
    const threshold = formatProbability(day.settings ? day.settings.alertProbability : DEFAULT_THRESHOLD);
    return [
      'HBOD computed result. Data through ' + day.date + ' (day ' + day.dayNumber + ' of the data). HBOD engine ' +
        day.engineVersion + '.',
      'Squad today: ' + c.athletes + ' athletes, ' + c.healthy + ' healthy and ' + c.unavailable +
        ' unavailable; ' + c.reported + ' healthy athletes reported a session load and ' + c.missing + ' did not.',
      'Alert threshold: ' + threshold + '. Alert rate: ' + (b.enabled
        ? 'on, ' + percent(b.share) + ' of healthy athletes, at most ' + b.cap + " on today's list."
        : "off, every healthy athlete at or above the threshold is on today's list."),
      "On today's list: " + c.listed + ". Above the threshold but outside today's alert rate: " +
        c.aboveOutsideBudget + '. Health gate: ' + c.healthGate + '.',
      'Every value below is final. Restate it; do not change it.'
    ].join('\n');
  }

  /**
   * buildDataBlock(dayReport, options?) -> string
   * The deterministic block of computed facts that a language model is asked to restate: a few lines on the day,
   * then one block per athlete in the display order of the day report (health gate first). The same day report
   * and options always give the same text. The probability is written with formatProbability.
   *   options.athlete     one name, or a list of names, to restrict the block to (default: every athlete).
   *                       An unknown name throws a RangeError.
   *   options.pseudonyms  { name: code } (or a Map), for example from pseudonyms(): each athlete is written by
   *                       the code and no name appears in the block. Use it for a block that leaves the device.
   *   options.freeText    whether text typed by an athlete or by the staff (the location of a pain, a free
   *                       reason of unavailability) is written. Default: true without pseudonyms and false with
   *                       them, because typed text can identify a person.
   */
  function buildDataBlock(dayReport, options) {
    const o = options || {};
    const codes = o.pseudonyms || null;
    const freeText = o.freeText === undefined || o.freeText === null ? !codes : !!o.freeText;
    const none = o.athlete === undefined || o.athlete === null || o.athlete === '';
    const wanted = none ? null : [].concat(o.athlete).map(function (n) { return findAthlete(dayReport, n).name; });
    const rows = dayReport.athletes.filter(function (a) { return wanted === null || wanted.indexOf(a.name) >= 0; });
    const blocks = rows.map(function (a) {
      const code = codes ? codeOf(codes, a.name) : null;
      if (codes && !code) throw new RangeError('No code was given for the athlete ' + a.name + '.');
      return athleteBlock(a, { label: code || a.name, freeText: freeText, codes: codes });
    });
    return dayHeader(dayReport) + '\n\n' + blocks.join('\n\n') + '\n';
  }

  // ------------------------------------------------------------------ reading a summary
  // Numbers written with digits: '412', '0.87', '.87', '0,87' (decimal comma) and '1,250' (thousands).
  const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?|\.\d+/g;
  const PERCENT_RE = /^\s?(?:%|per\s?cent\b)/i;
  const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
  const NUMBER_WORDS = { two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12' };
  const NUMBER_WORD_RE = new RegExp('\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\b', 'gi');

  // A number in one written form: '0.80' and '0.8' give '0.8', '031' gives '31', '1,250' gives '1250'.
  function canonical(raw) {
    let s = String(raw);
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
    if (s[0] === '.') s = '0' + s;
    const parts = s.split('.');
    const whole = parts[0].replace(/^0+(?=\d)/, '');
    const fraction = (parts[1] || '').replace(/0+$/, '');
    return fraction ? whole + '.' + fraction : whole;
  }

  // Number tokens of a text: { raw, value, index, decimal, percent, word }. Digits that follow a letter, as in
  // a code such as 'ATH07', are not numbers.
  function numberTokens(text) {
    const out = [];
    let m;
    NUMBER_RE.lastIndex = 0;
    while ((m = NUMBER_RE.exec(text)) !== null) {
      const before = m.index > 0 ? text[m.index - 1] : '';
      if (before && WORD_CHAR_RE.test(before)) continue;
      const raw = m[0];
      const thousands = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(raw);
      out.push({ raw: raw, value: canonical(raw), index: m.index, decimal: thousands ? raw.indexOf('.') >= 0
        : /[.,]/.test(raw), percent: PERCENT_RE.test(text.slice(m.index + raw.length)), word: false });
    }
    NUMBER_WORD_RE.lastIndex = 0;
    while ((m = NUMBER_WORD_RE.exec(text)) !== null) {
      out.push({ raw: m[0], value: NUMBER_WORDS[m[0].toLowerCase()], index: m.index, decimal: false, percent: false,
        word: true });
    }
    return out.sort(function (p, q) { return p.index - q.index; });
  }

  // Sentences of a text with their position. A full stop inside a number does not end a sentence.
  function sentencesOf(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const ends = c === '\n' ||
        ((c === '.' || c === '!' || c === '?') && (i + 1 === text.length || /\s/.test(text[i + 1])));
      if (!ends) continue;
      if (text.slice(start, i + 1).trim() !== '') out.push({ text: text.slice(start, i + 1), start: start });
      start = i + 1;
    }
    if (text.slice(start).trim() !== '') out.push({ text: text.slice(start), start: start });
    return out;
  }

  function sentenceAt(sentences, index) {
    for (const s of sentences) if (index >= s.start && index < s.start + s.text.length) return s;
    return { text: '', start: 0 };
  }

  // The words between the last negation before a position and that position, or null when there is none.
  // "No risk" denies a risk, which is still a statement about risk, so "no" does not open a disclaimer.
  const DISCLAIMER_NEGATION_RE = /\b(?:not|never|nor|rather\s+than|instead\s+of)\b|n't\b/gi;
  const STATUS_NEGATION_RE = /\b(?:not|never|no|nor|neither|nobody|none|off|without)\b|n't\b/gi;
  function wordsAfterNegation(sentence, position, negation) {
    const head = sentence.slice(0, position);
    let m, end = -1;
    negation.lastIndex = 0;
    while ((m = negation.exec(head)) !== null) end = m.index + m[0].length;
    if (end < 0) return null;
    return head.slice(end).toLowerCase().split(/[^a-z']+/).filter(Boolean);
  }

  // Words that may stand between a negation and a term in a statement that the probability is not a risk, as in
  // "it is not an injury risk" or "it does not predict an injury".
  const DISCLAIMER_WORDS = new Set(['a', 'an', 'the', 'any', 'as', 'of', 'to', 'be', 'been', 'being', 'is', 'it',
    'itself', 'that', 'this', 'injury', 'injuries', 'illness', 'or', 'and', 'measure', 'measures', 'indicate',
    'indicates', 'mean', 'means', 'show', 'shows', 'predict', 'predicts', 'forecast', 'forecasts', 'represent',
    'represents', 'express', 'expresses', 'describe', 'describes', 'estimate', 'estimates', 'give', 'gives',
    'state', 'states', 'imply', 'implies', 'presented', 'read', 'taken', 'treated', 'interpreted', 'understood',
    'seen', 'called', 'future']);

  function isDisclaimed(sentence, position) {
    const words = wordsAfterNegation(sentence, position, DISCLAIMER_NEGATION_RE);
    return words !== null && words.length <= 6 && words.every(function (w) { return DISCLAIMER_WORDS.has(w); });
  }

  // A negation just before a position, with at most two words in between, as in "not yet on today's list".
  function isNegated(sentence, position) {
    const words = wordsAfterNegation(sentence, position, STATUS_NEGATION_RE);
    return words !== null && words.length <= 2;
  }

  // Wording that presents the probability as a risk, likelihood or chance of injury or illness.
  const HARM = '(?:injur\\w*|illness\\w*|ill|sick\\w*|hurt|break(?:ing)?\\s+down)';
  const RISK_PATTERNS = [
    /\b(?:at[- ]risk|risk(?:s|y|ier|iest)?|danger(?:s|ous|ously)?|hazard(?:s|ous)?)\b/gi,
    new RegExp('\\b(?:likelihood|chances?|odds|probabilit(?:y|ies)|likely|prone|liable|susceptib\\w+|vulnerab\\w+)' +
      '\\s+(?:of|to|for)\\s+(?:\\w+\\s+){0,4}?' + HARM + '\\b', 'gi'),
    /\b(?:injur(?:y|ies)|illness)\s+(?:probabilit(?:y|ies)|likelihood|chances?|odds|forecasts?|predictions?)\b/gi,
    new RegExp('\\b(?:predict|forecast|foresee|anticipat)\\w*\\s+(?:\\w+\\s+){0,3}?' + HARM + '\\b', 'gi')
  ];

  const ON_LIST_RE = /\bon\s+(?:today's|the)\s+(?:daily\s+|alert\s+)?list\b|\b(?:is|was|been)\s+listed\b/gi;
  const OUTSIDE_BUDGET_RE = /\boutside\s+(?:today's|the)\s+(?:alert\s+)?(?:rate|budget)\b/i;
  const BELOW_THRESHOLD_RE = /\bbelow\s+the\s+(?:alert\s+)?threshold\b/gi;
  const ABOVE_THRESHOLD_RE =
    /\b(?:above|over|beyond|exceed\w*|reach\w*|cross\w*|pass\w*)\s+the\s+(?:alert\s+)?threshold\b/gi;
  const PLANNING_TERMS_RE = /\bratio\b|\bACWR\b|\bacute\b|\bchronic\b|\bworkloads?\b/i;
  const GATE_WORDS = { STOP: /\bstop/i, REFER: /\brefer/i, HOLD: /\bhold|\bheld\b/i };

  // First match of a pattern in the sentences for which the test holds, or null.
  function findClaim(sentences, pattern, test) {
    for (const s of sentences) {
      let m;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(s.text)) !== null) {
        if (test(s.text, m.index)) return m[0];
        if (!pattern.global) break;
      }
    }
    return null;
  }

  /**
   * checkFaithfulness(summary, athleteReport, context?) -> { ok, issues, codes }
   * Automatic check of one generated summary against the computed result of the athlete. It is deterministic and
   * conservative: when in doubt it flags. It is a screening aid for the field study and not proof of
   * faithfulness: it compares numbers and wording and cannot judge the meaning of a sentence.
   *   summary        the text written by the language model for this athlete, with the name restored
   *   athleteReport  the athlete's entry of the day report (one element of dayReport.athletes)
   *   context        optional: { dayReport, dataBlock, pseudonym }. With the day report, the numbers of the day
   *                  (date, squad counts, budget) are also accepted in the summary; dataBlock is the block that
   *                  was given to the model when it differs from buildDataBlock(dayReport, { athlete });
   *                  pseudonym is the code that stood for the athlete.
   *   ok             true when nothing was flagged
   *   issues         one plain sentence per flag
   *   codes          the kind of each flag, in the same order:
   *     'empty-summary'            there is no text
   *     'probability-not-quoted'   the probability is not quoted exactly as shown (for example '0.87')
   *     'probability-mismatch'     a value between 0 and 1, or a percentage, that is neither the probability shown,
   *                                one of its two parts, the alert threshold nor a planning value in a sentence
   *                                on planning
   *     'number-not-in-data'       a number, in digits or as a word from two to twelve, that is not in the data
   *                                block; the name of the athlete is not read as a number
   *     'risk-wording'             wording that presents the probability as a risk, likelihood or chance of injury
   *                                or illness; the statement that it is not an injury risk is accepted
   *     'health-gate-missing'      the athlete has a STOP, REFER or HOLD action that the summary does not state
   *     'health-gate-not-first'    the action is stated after the probability
   *     'list-status-mismatch'     the summary places the athlete on or off today's list, or above or below the
   *                                threshold, against the computed status
   *     'ratio-outside-planning'   acute load, chronic load or their ratio mentioned in a sentence that does not
   *                                say that it is for planning
   */
  function checkFaithfulness(summary, athleteReport, context) {
    const a = athleteReport, ctx = context || {};
    const issues = [], codes = [];
    const flag = function (code, message) {
      if (issues.indexOf(message) >= 0) return;                 // the same remark is made once
      codes.push(code);
      issues.push(message);
    };

    // working copy: plain apostrophes, and the name of the athlete blanked out so that its digits are not numbers
    let text = String(summary === null || summary === undefined ? '' : summary).replace(/[\u2018\u2019]/g, "'");
    const blank = function (found) { return ' '.repeat(found.length); };
    for (const label of [a.name, ctx.pseudonym]) {
      if (label) text = text.replace(new RegExp(escapeRegExp(label), 'gi'), blank);
    }
    if (text.trim() === '') flag('empty-summary', 'The summary is empty.');

    const shown = a.probability === null || a.probability === undefined ? null : formatProbability(a.probability);
    const threshold = ctx.dayReport && ctx.dayReport.settings ? ctx.dayReport.settings.alertProbability
      : DEFAULT_THRESHOLD;
    const block = ctx.dataBlock !== undefined && ctx.dataBlock !== null ? String(ctx.dataBlock)
      : ctx.dayReport ? buildDataBlock(ctx.dayReport, { athlete: a.name })
        : athleteBlock(a, { label: a.name, freeText: true, codes: null });
    const allowedTokens = numberTokens(block + '\n' + W.probability + ' ' + W.probabilityDetail);
    const allowed = new Set(allowedTokens.map(function (t) { return t.value; }));
    const allowedPercent = new Set(allowedTokens.filter(function (t) { return t.percent; })
      .map(function (t) { return t.value; }));
    const probabilityValues = new Set([formatProbability(threshold)]
      .concat(shown === null ? [] : [shown, formatProbability(a.pDeficit), formatProbability(a.pStrain)])
      .map(canonical));
    const plan = a.planning || {};
    const planningValues = new Set([HBODCore.formatLoad(plan.acute, ''), HBODCore.formatLoad(plan.chronic, ''),
      HBODCore.formatRatio(plan.ratio, '')].filter(Boolean).map(canonical));

    const sentences = sentencesOf(text);
    const tokens = numberTokens(text);

    // the probability, quoted exactly
    const quoted = shown === null ? null : tokens.find(function (t) { return !t.percent && t.raw === shown; });
    if (shown !== null && !quoted) {
      flag('probability-not-quoted', 'The probability shown (' + shown + ') is not quoted exactly in the summary.');
    }

    for (const t of tokens) {
      const planning = /\bplanning\b/i.test(sentenceAt(sentences, t.index).text);
      const like = t.percent || (t.decimal && Number(t.value) >= 0 && Number(t.value) <= 1);
      if (like) {
        const fine = t.percent ? allowedPercent.has(t.value)
          : probabilityValues.has(t.value) || (planning && planningValues.has(t.value));
        if (!fine) {
          flag('probability-mismatch', 'The summary gives the value ' + t.raw + (t.percent ? '%' : '') +
            ', which is not the probability shown (' + (shown === null ? 'not available yet' : shown) + ').');
        }
      }
      if (!allowed.has(t.value)) {
        flag('number-not-in-data', 'The number ' + t.raw + ' is not in the data block.');
      }
    }

    // risk wording
    for (const pattern of RISK_PATTERNS) {
      const found = findClaim(sentences, pattern, function (s, at) { return !isDisclaimed(s, at); });
      if (found !== null) {
        flag('risk-wording', 'The wording "' + found + '" presents the probability as a risk of injury or illness.');
      }
    }

    // health gate
    const action = a.health ? a.health.action : null;
    if (action && GATE_WORDS[action]) {
      const at = text.search(GATE_WORDS[action]);
      if (at < 0) flag('health-gate-missing', 'The health gate (' + action + ') is not stated in the summary.');
      else if (quoted && at > quoted.index) {
        flag('health-gate-not-first', 'The health gate (' + action + ') is stated after the probability.');
      }
    }

    // status on the list and against the threshold
    const affirmed = function (s, at) { return !isNegated(s, at); };
    const scored = shown !== null && !a.unavailable;
    let conflict = null;
    if (a.status === 'listed') {
      conflict = findClaim(sentences, ON_LIST_RE, isNegated) || findClaim(sentences, OUTSIDE_BUDGET_RE, affirmed);
    } else conflict = findClaim(sentences, ON_LIST_RE, affirmed);
    if (conflict === null && scored && a.alert) conflict = findClaim(sentences, BELOW_THRESHOLD_RE, affirmed);
    if (conflict === null && scored && !a.alert) conflict = findClaim(sentences, ABOVE_THRESHOLD_RE, affirmed);
    if (conflict !== null) {
      flag('list-status-mismatch', 'The wording "' + conflict + '" does not agree with the computed status (' +
        (HBODCore.STATUS_LABELS[a.status] || a.status) + ').');
    }

    // planning indices
    for (const s of sentences) {
      if (PLANNING_TERMS_RE.test(s.text) && !/\bplanning\b/i.test(s.text)) {
        flag('ratio-outside-planning', 'Acute load, chronic load or their ratio is mentioned in a sentence that ' +
          'does not say that it is for planning only.');
        break;
      }
    }

    return { ok: issues.length === 0, issues: issues, codes: codes };
  }

  // ------------------------------------------------------------------ records
  /**
   * makeRecord({ dayReport, athlete, summary, model, createdAt, pseudonym?, dataBlock? }) -> record
   * The record stored for one generated summary. The probability comes from the day report, never from the text
   * of the summary, so that the faithfulness of the summary can be tested against it later.
   *   athlete    name of the athlete (or the athlete's entry of the day report); unknown names throw a RangeError
   *   summary    the text written by the language model, with the name of the athlete restored
   *   model      identifier of the model that wrote it, or null when it is not known
   *   createdAt  timestamp (a string, or a Date written in ISO form); the current time when it is not given
   *   pseudonym  the code that stood for the athlete when the data block left the device, if any
   *   dataBlock  the block that was given to the model; default buildDataBlock(dayReport, { athlete })
   *   record = {
   *     schema: 'hbod-summary/1', created_at, date, athlete, pseudonym,
   *     probability        the engine's value in full precision (null before day 28)
   *     probability_shown  formatProbability(probability), what the application prints
   *     alert, list_status (status of the day report), p_deficit, p_strain, driver, health_action,
   *     budget: { enabled, share, cap }, engine_version, prompt_version, model, data_block, summary,
   *     check: { ok, issues, codes }   the result of checkFaithfulness
   *   }
   */
  function makeRecord(input) {
    const day = input.dayReport;
    const a = findAthlete(day, input.athlete);
    const summary = String(input.summary === null || input.summary === undefined ? '' : input.summary);
    const pseudonym = input.pseudonym === undefined || input.pseudonym === '' ? null : input.pseudonym;
    const dataBlock = input.dataBlock === undefined || input.dataBlock === null
      ? buildDataBlock(day, { athlete: a.name }) : String(input.dataBlock);
    const created = input.createdAt === undefined || input.createdAt === null || input.createdAt === ''
      ? new Date() : input.createdAt;
    return {
      schema: SCHEMA,
      created_at: created instanceof Date ? created.toISOString() : String(created),
      date: day.date,
      athlete: a.name,
      pseudonym: pseudonym,
      probability: a.probability,
      probability_shown: formatProbability(a.probability),
      alert: a.alert,
      list_status: a.status,
      p_deficit: a.pDeficit,
      p_strain: a.pStrain,
      driver: a.driver,
      health_action: a.health ? a.health.action : null,
      budget: { enabled: day.budget.enabled, share: day.budget.share, cap: day.budget.cap },
      engine_version: day.engineVersion,
      prompt_version: PROMPT_VERSION,
      model: input.model === undefined || input.model === '' ? null : input.model,
      data_block: dataBlock,
      summary: summary,
      check: checkFaithfulness(summary, a, { dayReport: day, dataBlock: dataBlock, pseudonym: pseudonym })
    };
  }

  /** toJSONL(records) -> string. One JSON object per line; numbers keep their full precision. */
  function toJSONL(records) {
    return (records || []).map(function (r) { return JSON.stringify(r) + '\n'; }).join('');
  }

  /** fromJSONL(text) -> record[]. Reads what toJSONL wrote; empty lines are skipped. */
  function fromJSONL(text) {
    const out = [];
    String(text === null || text === undefined ? '' : text).replace(/^\ufeff/, '').split(/\r?\n/)
      .forEach(function (line, k) {
        if (line.trim() === '') return;
        try {
          out.push(JSON.parse(line));
        } catch (e) {
          throw new Error('Line ' + (k + 1) + ' of the summaries is not valid JSON: ' + e.message);
        }
      });
    return out;
  }

  const CSV_COLUMNS = Object.freeze(['schema', 'created_at', 'date', 'athlete', 'pseudonym', 'probability',
    'probability_shown', 'alert', 'list_status', 'p_deficit', 'p_strain', 'driver', 'health_action',
    'budget_enabled', 'budget_share', 'budget_cap', 'engine_version', 'prompt_version', 'model', 'check_ok',
    'check_codes', 'check_issues', 'summary', 'data_block']);

  /**
   * toCSV(records) -> string
   * The records as CSV with the columns of CSV_COLUMNS, written by HBODCore.toCSV: the budget is spread over
   * three columns and the flags of the check are joined with ' | '. The probability keeps its full precision.
   * The JSONL form is the complete one; in CSV a text that starts with =, +, - or @ is prefixed with an
   * apostrophe so that a spreadsheet does not read it as a formula.
   */
  function toCSV(records) {
    const rows = (records || []).map(function (r) {
      const budget = r.budget || {}, check = r.check || {};
      const row = {};
      for (const c of CSV_COLUMNS) row[c] = r[c];
      row.budget_enabled = budget.enabled;
      row.budget_share = budget.share;
      row.budget_cap = budget.cap;
      row.check_ok = check.ok;
      row.check_codes = (check.codes || []).join(' | ');
      row.check_issues = (check.issues || []).join(' | ');
      return row;
    });
    return HBODCore.toCSV(rows, CSV_COLUMNS);
  }

  return {
    PROMPT_VERSION: PROMPT_VERSION,
    SCHEMA: SCHEMA,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    CSV_COLUMNS: CSV_COLUMNS,
    formatProbability: formatProbability,
    buildDataBlock: buildDataBlock,
    makeRecord: makeRecord,
    checkFaithfulness: checkFaithfulness,
    toJSONL: toJSONL,
    fromJSONL: fromJSONL,
    toCSV: toCSV,
    pseudonyms: pseudonyms,
    restoreNames: restoreNames
  };
});
