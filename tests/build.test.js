// Tests of the build (tools/build.js) and of the built application (app/HBOD_App.html): the committed file is
// exactly what the sources give, and the application starts and analyses the demonstration squad.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../tools/build.js');
const HBODCore = require('../app/src/core.js');
const HBODEngine = require('../app/src/engine.js');
const squad = require('./demo-squad.js');

const built = fs.readFileSync(builder.OUT, 'utf8');
const fresh = builder.build();

test('the committed application is exactly what the sources build', () => {
  assert.equal(built.length, fresh.html.length, 'run "node tools/build.js" after changing a source file');
  assert.ok(built === fresh.html, 'app/HBOD_App.html differs from a fresh build: run "node tools/build.js"');
  assert.ok(!built.includes('\r'), 'line ends are LF');
  assert.ok(built.includes('<meta name="hbod-build" content="' + fresh.fingerprint + '">'));
});

test('the build is deterministic', () => {
  const again = builder.build();
  assert.equal(again.html, fresh.html);
  assert.equal(again.fingerprint, fresh.fingerprint);
  assert.match(fresh.fingerprint, /^[0-9a-f]{12}$/);
});

test('every source module is inside the single file, and none is missing', () => {
  const names = fresh.modules.map(function (m) { return m.file; });
  assert.deepEqual(names, ['app.css', 'engine.js', 'core.js', 'report.js', 'summary.js', 'demo-data.js', 'ui.js']);
  for (const m of fresh.modules) {
    assert.ok(m.present, m.file + ' is part of the build');
    const source = fs.readFileSync(path.join(builder.SRC, m.file), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const inlined = m.kind === 'js' ? builder.escapeScript(source) : source;
    assert.ok(built.includes(inlined), m.file + ' is inlined unchanged');
  }
  assert.doesNotMatch(built, /data-missing="true"/);
  assert.doesNotMatch(built, /<!-- build:/);
});

test('inlined scripts cannot close their own element', () => {
  assert.equal(builder.escapeScript('a = "</script>"; b = "<!-- x";'), 'a = "<\\/script>"; b = "<\\!-- x";');
  const scripts = built.split(/<script[^>]*>/).slice(1).map(function (part) { return part.split('</script>')[0]; });
  assert.equal(scripts.length, 1 + fresh.modules.filter(function (m) { return m.kind === 'js'; }).length);
  for (const body of scripts) assert.doesNotThrow(function () { new vm.Script(body); });
});

test('the engine inside the built application is the engine verified against File S1', () => {
  const source = fs.readFileSync(path.join(builder.SRC, 'engine.js'), 'utf8').replace(/\r\n?/g, '\n');
  assert.ok(built.includes(builder.escapeScript(source)));
  assert.equal(HBODEngine.VERSION, '1.0.0');
});

// A document that accepts everything and does nothing, enough for the scripts of the page to run outside a browser.
function fakeBrowser() {
  const noop = function () {};
  const element = function () {
    const e = {
      style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
      setAttribute: noop, removeAttribute: noop, getAttribute: function () { return null; },
      addEventListener: noop, removeEventListener: noop, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; },
      removeChild: noop, remove: noop, focus: noop, click: noop, scrollIntoView: noop, closest: function () { return null; },
      querySelector: function () { return element(); }, querySelectorAll: function () { return []; },
      getBoundingClientRect: function () { return { left: 0, top: 0, width: 1000, height: 600 }; },
      innerHTML: '', textContent: '', value: '', hidden: false, files: []
    };
    return e;
  };
  const store = new Map();
  const window = {
    document: {
      readyState: 'complete', body: element(), documentElement: element(), title: '',
      getElementById: function () { return element(); }, querySelector: function () { return element(); },
      querySelectorAll: function () { return []; }, createElement: element, createTextNode: element,
      addEventListener: noop, removeEventListener: noop
    },
    location: { hash: '#demo', href: 'file:///HBOD_App.html#demo', search: '' },
    history: { replaceState: noop, pushState: noop },
    localStorage: {
      getItem: function (k) { return store.has(k) ? store.get(k) : null; },
      setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); },
      key: function (i) { return Array.from(store.keys())[i] || null; }, get length() { return store.size; }
    },
    navigator: { clipboard: null, userAgent: 'test' },
    addEventListener: noop, removeEventListener: noop, setTimeout: setTimeout, clearTimeout: clearTimeout,
    requestAnimationFrame: function (f) { return setTimeout(f, 0); }, matchMedia: function () { return { matches: false, addEventListener: noop }; },
    URL: { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: noop }, Blob: function () {},
    console: console
  };
  window.window = window; window.self = window; window.globalThis = window;
  return window;
}

test('the scripts of the built page start and analyse the demonstration squad', () => {
  const window = fakeBrowser();
  const errors = [];
  window.hbodShowError = function (m) { errors.push(String(m)); };
  const context = vm.createContext(window);
  const scripts = built.split(/<script[^>]*>/).slice(1).map(function (part) { return part.split('</script>')[0]; });
  for (const body of scripts.slice(1)) vm.runInContext(body, context);       // the first script is the start-up guard
  assert.deepEqual(errors, []);
  for (const name of ['HBODEngine', 'HBODCore', 'HBODReport', 'HBODSummary', 'HBOD_DEMO', 'HBODApp']) {
    assert.ok(window[name], name + ' is defined by the page');
  }
  const app = window.HBODApp;
  for (const f of ['loadCSVText', 'loadDemo', 'setDate', 'setTab', 'selectAthlete']) assert.equal(typeof app[f], 'function');
  if (!app.state.analysis) app.loadDemo();
  assert.deepEqual(errors, []);
  const analysis = app.state.analysis;
  assert.ok(analysis, 'the demonstration squad is analysed');
  assert.equal(analysis.athletes.length, 25);
  assert.equal(analysis.endDate, squad.analysis.endDate);
  // the page computes the same day as the modules loaded by Node
  const here = window.HBODCore.dayReport(analysis);
  assert.equal(here.budget.cap, squad.day.budget.cap);
  assert.deepEqual(Array.from(here.budget.listed), squad.day.budget.listed);
  const p = function (d) { return d.athletes.map(function (a) { return a.probability; }); };
  assert.deepEqual(Array.from(p(here)), p(squad.day));
});

test('the pure helpers of the screens', () => {
  const ui = require('../app/src/ui.js');
  assert.deepEqual(ui.TABS, ['squad', 'athlete', 'report', 'availability', 'summary', 'audit', 'settings', 'about']);
  const h = ui.parseHash('#demo&tab=athlete&athlete=Athlete%2007&date=2026-05-01');
  assert.equal(h.demo, true);
  assert.equal(h.tab, 'athlete');
  assert.equal(h.athlete, 'Athlete 07');
  assert.equal(h.date, '2026-05-01');
  assert.deepEqual(ui.parseHash('#tab=nonsense'), { demo: false, tab: null, athlete: null, date: null });
  assert.equal(ui.formatProbability(0.8731), '0.87');
  assert.equal(ui.esc('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  assert.equal(typeof HBODCore.formatLoad(475), 'string');
});
