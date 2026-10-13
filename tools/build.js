#!/usr/bin/env node
/*
 * Builds the HBOD application as one self-contained file.
 *
 *   node tools/build.js            writes app/HBOD_App.html
 *   node tools/build.js --check    writes nothing; exits with status 1 when app/HBOD_App.html differs from a fresh build
 *
 * The template app/src/template.html names the files to inline, one marker per line:
 *   <!-- build:css app.css -->             becomes a style element holding app/src/app.css
 *   <!-- build:js engine.js -->            becomes a script element holding app/src/engine.js
 *   <!-- build:js report.js optional -->   the same, but the build goes on without the file when it is absent
 * and {{build}} becomes the build fingerprint, the first twelve hexadecimal digits of the SHA-256 of the template
 * and of the inlined files. The application shows it on its About page.
 *
 * The output is deterministic: the same sources always give the same bytes (no date, no machine name). Line ends
 * are written as LF whatever the line ends of the sources. Nothing is downloaded and no package is needed.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'src');
const OUT = path.join(ROOT, 'app', 'HBOD_App.html');
const TEMPLATE = 'template.html';
const MARKER = /^[ \t]*<!-- build:(css|js) ([A-Za-z0-9_.-]+)( optional)? -->[ \t]*$/gm;

// Text of a source file with a byte-order mark removed and line ends as LF; null when the file is absent.
function readSource(dir, file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

/**
 * escapeScript(source) -> string
 * A script as it is written inside a script element. Two character sequences would otherwise end the element or
 * change how the browser reads it: the closing script tag and the opening of an HTML comment. They only occur
 * inside strings, regular expressions and comments, where a backslash before the slash or the exclamation mark
 * leaves the meaning of the JavaScript unchanged.
 */
function escapeScript(source) {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * build(srcDir?) -> { html, fingerprint, modules }
 * Builds the application in memory from the sources in srcDir (default: app/src).
 *   html         the text of app/HBOD_App.html
 *   fingerprint  twelve hexadecimal digits identifying the sources
 *   modules      [{ file, kind: 'css' | 'js', optional, present, text }] in the order of the template; text is the
 *                source as inlined (escapeScript applied to scripts), null when an optional file is absent
 */
function build(srcDir) {
  const dir = srcDir || SRC;
  const template = readSource(dir, TEMPLATE);
  if (template === null) throw new Error(`The template ${path.join(dir, TEMPLATE)} is missing.`);
  if (!template.includes('{{build}}')) throw new Error('The template does not hold the {{build}} placeholder.');

  const modules = [];
  const hash = crypto.createHash('sha256').update(template);
  template.replace(MARKER, function (_, kind, file, optional) {
    const source = readSource(dir, file);
    if (source === null && !optional) throw new Error(`The source file ${path.join(dir, file)} is missing.`);
    if (kind === 'css' && source !== null && /<\/style/i.test(source)) {
      throw new Error(`${file} holds the text of a closing style tag, which cannot be inlined.`);
    }
    const text = source === null ? null : (kind === 'js' ? escapeScript(source) : source);
    modules.push({ file: file, kind: kind, optional: !!optional, present: source !== null, text: text });
    hash.update('\n' + kind + ' ' + file + '\n').update(text === null ? '' : text);
    return '';
  });
  if (!modules.length) throw new Error('The template names no file to inline.');
  const fingerprint = hash.digest('hex').slice(0, 12);

  let k = 0;
  const html = template.replace(MARKER, function () {
    const m = modules[k++];
    const name = 'app/src/' + m.file;
    if (!m.present) return `<script data-source="${name}" data-missing="true">/* ${name} is not part of this build. */</script>`;
    const body = m.text.endsWith('\n') ? m.text : m.text + '\n';
    return m.kind === 'css'
      ? `<style data-source="${name}">\n${body}</style>`
      : `<script data-source="${name}">\n${body}</script>`;
  }).replace('{{build}}', fingerprint);

  return { html: html, fingerprint: fingerprint, modules: modules };
}

function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter(function (a) { return a !== '--check'; });
  if (unknown.length) {
    console.error(`build: unknown argument ${unknown[0]}. Usage: node tools/build.js [--check]`);
    return 2;
  }
  const result = build();
  const bytes = Buffer.from(result.html, 'utf8');
  const shown = path.relative(ROOT, OUT).replace(/\\/g, '/');
  const missing = result.modules.filter(function (m) { return !m.present; }).map(function (m) { return m.file; });
  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
    if (current === null || !current.equals(bytes)) {
      console.error(`build: ${shown} is ${current === null ? 'missing' : 'out of date'}. Run "node tools/build.js".`);
      return 1;
    }
    console.log(`${shown} is up to date (build ${result.fingerprint}, ${bytes.length} bytes).`);
    return 0;
  }
  fs.writeFileSync(OUT, bytes);
  console.log(`${shown} written: ${bytes.length} bytes, build ${result.fingerprint}, ` +
    `${result.modules.filter(function (m) { return m.present; }).length} files inlined` +
    (missing.length ? `; not part of this build: ${missing.join(', ')}` : '') + '.');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`build: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { build: build, escapeScript: escapeScript, ROOT: ROOT, SRC: SRC, OUT: OUT };
