"""Aggregate Lane A structured results (workflow return value saved to laneA/results.json)
plus the free-text findings files into laneA/aggregate.md for the synthesis agent."""
import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()

import json, os, collections, glob
base = os.path.join(WORK, 'laneA')
res_path = os.path.join(base, 'results.json')
if len(sys.argv) > 2:  # path to the Workflow task output json; extract its result
    raw = json.load(open(sys.argv[2]))
    r = raw.get('result', raw)
    if isinstance(r, str):
        r = json.loads(r)
    json.dump(r, open(res_path, 'w'))
res = json.load(open(res_path))
import collections as _c
os.makedirs(os.path.join(base, 'by_area'), exist_ok=True)
sessions = res['sessions'] if isinstance(res, dict) else res
sample = {s['agent']: s for s in json.load(open(os.path.join(base, 'sample.json')))}
files = {os.path.basename(p)[:-3]: p for p in glob.glob(os.path.join(base, 'findings', '*.md'))}

by_area = collections.Counter(); wasted_by_area = collections.Counter(); sess_by_area = collections.defaultdict(set)
outcomes = collections.Counter(); per_stratum = collections.defaultdict(list)
rows = []
for s in sessions:
    st = sample.get(s['agent'], {}).get('stratum', '?')
    outcomes[(st, s['outcome'])] += 1
    per_stratum[st].append(s)
    for f in s['findings']:
        by_area[f['area']] += 1; wasted_by_area[f['area']] += f.get('wasted_calls', 0); sess_by_area[f['area']].add(s['agent'])
        rows.append(dict(agent=s['agent'], stratum=st, model=sample.get(s['agent'], {}).get('model'), **f))

out = []
out.append(f'# Lane A aggregate — {len(sessions)} sessions reviewed, {len(rows)} findings, {len(files)} findings files\n')
out.append('## Outcomes by stratum')
for st in sorted(per_stratum):
    c = collections.Counter(s['outcome'] for s in per_stratum[st])
    tot_calls = sum(s['steps_total'] for s in per_stratum[st]); wasted = sum(s['steps_wasted'] for s in per_stratum[st])
    out.append(f'- {st}: n={len(per_stratum[st])}, calls={tot_calls}, wasted={wasted} ({100*wasted/max(tot_calls,1):.0f}%), outcomes={dict(c)}')
out.append('\n## Findings by area (count / sessions / wasted calls)')
for a, n in by_area.most_common():
    out.append(f'- {a}: {n} findings, {len(sess_by_area[a])} sessions, {wasted_by_area[a]} wasted calls')
out.append('\n## All findings (sorted by severity × wasted calls)')
rows.sort(key=lambda r: -(r['severity'] * max(r.get('wasted_calls', 0), 1)))
for r in rows:
    out.append(f"- [{r['area']}] sev{r['severity']} waste{r.get('wasted_calls',0)} conf{r['confidence']:.1f} {r['agent']}({r['stratum']},{r['model']}) steps {r['steps']}: **{r['title']}** — wanted: {r['agent_wanted']} | got: {r['harness_gave']} | did: {r['workaround']} | fix: {r['one_step_fix']}")
out.append('\n## Misleading harness output (all sessions)')
for s in sessions:
    for m in s.get('misleading_harness_output', []):
        out.append(f'- {s["agent"]}: {m}')
out.append('\n## Snapshot vs screenshot gaps (all sessions)')
for s in sessions:
    for m in s.get('snapshot_vs_screenshot_gaps', []):
        out.append(f'- {s["agent"]}: {m}')
out.append('\n## Surprises (all sessions)')
for s in sessions:
    if s.get('surprises'):
        out.append(f'- {s["agent"]}: {s["surprises"]}')
open(os.path.join(base, 'aggregate.md'), 'w').write('\n'.join(out) + '\n')
json.dump(rows, open(os.path.join(base, 'findings.rows.json'), 'w'), indent=1)
print(f'{len(sessions)} sessions, {len(rows)} findings, aggregate.md {len("".join(out))//4} tokens approx; findings files present: {len(files)}')
missing = [s['agent'] for s in sessions if s['agent'] not in files]
if missing:
    print('sessions without findings file:', missing)

# per-area slices for the synthesis workflow
by = collections.defaultdict(list)
for r in rows:
    by[r['area']].append({k: r[k] for k in ('agent', 'stratum', 'model', 'title', 'steps', 'agent_wanted', 'harness_gave', 'workaround', 'one_step_fix', 'wasted_calls', 'severity', 'confidence')})
for a, rs in by.items():
    json.dump(rs, open(os.path.join(base, 'by_area', a + '.json'), 'w'), indent=0)
sec = []
for s in sessions:
    for m in s.get('misleading_harness_output', []):
        sec.append(('misleading', s['agent'], m))
    for m in s.get('snapshot_vs_screenshot_gaps', []):
        sec.append(('gap', s['agent'], m))
    if s.get('surprises'):
        sec.append(('surprise', s['agent'], s['surprises']))
json.dump(sec, open(os.path.join(base, 'by_area', '_misleading_gaps_surprises.json'), 'w'), indent=0)
os.makedirs(os.path.join(base, 'themes'), exist_ok=True)
print('by_area/ written for the synthesis workflow:', sorted(by))
