"""Lane A prep: pick 200 post-audit sessions in three strata, render each as
review-ready markdown parts + extracted screenshots, and bin-pack into agent batches.

Outputs under ./laneA/:
  sample.json                 selected sessions with stratum + token estimate
  batches.json                list of batches: [{id, sessions:[{agent, dir, parts, shots, est_tokens}]}]
  rendered/<agent>/session.partNN.md, rendered/<agent>/shots/NNN.png
"""
import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()

import json, os, random, base64, csv, collections, re
from datetime import datetime

base = WORK
root = os.path.join(base, 'data')
out = os.path.join(base, 'laneA')
os.makedirs(out, exist_ok=True)
random.seed(20260910)

sess = [json.loads(l) for l in open(os.path.join(base, 'sessions.jsonl'))]
per = {os.path.basename(r['f']).replace('.jsonl', ''): r for r in json.load(open(os.path.join(base, 'per_file.json')))}
manifest = {}
with open(os.path.join(root, 'MANIFEST.csv')) as fh:
    for row in csv.DictReader(fh):
        manifest[os.path.basename(row['dest_key']).replace('.jsonl', '')] = row

# ---- 1. sample --------------------------------------------------------------
pool = []
for r in sess:
    p = per.get(r['agent'])
    if not p or not p['t0'] or p['t0'] < '2026-06-15' or r['tools'] < 8:
        continue
    if r['infra_errors'] > 0.5 * max(r['errors'], 1) and r['infra_errors'] >= 3:
        continue  # infra-dominated
    r['t0'] = p['t0']
    pool.append(r)
pool.sort(key=lambda r: r['agent'])
median_fr = sorted(r['friction'] for r in pool)[len(pool) // 2]
N = 200
top = sorted(pool, key=lambda r: -r['friction_abs'])[:67]
chosen = {r['agent']: 'high_friction' for r in top}
long_quiet = [r for r in pool if r['agent'] not in chosen and r['tools'] >= 40 and r['friction'] < median_fr]
random.shuffle(long_quiet)
for r in long_quiet[:66]:
    chosen[r['agent']] = 'long_low_friction'
rest = [r for r in pool if r['agent'] not in chosen]
random.shuffle(rest)
for r in rest[:N - len(chosen)]:
    chosen[r['agent']] = 'random'
sample = [dict(r, stratum=chosen[r['agent']]) for r in pool if r['agent'] in chosen]
print('pool', len(pool), 'sample', len(sample), collections.Counter(s['stratum'] for s in sample))

# ---- 2. render --------------------------------------------------------------
MAX_LINES = 1200      # per part; Read tool default window is 2000 lines
WRAP = 1900           # Read truncates lines >2000 chars

def ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None

def wrap(text):
    outl = []
    for line in text.split('\n'):
        while len(line) > WRAP:
            outl.append(line[:WRAP] + ' ⏎'); line = line[WRAP:]
        outl.append(line)
    return '\n'.join(outl)

def render(r):
    agent = r['agent']
    d = os.path.join(out, 'rendered', agent)
    shots = os.path.join(d, 'shots')
    os.makedirs(shots, exist_ok=True)
    m = manifest.get(agent, {})
    lines = []
    lines.append(f'# Session {agent}')
    lines.append(f'Host: {m.get("host","?")}   Agent slug: {m.get("agent","?")}   Session: {m.get("session_id","?")}')
    lines.append(f'Task label (from parent): {m.get("description","?")}')
    lines.append(f'Model: {r["model"]}   Started: {r["t0"]}   Tool calls: {r["tools"]}   Hard errors: {r["errors"]} (infra {r["infra_errors"]})   Duration: {r["duration_s"]}s')
    lines.append(f'Stratum: {r["stratum"]}')
    lines.append('')
    lines.append('Format: `## turn k` = one assistant message (+Δt since previous message). `### call n: <tool>` = tool invocation with its input. `### result n` = what the harness returned (ERROR marks is_error). `[screenshot: shots/NNN.png]` marks where an image was returned; open it with Read.')
    lines.append('')
    id2n = {}; n = 0; k = 0; prev_t = None; shot_i = 0; text_tok = 0
    with open(os.path.join(root, r['file'])) as fh:
        for line in fh:
            try:
                dd = json.loads(line)
            except Exception:
                continue
            t = ts(dd.get('timestamp', ''))
            dt = f' +{int((t - prev_t).total_seconds())}s' if (t and prev_t) else ''
            prev_t = t or prev_t
            msg = dd.get('message') or {}
            if dd.get('type') == 'user' and isinstance(msg.get('content'), str):
                lines.append('## user task'); lines.append(wrap(msg['content'])); lines.append('')
                text_tok += len(msg['content']) // 4
            elif dd.get('type') == 'assistant':
                k += 1
                lines.append(f'## turn {k}{dt}')
                for c in msg.get('content') or []:
                    if not isinstance(c, dict):
                        continue
                    if c.get('type') == 'text' and c['text'].strip():
                        lines.append(wrap(c['text'])); lines.append(''); text_tok += len(c['text']) // 4
                    elif c.get('type') == 'tool_use':
                        n += 1; id2n[c['id']] = n
                        nm = c['name'].replace('mcp__browser__', '')
                        inp = json.dumps(c.get('input'), ensure_ascii=False)
                        lines.append(f'### call {n}: {nm}'); lines.append(wrap(inp)); lines.append(''); text_tok += len(inp) // 4
            elif dd.get('type') == 'user' and isinstance(msg.get('content'), list):
                for c in msg['content']:
                    if c.get('type') != 'tool_result':
                        continue
                    nn = id2n.get(c.get('tool_use_id'), '?')
                    err = ' ERROR' if c.get('is_error') else ''
                    lines.append(f'### result {nn}{err}{dt}')
                    cc = c.get('content')
                    if isinstance(cc, list):
                        for x in cc:
                            if x.get('type') == 'text':
                                lines.append(wrap(x['text'])); text_tok += len(x['text']) // 4
                            elif x.get('type') == 'image':
                                src = x.get('source') or {}
                                data = src.get('data', ''); mt = src.get('media_type', 'image/png')
                                ext = 'jpg' if 'jpeg' in mt else 'png'
                                shot_i += 1
                                fn = f'{shot_i:03d}.{ext}'
                                with open(os.path.join(shots, fn), 'wb') as fo:
                                    fo.write(base64.b64decode(data))
                                lines.append(f'[screenshot: shots/{fn}]')
                    else:
                        s = str(cc or ''); lines.append(wrap(s)); text_tok += len(s) // 4
                    lines.append('')
    # split into parts
    parts = []
    for i in range(0, len(lines), MAX_LINES):
        pn = len(parts) + 1
        fn = f'session.part{pn:02d}.md'
        with open(os.path.join(d, fn), 'w') as fo:
            if pn > 1:
                fo.write(f'<!-- {agent} part {pn} (continued) -->\n')
            fo.write('\n'.join(lines[i:i + MAX_LINES]) + '\n')
        parts.append(fn)
    return dict(agent=agent, dir=d, parts=parts, shots=shot_i, est_tokens=text_tok + shot_i * 1500, stratum=r['stratum'], task=r['task'][:120])

rendered = [render(r) for r in sample]
json.dump(sample, open(os.path.join(out, 'sample.json'), 'w'), indent=1)
tot = sum(x['est_tokens'] for x in rendered)
print(f'rendered {len(rendered)} sessions, est {tot/1e6:.1f}M tokens, {sum(x["shots"] for x in rendered)} screenshots')

# ---- 3. bin-pack into batches ----------------------------------------------
BUDGET = 140_000; MAX_PER = 6
rendered.sort(key=lambda x: -x['est_tokens'])
batches = []
for x in rendered:
    placed = False
    for b in batches:
        if len(b['sessions']) < MAX_PER and b['tokens'] + x['est_tokens'] <= BUDGET:
            b['sessions'].append(x); b['tokens'] += x['est_tokens']; placed = True; break
    if not placed:
        batches.append(dict(id=len(batches) + 1, sessions=[x], tokens=x['est_tokens']))
for b in batches:
    b['id'] = batches.index(b) + 1
json.dump(batches, open(os.path.join(out, 'batches.json'), 'w'), indent=1)
repo = os.environ.get('MINING_REPO', os.getcwd())
json.dump({'base': out, 'repo': repo, 'batches': [[b['id'], [s['agent'] for s in b['sessions']]] for b in batches]}, open(os.path.join(out, 'review-args.json'), 'w'))
json.dump({'base': out, 'repo': repo, 'areas': ['snapshot_content', 'action_result', 'error_message', 'tool_surface', 'prompt_guidance', 'wait_timing', 'engine', 'tabs', 'other', 'auth_or_blocker'], 'knownDetectors': 'stale_ref, poll_by_snapshot, snapshot_insufficient, escape_hatch, eval_for_interaction, eval_for_extraction, click_no_effect, covered_by, wait_timeout, dialog_probe, custom_widget, upload_failed, tab_churn, misleading_return_hint, large_output, blocked_external'}, open(os.path.join(out, 'synthesis-args.json'), 'w'))
print('workflow args written to', os.path.join(out, 'review-args.json'), 'and synthesis-args.json')
sizes = sorted(b['tokens'] for b in batches)
print(f'{len(batches)} batches; tokens min/p50/max {sizes[0]}/{sizes[len(sizes)//2]}/{sizes[-1]}; sessions per batch', collections.Counter(len(b['sessions']) for b in batches))
