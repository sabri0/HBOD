// Tests of requirement 10: the application computes on the coach's device and uploads nothing. The page forbids
// every connection through its Content-Security-Policy, and no source file holds code that could open one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HBODCore = require('../app/src/core.js');

const ROOT = path.join(__dirname, '..');
const read = function (file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); };
const built = read('app/HBOD_App.html');
const sources = fs.readdirSync(path.join(ROOT, 'app', 'src')).map(function (f) { return 'app/src/' + f; });

// The demonstration data hold only a responses file and an availability log; they are scanned like the rest.
const SCANNED = ['app/HBOD_App.html'].concat(sources);

// Ways in which a page or a script can contact a server.
const CONNECTIONS = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/,
  /\bimportScripts\b/, /\bnew\s+Worker\b/, /serviceWorker/, /\bRTCPeerConnection\b/, /\.src\s*=\s*['"`]https?:/,
  /\bimport\s*\(/, /\bnew\s+Image\s*\(/, /<object|<embed|<form\b/i];

test('the page forbids every connection (Content-Security-Policy)', () => {
  const m = built.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'the policy is declared in the page');
  const policy = {};
  for (const part of m[1].split(';')) {
    const words = part.trim().split(/\s+/);
    policy[words[0]] = words.slice(1);
  }
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.deepEqual(policy['connect-src'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['script-src'], ["'unsafe-inline'"], 'scripts come from the file itself only');
  assert.deepEqual(policy['style-src'], ["'unsafe-inline'"]);
  assert.deepEqual(policy['img-src'], ['data:']);
  for (const directive of Object.keys(policy)) {
    for (const source of policy[directive]) {
      assert.doesNotMatch(source, /^https?:|^\*|^wss?:|^blob:|^filesystem:/, directive + ' allows no remote source');
    }
  }
  assert.ok(built.indexOf('Content-Security-Policy') < built.indexOf('<script'), 'the policy precedes every script');
  assert.match(built, /<meta name="referrer" content="no-referrer">/);
});

test('no source file holds code that contacts a server', () => {
  for (const file of SCANNED) {
    const text = read(file);
    for (const pattern of CONNECTIONS) {
      assert.doesNotMatch(text, pattern, file + ' must not hold ' + pattern);
    }
  }
});

test('the only frame shows the report built in the page: no address, no script', () => {
  const ui = read('app/src/ui.js');
  const frames = ui.match(/<iframe[^>]*>/g) || [];
  assert.equal(frames.length, 1, 'one frame, the daily report');
  assert.doesNotMatch(frames[0], /\bsrc\s*=/, 'the frame has no address');
  assert.match(frames[0], /sandbox="[^"]*"/);
  assert.doesNotMatch(frames[0], /allow-scripts|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(ui, /frame\.srcdoc = built\.html/, 'the frame is filled with the report built on the device');
  assert.doesNotMatch(ui, /\.src\s*=/, 'no element is given an address to load');
});

test('nothing is loaded from another address', () => {
  for (const file of SCANNED) {
    const text = read(file);
    assert.doesNotMatch(text, /<script[^>]*\bsrc\s*=/i, file + ': no external script');
    for (const link of text.match(/<link\b[^>]*>/gi) || []) {
      assert.match(link, /\bhref\s*=\s*["']data:/i, file + ': no external stylesheet, font or icon (' + link + ')');
    }
    assert.doesNotMatch(text, /url\(\s*["']?(https?:)?\/\//i, file + ': no remote address in a style');
    assert.doesNotMatch(text, /@import/i, file + ': no imported stylesheet');
    assert.doesNotMatch(text, /\bsrc\s*=\s*["'](https?:)?\/\//i, file + ': no remote image, frame or media');
  }
});

test('the only web addresses are links that the user may choose to follow', () => {
  const allowed = new Set(['https://doi.org/10.17605/OSF.IO/MUWQ3', 'https://github.com/sabri0/HBOD',
    'https://polyformproject.org/licenses/noncommercial/1.0.0']);
  for (const file of SCANNED) {
    const found = read(file).match(/https?:\/\/[^\s"'`<>)\\]+/g) || [];
    for (const address of found) {
      assert.ok(allowed.has(address.replace(/[.,;]+$/, '')), file + ' holds the address ' + address);
    }
  }
});

test('what the application keeps stays in the storage of the browser, under its own prefix', () => {
  const ui = read('app/src/ui.js');
  assert.match(ui, /STORAGE_PREFIX = 'hbod\.'/);
  assert.doesNotMatch(ui, /document\.cookie|indexedDB|sessionStorage/);
  assert.ok(built.includes(HBODCore.WORDING.privacy) || read('app/src/core.js').includes(HBODCore.WORDING.privacy));
  assert.match(built, /Computed on this device · no data uploaded/);
});

test('the report command and the engine modules use no network module', () => {
  for (const file of ['cli/hbod.js', 'app/src/engine.js', 'app/src/core.js', 'app/src/report.js', 'app/src/summary.js',
    'tools/build.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /require\(\s*['"](node:)?(https?|net|tls|dgram|dns|http2|child_process)['"]\s*\)/, file);
    assert.doesNotMatch(text, /\bfetch\s*\(/, file);
  }
});

test('the only code that can send anything is the opt-in --run mode of the summary command', () => {
  const cli = read('cli/summarize.js');
  const calls = cli.match(/\bfetch\s*\(/g) || [];
  assert.equal(calls.length, 1, 'one request function');
  assert.match(cli, /ANTHROPIC_API_KEY is not set/);
  assert.match(cli, /No model was called and nothing left this device\./);
  assert.doesNotMatch(cli, /require\(\s*['"][^.'"][^'"]*['"]\s*\)(?<!require\(\s*['"]node:[a-z_/]+['"]\s*\))(?<!require\(\s*['"](fs|path|os|crypto|url|util)['"]\s*\))/,
    'no third-party package');
});

test('the repository needs no package from the network', () => {
  const file = path.join(ROOT, 'package.json');
  if (!fs.existsSync(file)) return;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(Object.keys(pkg[field] || {}), [], field + ' is empty');
  }
  assert.equal(pkg.private, true);
});
