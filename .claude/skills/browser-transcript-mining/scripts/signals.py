import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()
import json, os, collections, re, random
root = os.path.join(WORK, 'data')
files = [l.strip() for l in open(os.path.join(root, 'files.txt'))]
random.seed(1)
err_by_tool = collections.defaultdict(collections.Counter)
phrases = collections.Counter()
PHR = ['let me try', 'instead', 'alternative', 'fall back', 'fallback', "didn't work", 'did not work', 'workaround', 'try again', 'different approach', 'try a different', 'seems to be', 'appears the', 'not working', 'stuck', 'still showing', 'no effect', 'nothing happened', 'try clicking', 'try using javascript', 'use javascript', 'directly via', 'manually', 'retry', 'the snapshot', 'the screenshot', 'not in the snapshot', 'ref', 'stale', 'too long', 'truncated', 'cut off', 'timed out', 'timeout', 'cloudflare', 'captcha', 'verify you are human', 'login', 'log in', 'sign in', 'popup', 'modal', 'overlay', 'cookie', 'iframe', 'shadow', 'dropdown', 'select', 'date picker', 'calendar', 'infinite scroll', 'lazy', 'hover', 'drag', 'file upload', 'download', 'new tab', 'tab ']
bigram = collections.Counter()
repeat_same = collections.Counter()
run_examples = collections.defaultdict(list)
eval_examples = []
state_samples = []
final_texts = []
click_then = collections.Counter()
snap_then_shot = 0
tool_per_min = []
for f in files:
    p = os.path.join(root, f)
    prev = None; prev_key = None; last_text = ''; seq = []
    with open(p) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get('message') or {}
            if d.get('type') == 'assistant':
                for c in m.get('content') or []:
                    if not isinstance(c, dict):
                        continue
                    if c.get('type') == 'text':
                        t = c['text']; last_text = t; low = t.lower()
                        for ph in PHR:
                            if ph in low:
                                phrases[ph] += 1
                    elif c.get('type') == 'tool_use':
                        nm = c['name'].replace('mcp__browser__', '')
                        key = (nm, json.dumps(c.get('input'), sort_keys=True))
                        if prev:
                            bigram[(prev, nm)] += 1
                        if key == prev_key:
                            repeat_same[nm] += 1
                        prev = nm; prev_key = key; seq.append(nm)
                        if nm == 'browser_run':
                            cmd = str((c.get('input') or {}).get('command', ''))
                            fw = cmd.split()[0] if cmd.split() else ''
                            if len(run_examples[fw]) < 4:
                                run_examples[fw].append(cmd[:200])
                        if nm == 'browser_eval' and len(eval_examples) < 300:
                            eval_examples.append(str((c.get('input') or {}).get('expression', c.get('input')))[:160])
            elif d.get('type') == 'user' and isinstance(m.get('content'), list):
                for c in m['content']:
                    if c.get('type') == 'tool_result' and c.get('is_error'):
                        cc = c.get('content')
                        txt = ''.join(x.get('text', '') for x in cc if x.get('type') == 'text') if isinstance(cc, list) else str(cc or '')
                        txt = re.sub(r'session [0-9a-f-]{36}', 'session <id>', txt)
                        txt = re.sub(r'e\d+', 'eN', txt)
                        txt = re.sub(r'wss?://\S+', 'ws://<x>', txt)
                        err_by_tool[prev or '?'][txt[:110]] += 1
                    if c.get('type') == 'tool_result' and prev == 'browser_get_state' and len(state_samples) < 3 and not c.get('is_error'):
                        cc = c.get('content')
                        txt = ''.join(x.get('text', '') for x in cc if x.get('type') == 'text') if isinstance(cc, list) else str(cc or '')
                        state_samples.append(txt[:1200])
    final_texts.append((f, last_text[:300]))
    for i in range(len(seq) - 1):
        if seq[i] == 'browser_snapshot' and seq[i + 1] == 'browser_screenshot':
            snap_then_shot += 1

print('== phrases in assistant text'); [print(f'{v:6} {k}') for k, v in phrases.most_common()]
print('\n== consecutive identical tool calls (same input)'); [print(f'{v:6} {k}') for k, v in repeat_same.most_common(15)]
print('\n== snapshot immediately followed by screenshot:', snap_then_shot)
print('\n== top bigrams'); [print(f'{v:6} {a} -> {b}') for (a, b), v in bigram.most_common(40)]
print('\n== errors by tool (top 6 each)')
for t, ctr in sorted(err_by_tool.items(), key=lambda kv: -sum(kv[1].values())):
    print(f'-- {t} total={sum(ctr.values())}')
    for k, v in ctr.most_common(8):
        print(f'   {v:5} {k!r}')
print('\n== browser_run examples by subcommand')
for k, v in run_examples.items():
    print(f'-- {k!r}')
    for e in v:
        print('   ', e.replace('\n', ' ')[:200])
print('\n== browser_eval sample expressions')
for e in random.sample(eval_examples, 25):
    print('   ', e.replace('\n', ' '))
print('\n== get_state samples')
for s in state_samples:
    print('----'); print(s)
print('\n== final assistant text: outcome keyword counts')
oc = collections.Counter()
for f, t in final_texts:
    low = t.lower()
    for k in ('unable', 'could not', "couldn't", 'blocked', 'requires login', 'captcha', 'failed', 'success', 'completed', 'done', 'not possible', 'gave up', 'browser is owned', 'not active', 'need you to', 'please'):
        if k in low:
            oc[k] += 1
[print(f'{v:6} {k}') for k, v in oc.most_common()]
print('\n== 12 random final texts')
for f, t in random.sample(final_texts, 12):
    print('--', f); print('  ', t.replace('\n', ' ')[:300])
