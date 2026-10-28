import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()
import json, os, re, collections
base = WORK
sess = {r['agent']: r for r in (json.loads(l) for l in open(os.path.join(base, 'sessions.jsonl')))}
per = {os.path.basename(r['f']).replace('.jsonl', ''): r for r in json.load(open(os.path.join(base, 'per_file.json')))}
PATS = {
    'unknown_ref': r'Unknown ref',
    'wait_timeout': r'Wait timed out',
    'eval_syntax': r"SyntaxError: Unexpected (token|identifier) '?(return|const|let)",
    'dialog_probe': r"Selector '(alert)?dialog' did not match|No accessibility node found for selector '\[role=\"dialog\"\]'",
    'covered_by': r'is covered by',
    'mouse_click_unknown': r'Unknown subcommand: click',
    'select_no_commit': r'select reported success',
    'upload_change': r'File input (did not emit|has no files)',
    'describeNode': r'DOM.describeNode',
    'owned_by_session': r'Browser is owned by session',
    'not_active': r'Browser is not active',
    'return_hint_on_value': r'^\s+<- "[^"]+" \(note: ran in a fresh function scope',
}
era = collections.defaultdict(lambda: collections.Counter())
sessions_hit = collections.defaultdict(lambda: collections.defaultdict(set))
for agent, r in sess.items():
    t0 = (per.get(agent) or {}).get('t0') or ''
    e = 'pre-0612' if t0 < '2026-06-15' else ('jun-jul' if t0 < '2026-08-01' else 'aug-sep')
    era['_sessions'][e] += 1
    p = os.path.join(base, 'traces', agent + '.txt')
    if not os.path.exists(p):
        continue
    for line in open(p):
        for k, pat in PATS.items():
            if re.search(pat, line):
                era[k][e] += 1; sessions_hit[k][e].add(agent)
print(f"{'pattern':22} {'pre-0612':>14} {'jun-jul':>14} {'aug-sep':>14}   (events / sessions)")
for k in ['_sessions'] + list(PATS):
    row = era[k]
    cells = []
    for e in ('pre-0612', 'jun-jul', 'aug-sep'):
        if k == '_sessions':
            cells.append(f'{row[e]:>14}')
        else:
            cells.append(f'{row[e]:>6} / {len(sessions_hit[k][e]):<5}')
    print(f'{k:22} ' + ' '.join(cells))
# the owned-by-session mega retry: what did the message say?
print()
for agent, r in sess.items():
    if r['infra_errors'] > 200:
        print('MEGA-RETRY', agent, r['tools'], r['infra_errors'], r['model'], r['task'][:80])
        p = os.path.join(base, 'traces', agent + '.txt')
        n = 0
        for line in open(p):
            if 'owned by session' in line and n < 1:
                print('   ', line.strip()[:300]); n += 1
