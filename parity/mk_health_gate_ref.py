"""Reference outputs of the ingest and of the health module of the rule-based prototype.

Requirement: the daily health item, the weekly Oslo questionnaire and the health gate stay exactly as they were.
This script runs the Python core of the rule-based prototype, unchanged, and records what it returns, so that the
JavaScript core of the application can be checked against it.

The prototype is read from the git tag v0.1.0-rule-based-prototype with `git show` into a temporary folder: its
Python core and its two synthetic datasets (validation/S5_validation_dataset.csv, 5 athletes, and
data/S6_cohort_football_100.csv, 100 athletes). For every athlete and every calendar day between the first and the
last report, the prototype's load_records, health_status and apply_health_override give the pain flag, the
location, the Oslo severity, the substantial and cannot-participate flags, the overall flag and the action of the
health gate (STOP, REFER, HOLD or none), with the text and the reason line of the action.

Run from inside this folder:

  python mk_health_gate_ref.py
      writes the fixtures of tests/health-gate.test.js under ../tests/fixtures/:
        health_gate_S5.csv        the S5 dataset, byte for byte
        health_gate_S6_slice.csv  the rows of S6 from two weeks before the first pain or Oslo answer, for the
                                  athletes who gave such an answer and for two athletes who gave none
        health_gate_cases.csv     a small hand-written file (CASES below) with a French header and the corner
                                  cases of the health module
        health_gate_ref.json      the prototype's records and health outputs for these three files, and its
                                  answers on a list of unusual numbers, yes/no answers, dates, Oslo labels and
                                  headers

  node health_gate.js
  python mk_health_gate_ref.py js_health_gate.json
      compares the JavaScript core with the prototype on both whole datasets and prints how many athlete-days are
      identical (js_health_gate.json is written by health_gate.js)
"""
import csv
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import timedelta

TAG = 'v0.1.0-rule-based-prototype'
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
DATASETS = {'S5': 'validation/S5_validation_dataset.csv', 'S6': 'data/S6_cohort_football_100.csv'}
FIELDS = ['pain', 'location', 'severity', 'substantial', 'cannot', 'flagged', 'action']
RECORD_FIELDS = ['date', 'athlete', 'moment', 'duration', 'intensity', 'fatigue', 'stress', 'soreness', 'sleep',
                 'pain', 'pain_location', 'ostrc_q1', 'ostrc_q2', 'ostrc_q3', 'ostrc_q4', 'session_load']
CONTROLS = 2            # athletes without any pain or Oslo answer kept in the S6 slice
LEAD_DAYS = 14          # days kept before the first pain or Oslo answer in the S6 slice


def git(*args):
    return subprocess.run(['git', '-C', ROOT] + list(args), check=True, capture_output=True).stdout


def prototype_core(folder):
    """The Python core of the rule-based prototype: the module under core/ that holds the health module."""
    for name in git('ls-tree', '-r', '--name-only', TAG, 'core/').decode().split('\n'):
        if not name.endswith('.py'):
            continue
        source = git('show', f'{TAG}:{name}')
        if b'def health_status(' in source and b'def load_records(' in source:
            path = os.path.join(folder, 'prototype_core.py')
            with open(path, 'wb') as f:
                f.write(source)
            spec = importlib.util.spec_from_file_location('prototype_core', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise SystemExit(f'the Python core of the prototype was not found in the tag {TAG}')


def reference(core, path):
    """Records and health outputs of the prototype for one responses file."""
    recs = core.load_records(path)
    athletes = sorted({r['athlete'] for r in recs if r['athlete']})
    dated = [r['date'] for r in recs if r['date']]
    first, last = min(dated), max(dated)
    days = [first + timedelta(n) for n in range((last - first).days + 1)]
    health = {}
    for a in athletes:
        mine = [r for r in recs if r['athlete'] == a]      # health_status keeps the same records itself
        rows = []
        for d in days:
            hs = core.health_status(mine, a, d)
            # called with INCREASE so that each tier, HOLD included, returns its own text
            _, text, reasons = core.apply_health_override('INCREASE', None, [], hs)
            rows.append([hs[k] for k in FIELDS] + [text if hs['action'] else None,
                                                   reasons[0] if hs['action'] else None])
        health[a] = rows
    records = [[r['date'].isoformat() if r['date'] else None] + [r[k] for k in RECORD_FIELDS[1:]] for r in recs]
    return dict(records=records, athletes=athletes, dates=[d.isoformat() for d in days], health=health)


def s6_slice(core, path):
    """Rows of S6 kept in the fixture, as CSV text."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    cmap = core._match_col(header)
    col = {c: header.index(h) for c, h in cmap.items()}
    answered = [r for r in body if core._yesno(r[col['pain']]) is True
                or any(r[col[f'ostrc_q{i}']].strip() for i in (1, 2, 3, 4))]
    with_answer = sorted({r[col['athlete']] for r in answered})
    others = sorted({r[col['athlete']] for r in body} - set(with_answer))[:CONTROLS]
    start = min(core._parse_date(r[col['timestamp']]) for r in answered) - timedelta(LEAD_DAYS)
    keep = [r for r in body if r[col['athlete']] in set(with_answer + others)
            and core._parse_date(r[col['timestamp']]) >= start]
    out = io.StringIO()
    csv.writer(out, lineterminator='\n').writerows([header] + keep)
    return out.getvalue(), with_answer, others, start.isoformat()


# Corner cases of the health module, as a responses file with a French header. The comments name what each
# athlete's rows exercise; the expected outputs are whatever the prototype returns for them.
CASES_HEADER = ['Horodateur', "Nom d'utilisateur", 'Qui es-tu ?', 'Moment de la s\u00e9ance', 'Dur\u00e9e (min)',
                'Intensit\u00e9 ressentie (CR-10)', 'Fatigue', 'Stress', 'Courbatures', 'Sommeil',
                'Douleur ou g\u00eane ?', 'Localisation', 'OSTRC_Q1', 'OSTRC_Q2', 'OSTRC_Q3', 'OSTRC_Q4']


def _case(stamp, name, pain='', where='', q=('', '', '', ''), minutes='60', rpe='5', moment='Soir'):
    return ([stamp, name.lower() + '@club.example', name, moment, minutes, rpe, '2', '3', '2', '2', pain, where]
            + list(q))


CASES = [
    # Amira: a minor problem stays flagged for seven days after the questionnaire and not on the eighth
    _case('01/03/2026 20:00:00', 'Amira', 'Non'),
    _case('02/03/2026 20:00:00', 'Amira', 'Oui', 'Genou, droit', ('8', '0', '0', '8'), minutes='7,5', rpe='6 - Dur'),
    _case('03/03/2026 20:00:00', 'Amira', 'Non'),
    _case('09/03/2026 20:00:00', 'Amira', 'Non'),
    _case('10/03/2026 20:00:00', 'Amira', 'Non'),
    # Bilal: halves in the severity are rounded to the even neighbour (0.5 gives 0 and no flag)
    _case('2026-03-01 20:00:00', 'Bilal', 'No', '', ('0,5', '0', '0', '0')),
    _case('2026-03-02 20:00:00', 'Bilal', 'No', '', ('8,5', '0', '0', '0')),
    _case('2026-03-03 20:00:00', 'Bilal', 'No', '', ('9.5', '0', '0', '0')),
    _case('2026-03-04 20:00:00', 'Bilal', 'No', '', ('16.5', '0', '0', '0')),
    _case('2026-03-05 20:00:00', 'Bilal', 'No', '', ('17.5', '0', '0', '0')),
    _case('2026-03-06 20:00:00', 'Bilal', 'No', '', ('2.5', '0', '0', '0')),
    _case('2026-03-07 20:00:00', 'Bilal', 'No', '', ('0', '0', '0', '0')),
    # Chloe: severe symptoms alone are not a substantial problem; a major cut in volume means cannot train
    _case('3/1/2026 8:00:00 PM', 'Chlo\u00e9', 'Yes', 'Back',
          ('Full participation without health problems', 'No reduction', 'No effect', 'Severe')),
    _case('3/5/2026 8:00:00 PM', 'Chlo\u00e9', 'Yes', 'Back',
          ('Full participation but with health problems', 'To a major extent', 'No effect', 'Mild')),
    _case('3/9/2026 8:00:00 PM', 'Chlo\u00e9', 'No', 'Back',
          ('Reduced participation due to health problems', 'To a minor extent', 'To a moderate extent', 'Moderate')),
    # Driss: pain without a location, a location without pain, and several records on one day
    _case('2026/03/01 20:00:00', 'Driss', 'Oui'),
    _case('2026/03/02 20:00:00', 'Driss', 'Non', 'Cheville'),
    _case('2026/03/03 08:00:00', 'Driss', 'Oui', '', moment='Matin'),
    _case('2026/03/03 20:00:00', 'Driss', 'Oui', 'Cheville'),
    _case('2026/03/03 21:00:00', 'Driss', 'Oui', 'Mollet'),
    _case('2026/03/04 20:00:00', 'Driss', '\u0646\u0639\u0645', '\u0627\u0644\u0631\u0643\u0628\u0629'),
    _case('2026/03/05 20:00:00', 'Driss', '\u0644\u0627'),
    _case('2026/03/06 20:00:00', 'Driss', 'peut-\u00eatre'),
    # Emma: two questionnaires on one day (the last one counts) and rows that are not in date order
    _case('2026-03-08', 'Emma', 'No', '',
          ('Could not participate', 'To a major extent', 'To a major extent', 'Severe')),
    _case('2026-03-02', 'Emma', 'No', '',
          ('Full participation but with health problems', 'No reduction', 'No effect', 'Mild'), moment='Matin'),
    _case('2026-03-02', 'Emma', 'No', '',
          ('Reduced participation', 'To a moderate extent', 'To a minor extent', 'Moderate')),
    _case('2026-03-05', 'Emma', 'No', '',
          ('Full participation without health problems', 'No reduction', 'No effect', 'No symptoms')),
    _case('2026-03-12', 'Emma', 'No'),
    # Farid: labels that are not recognised, numbers next to labels, and a questionnaire with a single answer
    _case('2026-03-01 20:00:00', 'Farid', 'No', '', ('Somewhat', 'A little', '', '')),
    _case('2026-03-03 20:00:00', 'Farid', 'No', '', ('', '', '', '0')),
    _case('2026-03-05 20:00:00', 'Farid', 'No', '', ('17 - Reduced participation', 'Not sure', '8', 'MILD')),
    _case('2026-03-07 20:00:00', 'Farid', 'No', '', ('25.0', '', '', '')),
    # rows that carry no usable date or no name, an empty row and a short row
    _case('hier soir', 'Amira', 'Oui', 'Dos', ('25', '25', '25', '25')),
    _case('2026-03-04 20:00:00', '', 'Oui', 'Dos', ('25', '25', '25', '25')),
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['2026-03-06 20:00:00', 'g@club.example', 'Gina', 'Soir', '45', '4'],
    _case('2026-03-11 20:00:00', 'Gina', 'Yes', 'Hip', minutes='', rpe=''),
]

# Unusual inputs of the ingest functions; the prototype's answers are stored next to them.
TO_FLOAT = ['85', ' 7 ', '7,5', '5 - Beaucoup', '-3', '--3', '-', '.', '.5', '5.', '-.5', '1.2.3', '1,234.5', 'abc',
            'abc 12 x', 'RPE 6/10', '', '   ', '1 200', '+5', '5-3', '- 5', '0', '-0', '00.50', '1e3', '0x10',
            '\u0665', '\u0663\u066b\u0665', '\u0663.\u0665', '5\u00b2', '\u00b2', '\uff11\uff12', '\u00a07\u00a0',
            '\x1f8\x1f', '\ufeff9', '7\u200b', '3\u2009000', 'six', '10/10', '4.', '4..', 'n/a', '99999999999999999999']
YES_NO = ['Yes', 'No', 'Oui', 'Non', 'oui, au genou', '\u0646\u0639\u0645', '\u0644\u0627', 'Y', 'N', '1', '0', 'maybe',
          '', '  ', 'Aucune', 'None', 'Not sure, yes', 'Occasionally', 'Pas de douleur', 'Ja', 'NON', 'YES!', 'Knee',
          'Unknown', ' yes', 'true', 'false', 'x', '2', '\u00a0No\u00a0', 'Si', 'ok', 'Oui / Yes', 'nope', '10',
          '\x1fy', '\ufeffY', '\x1c1', '\x85n', '\u200bn']
DATES = ['2026-03-04 08:00:00 PM UTC+1', '2026-03-27 08:00:00', '2026/03/27 8:00:00 PM', '3/27/2026 8:00:00 PM',
         '27/03/2026 08:00:00 PM', '03/04/2026 20:00:00', '03/04/2026 8:00:00 PM', '2026-03-27', '2026/03/27',
         '27/03/2026', '03/27/2026', '13/02/2025', '02/13/2025', '31/02/2025', '29/02/2024', '29/02/2025',
         '2025-07-01T20:00:00Z', '2025-07-01T20:00:00.000+01:00', '2026-03-04 20:00:00 GMT',
         '2026-03-04 20:00:00 GMT+0100', '2026-03-04 UTC', '4/3/2026', '4/3/26', '2026-3-4', '2026-03-04 7:05:09',
         '2026-03-04 24:00:00', '2026-03-04 10:10:60', '2026-03-04 12:00:00 AM', '2026-03-04  20:00:00',
         ' 2026-03-04 ', '', '   ', 'not a date', '0000-01-01', '0001-01-01', '9999-12-31',
         '2026-03-04 08:00:00 pm', '2026-03-04 08:00:00 P.M.', '\u0662\u0660\u0662\u0666-03-04', '2026-03-1\u0665',
         '04.03.2026', '2026-03-04 UTC+1 20:00:00', 'Wed 2026-03-04', '2026-03-04\t20:00:00',
         '2026-03-04\u00a020:00:00', '1/2/2026 3:04:05', '12/31/2026 11:59:59 PM', '2026/1/5', '2026-03- 4',
         '20260304', '2026-13-01', '2026-00-10', '2026-04-31', '12/12/2026 13:00:00 PM', '2026-03-04 00:00:00',
         '2026-03-04 20:00', '1900-02-29', '2000-02-29', '2026/03/04 12:30:15 am', '31/12/2026 23:59:59',
         '2026-03-04 08:00:00 PM UTC', '2026-03-04 08:00:00 PM GMT-5', '2026-03-04 8:00:00 PM  UTC+01',
         '\x1f2026-03-04\x1f', '\ufeff2026-03-04', '2026-03-04\x1c20:00:00', '2026-03-04\ufeff20:00:00']
OSTRC = ['0', '8', '17', '25', '17.0', 'Reduced participation', '  reduced   PARTICIPATION ', 'Could not participate',
         'Cannot participate', 'To a moderate extent', 'No symptoms', 'Mild', 'MODERATE', 'Severe',
         'Full participation without health problems', 'Full participation but with health problems',
         'Reduced participation due to health problems', 'No reduction', 'No effect', 'To a minor extent',
         'To a major extent', 'unknown label', '', '  ', '17 - Reduced participation', 'Reduced participation (17)',
         'N/A', '-', 'mild\u00a0', 'To\ta\nmajor extent', 'Severe.', '8,5']
HEADERS = [
    ['Horodateur', "Nom d'utilisateur", 'Qui es-tu ?', 'Moment de la s\u00e9ance', 'Dur\u00e9e de la s\u00e9ance (min)',
     'Intensit\u00e9 ressentie (CR-10)', 'Fatigue', 'Stress', 'Courbatures', 'Sommeil',
     'Douleur ou g\u00eane sp\u00e9cifique ?', 'Localisation', 'OSTRC Q1 Participation', 'OSTRC Q2 Volume',
     'OSTRC Q3', 'OSTRC Q4 Sympt\u00f4mes'],
    ['Timestamp', 'Email Address', 'Name', 'Timing', 'Minutes', 'RPE', 'Fatigue level', 'Stress level',
     'Muscle soreness', 'Sleep quality', 'Any pain?', 'Pain location', 'Participation', 'Volume',
     'Performance OSTRC', 'Symptoms'],
    ['Player', 'Duration', 'Intensity'],
    ['  PLAYER  ', 'Player', 'DURATION (MIN)', 'duration', 'Intensity', 'Sleep', 'Sleep'],
    ['Nageur', 'Duree', 'Intensite', 'Zone de douleur', 'Douleur', 'Moment'],
    ['Athlete ID', 'Athlete', 'Session duration (min)', 'Intensity (CR-10)', 'Health problem today?', 'Location'],
    ['Date', 'Who', 'Time', 'Effort'],
    [],
]


def vectors(core):
    def columns(header):
        return {c: header.index(h) for c, h in core._match_col(header).items()}

    def day(x):
        d = core._parse_date(x)
        return d.isoformat() if d else None

    return dict(to_float=[[x, core._to_float(x)] for x in TO_FLOAT],
                yes_no=[[x, core._yesno(x)] for x in YES_NO],
                parse_date=[[x, day(x)] for x in DATES],
                ostrc_score=[[x, core._ostrc_score(x)] for x in OSTRC],
                match_columns=[[h, columns(h)] for h in HEADERS])


def by_action(counts):
    return ', '.join(f"{k or 'none'} {counts[k]}" for k in (None, 'HOLD', 'REFER', 'STOP') if k in counts)


def compact(ref):
    """Health outputs with each distinct output written once: per athlete, one index per day."""
    states, index = [], {}
    health = {}
    for a, rows in ref['health'].items():
        codes = []
        for row in rows:
            key = json.dumps(row)
            if key not in index:
                index[key] = len(states)
                states.append(row)
            codes.append(index[key])
        health[a] = codes
    return dict(records=ref['records'], athletes=ref['athletes'], dates=ref['dates'], states=states, health=health)


def write_fixtures(core, folder, paths):
    os.makedirs(FIXTURES, exist_ok=True)
    with open(paths['S5'], 'rb') as f:
        s5 = f.read()
    with open(os.path.join(FIXTURES, 'health_gate_S5.csv'), 'wb') as f:
        f.write(s5)
    text, with_answer, others, start = s6_slice(core, paths['S6'])
    slice_path = os.path.join(FIXTURES, 'health_gate_S6_slice.csv')
    with open(slice_path, 'w', newline='', encoding='utf-8') as f:
        f.write(text)
    cases_path = os.path.join(FIXTURES, 'health_gate_cases.csv')
    with open(cases_path, 'w', newline='', encoding='utf-8') as f:
        csv.writer(f, lineterminator='\n').writerows([CASES_HEADER] + CASES)
    ref = dict(
        source=f'rule-based prototype, git tag {TAG}; written by parity/mk_health_gate_ref.py',
        python=sys.version.split()[0],
        record_fields=RECORD_FIELDS,
        health_fields=FIELDS + ['text', 'reason'],
        datasets=dict(
            S5=dict(file='health_gate_S5.csv', origin=DATASETS['S5'], **compact(reference(core, paths['S5']))),
            S6_slice=dict(file='health_gate_S6_slice.csv', origin=DATASETS['S6'], from_date=start,
                          athletes_with_answers=with_answer, athletes_without=others,
                          **compact(reference(core, slice_path))),
            cases=dict(file='health_gate_cases.csv', origin='CASES in parity/mk_health_gate_ref.py',
                       **compact(reference(core, cases_path)))),
        vectors=vectors(core))
    ref_path = os.path.join(FIXTURES, 'health_gate_ref.json')
    with open(ref_path, 'w', newline='\n') as f:
        json.dump(ref, f, separators=(',', ':'))
        f.write('\n')
    total = 0
    for name in ('health_gate_S5.csv', 'health_gate_S6_slice.csv', 'health_gate_cases.csv', 'health_gate_ref.json'):
        size = os.path.getsize(os.path.join(FIXTURES, name))
        total += size
        print(f'{name}: {size} bytes')
    for key, d in ref['datasets'].items():
        actions = {}
        for a, codes in d['health'].items():
            for c in codes:
                act = d['states'][c][6]
                actions[act] = actions.get(act, 0) + 1
        print(f"{key}: {len(d['records'])} records, {len(d['athletes'])} athletes, {len(d['dates'])} days; "
              f"athlete-days by action: {by_action(actions)}")
    print(f'{total} bytes in total')


def compare(core, paths, js_path):
    with open(js_path, encoding='utf-8') as f:
        js = json.load(f)
    days_total = days_same = records_total = records_same = text_same = 0
    for key in ('S5', 'S6'):
        ref, other = reference(core, paths[key]), js['datasets'][key]
        assert ref['athletes'] == other['athletes'], f'{key}: the two sides do not list the same athletes'
        assert ref['dates'] == other['dates'], f'{key}: the two sides do not cover the same days'
        same_rec = sum(1 for a, b in zip(ref['records'], other['records']) if a == b)
        n_rec = max(len(ref['records']), len(other['records']))
        n = same = same_text = 0
        by_field = [0] * len(FIELDS)
        for a in ref['athletes']:
            for mine, theirs in zip(ref['health'][a], other['health'][a]):
                n += 1
                same += mine[:len(FIELDS)] == theirs[:len(FIELDS)]
                same_text += mine[len(FIELDS):] == theirs[len(FIELDS):]
                for k in range(len(FIELDS)):
                    by_field[k] += mine[k] == theirs[k]
        actions = {}
        for a in ref['athletes']:
            for row in ref['health'][a]:
                actions[row[6]] = actions.get(row[6], 0) + 1
        print(f"{key} ({DATASETS[key]}): {same_rec} of {n_rec} records read identically; "
              f"{len(ref['athletes'])} athletes x {len(ref['dates'])} days = {n} athlete-days, "
              f"{same} with identical health outputs")
        print('   identical by field: ' + ', '.join(f'{f} {c}' for f, c in zip(FIELDS, by_field))
              + f'; text and reason of the action {same_text}')
        print(f'   athlete-days by action in the prototype: {by_action(actions)}')
        days_total += n; days_same += same; text_same += same_text
        records_total += n_rec; records_same += same_rec
    print()
    print(f"JavaScript core on Node.js {js['node']} against the rule-based prototype ({TAG}) on Python "
          f"{sys.version.split()[0]}")
    print(f'records read identically: {records_same} of {records_total}')
    print(f'athlete-days compared: {days_total}; identical ({", ".join(FIELDS)}): {days_same} '
          f'({100 * days_same / days_total:.4f}%); identical text and reason of the action: {text_same}')
    return days_same == days_total and records_same == records_total and text_same == days_total


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as tmp:
        module = prototype_core(tmp)
        files = {}
        for label, origin in DATASETS.items():
            files[label] = os.path.join(tmp, os.path.basename(origin))
            with open(files[label], 'wb') as out:
                out.write(git('show', f'{TAG}:{origin}'))
        if len(sys.argv) > 1:
            sys.exit(0 if compare(module, files, sys.argv[1]) else 1)
        write_fixtures(module, tmp, files)
