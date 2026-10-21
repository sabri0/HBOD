#!/usr/bin/env node
/*
 * HBOD on the command line: the same core and the same report as the application.
 *
 *   node cli/hbod.js --input responses.csv [--availability availability.json] [--date YYYY-MM-DD]
 *                    [--budget 0.10 | --no-budget] [--out report.html] [--text report.txt]
 *                    [--audit audit.csv] [--json day.json]
 *
 * Reads the form responses of one squad, runs the HBOD engine over every calendar day and prints the daily report
 * of the chosen day. Everything runs on this computer: no network request is made and nothing is uploaded.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HBODCore = require(path.join(__dirname, '..', 'app', 'src', 'core.js'));
const HBODEngine = require(path.join(__dirname, '..', 'app', 'src', 'engine.js'));

const USAGE = `HBOD daily report from a responses file. Everything is computed on this computer.

Usage:
  node cli/hbod.js --input responses.csv [options]

Options:
  --input FILE          responses CSV exported from the form (required)
  --availability FILE   JSON list of periods { "athlete", "from", "to", "reason" } during which an athlete is
                        injured, ill or in return to play ("to" may be null for a period that is still open)
  --date YYYY-MM-DD     day of the report (default: the last day of the data)
  --budget SHARE        alert rate: share of healthy athlete-days on the daily list (default 0.10)
  --no-budget           list every healthy athlete at or above the alert threshold
  --out FILE            write the report as HTML
  --text FILE           write the report as plain text
  --audit FILE          append one line per athlete to an audit log (CSV)
  --json FILE           write the data of the day as JSON (input of cli/summarize.js)
  --generated-at TIME   timestamp written in the report and in the audit log (default: now)
  --help, --version

${HBODCore.WORDING.probability}
${HBODCore.WORDING.support}`;

class UsageError extends Error {}

const VALUE_OPTIONS = ['input', 'availability', 'date', 'budget', 'out', 'text', 'audit', 'json', 'generated-at'];
const FLAG_OPTIONS = ['no-budget', 'help', 'version'];

function parseArguments(argv) {
  const options = {};
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (FLAG_OPTIONS.includes(name)) { options[name] = true; continue; }
    if (!VALUE_OPTIONS.includes(name)) throw new UsageError(`Unknown option: --${name}`);
    const value = eq < 0 ? argv[++k] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`The option --${name} needs a value.`);
    options[name] = value;
  }
  return options;
}

function readAvailability(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
  } catch (e) {
    throw new Error(`The availability file ${file} could not be read as JSON: ${e.message}`);
  }
  const list = Array.isArray(data) ? data : data && (data.availability || data.periods || data.log);
  if (!Array.isArray(list)) {
    throw new Error(`The availability file ${file} must hold a list of periods { athlete, from, to, reason }.`);
  }
  return list;
}

// The report module is written separately from the core; it is loaded only when a report is needed.
function loadReportModule() {
  const file = path.join(__dirname, '..', 'app', 'src', 'report.js');
  if (!fs.existsSync(file)) {
    throw new Error('The report module app/src/report.js is missing, so the daily report cannot be built. ' +
      'The options --json and --audit work without it.');
  }
  return require(file);
}

function appendAudit(file, rows) {
  const csv = HBODCore.toCSV(rows, HBODCore.AUDIT_COLUMNS);
  const header = csv.slice(0, csv.indexOf('\r\n'));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.trim() === '') { fs.writeFileSync(file, csv); return; }
  if (existing.replace(/^\ufeff/, '').split(/\r?\n/)[0] !== header) {
    throw new Error(`The audit file ${file} has other columns than this version of HBOD writes. Choose another file.`);
  }
  fs.appendFileSync(file, (/\n$/.test(existing) ? '' : '\r\n') + csv.slice(header.length + 2));
}

function main(argv) {
  const o = parseArguments(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (o.version) { console.log(`HBOD engine ${HBODEngine.VERSION}`); return 0; }
  if (!o.input) throw new UsageError('The option --input is required.');
  if (o.budget !== undefined && o['no-budget']) throw new UsageError('Give either --budget or --no-budget, not both.');
  let share;
  if (o.budget !== undefined) {
    share = Number(o.budget);
    if (!(share > 0 && share <= 1)) {
      throw new UsageError('The alert rate must be a share above 0 and at most 1, for example 0.10.');
    }
  }

  let bytes;
  try {
    bytes = fs.readFileSync(o.input);
  } catch (e) {
    throw new Error(`The responses file ${o.input} could not be read: ${e.message}`);
  }
  const records = HBODCore.toRecords(HBODCore.parseCSV(HBODCore.decodeText(bytes)));
  const analysis = HBODCore.analyse(records, {
    availability: o.availability ? readAvailability(o.availability) : [],
    budget: { enabled: !o['no-budget'], share: share },
  });
  const day = HBODCore.dayReport(analysis, o.date);
  const generatedAt = o['generated-at'] || new Date().toISOString();

  const left = analysis.skipped;
  if (left.undated + left.unnamed > 0) {
    console.error(`Note: ${left.undated} row(s) without a readable date and ${left.unnamed} row(s) without a name ` +
      'were left out.');
  }

  if (o.json) fs.writeFileSync(o.json, JSON.stringify(day, null, 1) + '\n');
  if (o.audit) appendAudit(o.audit, HBODCore.auditRows(day, generatedAt));

  let HBODReport;
  try {
    HBODReport = loadReportModule();
  } catch (e) {
    // the data of the day and the audit log do not need the report module
    console.error(`hbod: ${e.message}`);
    if (o.json) console.error(`The data of ${day.date} were written to ${o.json}.`);
    if (o.audit) console.error(`${day.athletes.length} line(s) were appended to ${o.audit}.`);
    return (o.json || o.audit) && !o.out && !o.text ? 0 : 1;
  }
  const periodic = typeof HBODReport.buildPeriodic === 'function'
    ? HBODReport.buildPeriodic(analysis, day.date) : undefined;
  const report = HBODReport.buildDailyReport(day, { generatedAt: generatedAt, periodic: periodic });
  if (o.out) fs.writeFileSync(o.out, report.html);
  if (o.text) fs.writeFileSync(o.text, report.text.endsWith('\n') ? report.text : report.text + '\n');
  console.log(report.text);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`hbod: ${e.message}`);
  if (e instanceof UsageError) console.error('Run "node cli/hbod.js --help" for the options.');
  process.exitCode = 1;
}
