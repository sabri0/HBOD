// The demonstration squad (simulated data) analysed by the core. Shared by the tests of the report, of the
// language-model layer and of the screens, so that they run on a realistic day report and not on hand-written objects.
'use strict';
const HBODCore = require('../app/src/core.js');
const demo = require('../app/src/demo-data.js');

const records = HBODCore.toRecords(HBODCore.parseCSV(demo.csv));

function analyse(options) {
  return HBODCore.analyse(records, Object.assign({ availability: demo.availability }, options || {}));
}

const analysis = analyse();
const day = HBODCore.dayReport(analysis);

function athlete(name, of) {
  const found = (of || day).athletes.find(function (a) { return a.name === name; });
  if (!found) throw new RangeError('No athlete named ' + name + ' in the demonstration squad.');
  return found;
}

module.exports = { demo: demo, records: records, analyse: analyse, analysis: analysis, day: day, athlete: athlete };
