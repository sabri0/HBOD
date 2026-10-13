#!/usr/bin/env node
/*
 * HBOD language summaries on the command line.
 *
 *   node cli/summarize.js --day day.json [--athlete NAME] [--out summaries.jsonl]
 *                         [--emit | --from-file text.json | --run]
 *
 * Reads the data of one day written by "node cli/hbod.js --json day.json" and works in one of three modes.
 *   --emit       (default) prints the constrained prompt and the data block. No model is called and no network
 *                request is made.
 *   --from-file  stores summaries that were written elsewhere.
 *   --run        optional and only on explicit request: sends the constrained prompt and the computed result of
 *                the selected athletes to a language model through the Anthropic Messages API, one request per
 *                athlete. Names are replaced by codes before sending and restored afterwards. The raw responses
 *                file is never sent.
 * Every stored line is a record of HBODSummary.makeRecord, so the probability computed by HBOD sits next to each
 * generated summary. The language model only restates the computed result; the probability printed here always
 * comes from HBOD and never from the text of the model.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HBODCore = require(path.join(__dirname, '..', 'app', 'src', 'core.js'));
const HBODSummary = require(path.join(__dirname, '..', 'app', 'src', 'summary.js'));

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'];
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 16000;                 // ceiling of one answer, reasoning of the model included
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;
// Models for which the Messages API can re-run a declined request on a substitute model.
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const USAGE = `HBOD language summaries. The language model only restates the computed result.

Usage:
  node cli/summarize.js --day day.json [--athlete NAME] [--out summaries.jsonl] [mode]

Options:
  --day FILE         data of the day written by "node cli/hbod.js --json FILE" (required)
  --athlete NAME     restrict to one athlete; may be given several times (default: every athlete of the day)
  --out FILE         summaries file (JSON lines); records are appended. Required with --from-file and --run

Modes (one of):
  --emit             print the constrained prompt and the data block; no model call, no network (default)
  --from-file FILE   store summaries written elsewhere. FILE is JSON: { "name or code": "summary", ... } or
                     [ { "athlete": "name or code", "summary": "...", "model": "..." }, ... ]
  --run              explicit opt-in: send the constrained prompt and the computed result of the selected athletes
                     to the Anthropic Messages API, one request per athlete. Needs ANTHROPIC_API_KEY. Names are
                     replaced by codes before sending and restored afterwards; text typed by athletes or staff
                     and the raw responses file are not sent.

More options:
  --codes            with --emit: write codes in place of names, for a block that will be pasted elsewhere
  --model ID         model of --run (default ${DEFAULT_MODEL}); with --from-file, the model that wrote the text
  --effort LEVEL     with --run: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT}; "default" leaves it to the model)
  --no-fallback      with --run: do not let the API re-run a declined request on a substitute model
  --created-at TIME  timestamp written in the records (default: now)
  --help

${HBODCore.WORDING.probability}
${HBODCore.WORDING.support}`;

class UsageError extends Error {}

const VALUE_OPTIONS = ['day', 'athlete', 'out', 'from-file', 'model', 'effort', 'created-at'];
const FLAG_OPTIONS = ['emit', 'run', 'codes', 'no-fallback', 'help'];

function parseArguments(argv) {
  const options = { athlete: [] };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (FLAG_OPTIONS.includes(name)) { options[name] = true; continue; }
    if (!VALUE_OPTIONS.includes(name)) throw new UsageError(`Unknown option: --${name}`);
    const value = eq < 0 ? argv[++k] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`The option --${name} needs a value.`);
    if (name === 'athlete') options.athlete.push(value);
    else options[name] = value;
  }
  return options;
}

function readJSON(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`The ${what} ${file} could not be read: ${e.message}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`The ${what} ${file} is not valid JSON: ${e.message}`);
  }
}

function readDay(file) {
  const day = readJSON(file, 'day file');
  const usable = day && typeof day === 'object' && typeof day.date === 'string' && Array.isArray(day.athletes) &&
    day.budget && day.counts && day.athletes.every((a) => a && typeof a.name === 'string' && a.planning && a.health);
  if (!usable) {
    throw new Error(`The file ${file} does not hold the data of a day. Write it with ` +
      '"node cli/hbod.js --input responses.csv --json day.json".');
  }
  return day;
}

// Names of the selected athletes in the display order of the day (health gate first).
function selectAthletes(day, wanted) {
  const names = day.athletes.map((a) => a.name);
  for (const name of wanted) {
    if (!names.includes(name)) throw new Error(`Unknown athlete for ${day.date}: ${name}`);
  }
  return wanted.length ? names.filter((n) => wanted.includes(n)) : names;
}

function appendRecord(file, record) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.appendFileSync(file, (existing === '' || existing.endsWith('\n') ? '' : '\n') + HBODSummary.toJSONL([record]));
}

// What is printed for one stored summary. The probability is the one computed by HBOD.
function printRecord(record) {
  console.log(record.summary);
  console.log(`  Probability shown by HBOD: ${record.probability_shown} | automatic check: ` +
    (record.check.ok ? 'no flag' : `${record.check.issues.length} flag(s)`));
  for (const issue of record.check.issues) console.log(`    - ${issue}`);
}

// ------------------------------------------------------------------ --emit
function emit(day, names, o) {
  const codes = o.codes ? HBODSummary.pseudonyms(day.athletes.map((a) => a.name)) : null;
  console.log(`===== CONSTRAINED PROMPT (${HBODSummary.PROMPT_VERSION}) =====\n`);
  console.log(HBODSummary.SYSTEM_PROMPT);
  console.log('\n===== DATA BLOCK (computed by HBOD) =====\n');
  process.stdout.write(HBODSummary.buildDataBlock(day, { athlete: names, pseudonyms: codes }));
  if (codes) {
    console.error('\nCodes of the athletes (keep this table on this device):');
    for (const name of names) console.error(`  ${codes[name]} = ${name}`);
  }
  console.error('\nNo model was called and nothing left this device.');
  if (o.out) console.error('Nothing is stored in --emit mode; use --from-file to store the summaries.');
}

// ------------------------------------------------------------------ --from-file
function readSummaries(file) {
  const data = readJSON(file, 'summaries file');
  const body = data && !Array.isArray(data) && data.summaries !== undefined ? data.summaries : data;
  const model = data && !Array.isArray(data) && typeof data.model === 'string' ? data.model : null;
  let entries;
  if (Array.isArray(body)) {
    entries = body.map((e) => ({ athlete: e && e.athlete, summary: e && e.summary, model: (e && e.model) || model }));
  } else if (body && typeof body === 'object') {
    entries = Object.keys(body).filter((k) => !(body === data && k === 'model'))
      .map((k) => ({ athlete: k, summary: body[k], model: model }));
  } else entries = null;
  if (!entries || !entries.every((e) => typeof e.athlete === 'string' && typeof e.summary === 'string')) {
    throw new Error(`The summaries file ${file} must hold { "name or code": "summary" } or a list of ` +
      '{ "athlete", "summary" }.');
  }
  return entries;
}

function storeFromFile(day, names, o) {
  const codes = HBODSummary.pseudonyms(day.athletes.map((a) => a.name));
  const byCode = new Map(Object.keys(codes).map((name) => [codes[name], name]));
  let stored = 0;
  for (const entry of readSummaries(o['from-file'])) {
    const key = entry.athlete.trim();
    const coded = !Object.prototype.hasOwnProperty.call(codes, key) && byCode.has(key);
    const name = coded ? byCode.get(key) : key;
    if (!Object.prototype.hasOwnProperty.call(codes, name)) throw new Error(`Unknown athlete for ${day.date}: ${key}`);
    if (!names.includes(name)) continue;                          // left out by --athlete
    const record = HBODSummary.makeRecord({
      dayReport: day,
      athlete: name,
      summary: HBODSummary.restoreNames(entry.summary, codes).trim(),
      model: entry.model || o.model || null,
      createdAt: o['created-at'],
      pseudonym: coded ? codes[name] : null,
      dataBlock: coded ? HBODSummary.buildDataBlock(day, { athlete: name, pseudonyms: codes }) : undefined,
    });
    appendRecord(o.out, record);
    printRecord(record);
    stored += 1;
  }
  console.error(`${stored} summary record(s) appended to ${o.out}. No model was called and nothing left this device.`);
}

// ------------------------------------------------------------------ --run
class ApiError extends Error {
  constructor(message, fatal) {
    super(message);
    this.fatal = fatal;             // true: the same error would stop every other request too
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(response, attempt) {
  const after = response ? Number(response.headers.get('retry-after')) : NaN;
  return Number.isFinite(after) && after >= 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt;
}

// What to tell the user for a refused request, by HTTP status.
function explain(status, detail, o) {
  const tail = detail ? ` (${detail})` : '';
  if (status === 401) return `The API key was not accepted${tail}. Check ANTHROPIC_API_KEY.`;
  if (status === 403) return `This API key is not allowed to make the request${tail}.`;
  if (status === 404) return `The model ${o.model} was not found or is not available to this key${tail}. ` +
    'Choose another with --model.';
  if (status === 413) return `The request is too large${tail}.`;
  if (status === 400 && /anthropic-beta|fallback/i.test(detail)) {
    return `The request was not accepted${tail}. Try again with --no-fallback.`;
  }
  if (status === 400 && /effort|output_config/i.test(detail)) {
    return `The request was not accepted${tail}. Try again with --effort default.`;
  }
  return `The request was not accepted (HTTP ${status})${tail}.`;
}

// One request to the Messages API, with the retries that the official clients make (rate limit, overload,
// server error, network failure). Returns the parsed message.
async function postMessage(endpoint, key, body, o) {
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
  if (body.fallbacks !== undefined) headers['anthropic-beta'] = FALLBACK_BETA;
  for (let attempt = 0; ; attempt++) {
    let response = null, failure;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      failure = `The request did not reach ${new URL(endpoint).host}: ${(e.cause && e.cause.message) || e.message}`;
    }
    if (response && response.ok) {
      try {
        return await response.json();
      } catch (e) {
        throw new ApiError(`The answer of the API could not be read: ${e.message}`, true);
      }
    }
    if (response) {
      let detail = '';
      try {
        const parsed = JSON.parse(await response.text());
        detail = parsed && parsed.error && parsed.error.message ? String(parsed.error.message) : '';
      } catch (e) { /* an error page without JSON: the status alone is reported */ }
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 ||
        response.status >= 500;
      if (!retryable) throw new ApiError(explain(response.status, detail, o), true);
      failure = `The API is busy or unavailable (HTTP ${response.status})${detail ? ` (${detail})` : ''}.`;
    }
    if (attempt >= MAX_RETRIES) throw new ApiError(`${failure} Stopped after ${attempt + 1} attempts.`, true);
    await sleep(retryDelay(response, attempt));
  }
}

// The text of an answer. A declined or truncated answer is an error and is not stored.
function answerText(message) {
  if (!message || !Array.isArray(message.content)) throw new ApiError('The answer of the API holds no content.', false);
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details && message.stop_details.category;
    throw new ApiError(`The model declined the request${category ? ` (category: ${category})` : ''}.`, false);
  }
  if (message.stop_reason === 'max_tokens') throw new ApiError('The answer was cut off before its end.', false);
  const text = message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  if (text === '') throw new ApiError('The answer of the model holds no text.', false);
  return text;
}

async function run(day, names, o) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set. The --run mode sends data to the Anthropic Messages API and ' +
      'needs a key. Nothing was sent. Without --run, the prompt and the data block are printed for use elsewhere.');
  }
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const endpoint = `${base}/v1/messages`;
  const fallback = !o['no-fallback'] && FALLBACK_MODELS.includes(o.model);
  const codes = HBODSummary.pseudonyms(day.athletes.map((a) => a.name));

  console.log(`Leaving this device for ${new URL(endpoint).host}: the constrained prompt and the computed result ` +
    `of ${day.date} for ${names.length} selected athlete(s) (probability, status, health gate, loads and notes), ` +
    'with every name replaced by a code. The raw responses file and the text typed by athletes or staff are not sent.');
  if (fallback) {
    console.log(`If ${o.model} declines a request, the API re-runs it on a substitute model chosen by Anthropic; ` +
      'each record stores the model that wrote the summary. Use --no-fallback to switch this off.');
  }

  let stored = 0, failed = 0;
  for (const name of names) {
    const block = HBODSummary.buildDataBlock(day, { athlete: name, pseudonyms: codes });
    const body = { model: o.model, max_tokens: MAX_TOKENS, system: HBODSummary.SYSTEM_PROMPT,
      messages: [{ role: 'user', content: block }] };
    if (o.effort !== 'default') body.output_config = { effort: o.effort };
    if (fallback) body.fallbacks = 'default';
    try {
      const message = await postMessage(endpoint, key, body, o);
      const record = HBODSummary.makeRecord({
        dayReport: day,
        athlete: name,
        summary: HBODSummary.restoreNames(answerText(message), codes),
        model: typeof message.model === 'string' && message.model ? message.model : o.model,
        createdAt: o['created-at'],
        pseudonym: codes[name],
        dataBlock: block,
      });
      appendRecord(o.out, record);
      printRecord(record);
      if (record.model !== o.model) console.log(`  Written by ${record.model}, not by ${o.model}.`);
      stored += 1;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      failed += 1;
      console.error(`summarize: ${name}: ${e.message} No summary was stored for this athlete.`);
      if (e.fatal) {
        const left = names.length - stored - failed;
        if (left > 0) console.error(`summarize: stopped; ${left} athlete(s) were not sent.`);
        break;
      }
    }
  }
  console.error(`${stored} summary record(s) appended to ${o.out}.`);
  return failed ? 1 : 0;
}

// ------------------------------------------------------------------ main
async function main(argv) {
  const o = parseArguments(argv);
  if (o.help) { console.log(USAGE); return 0; }
  const modes = ['emit', 'from-file', 'run'].filter((m) => o[m] !== undefined);
  if (modes.length > 1) throw new UsageError(`Give one mode only, not ${modes.map((m) => '--' + m).join(' and ')}.`);
  const mode = modes[0] || 'emit';
  if (!o.day) throw new UsageError('The option --day is required.');
  if (mode !== 'emit' && !o.out) throw new UsageError(`The option --out is required with --${mode}.`);
  if (o.codes && mode !== 'emit') throw new UsageError('The option --codes belongs to --emit.');
  if (o.effort !== undefined && !EFFORTS.includes(o.effort)) {
    throw new UsageError(`The option --effort takes one of: ${EFFORTS.join(', ')}.`);
  }

  const day = readDay(o.day);
  const names = selectAthletes(day, o.athlete);
  if (mode === 'emit') { emit(day, names, o); return 0; }
  if (mode === 'from-file') { storeFromFile(day, names, o); return 0; }
  return run(day, names, Object.assign({}, o, { model: o.model || DEFAULT_MODEL, effort: o.effort || DEFAULT_EFFORT }));
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(`summarize: ${e.message}`);
  if (e instanceof UsageError) console.error('Run "node cli/summarize.js --help" for the options.');
  process.exitCode = 1;
});
