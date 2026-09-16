import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()
import json, sys, os, collections, re
root = os.path.join(WORK, 'data')
import glob
files_txt = os.path.join(root, 'files.txt')
if not os.path.exists(files_txt):
    with open(files_txt, 'w') as fo:
        for p in sorted(glob.glob('*/*/*/*.jsonl', root_dir=root)):
            fo.write(p + '\n')
files = [l.strip() for l in open(files_txt)]
tool_ct = collections.Counter(); err_ct = collections.Counter(); err_msgs = collections.Counter()
models = collections.Counter(); versions = collections.Counter()
per = []
res_len = collections.defaultdict(list)
img_ct = 0; eval_ct = 0; run_cmds = collections.Counter()
soft = collections.Counter()
for f in files:
    p = os.path.join(root, f)
    n_tool = 0; n_err = 0; n_turn = 0; toks_in = 0; toks_out = 0; cache_r = 0; cache_c = 0; ts = []
    names = collections.Counter(); id2name = {}
    with open(p) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get('message') or {}
            if 'timestamp' in d:
                ts.append(d['timestamp'])
            if d.get('type') == 'assistant':
                n_turn += 1
                models[m.get('model')] += 1; versions[d.get('version')] += 1
                u = m.get('usage') or {}
                toks_in += u.get('input_tokens', 0); toks_out += u.get('output_tokens', 0)
                cache_r += u.get('cache_read_input_tokens', 0); cache_c += u.get('cache_creation_input_tokens', 0)
                for c in m.get('content') or []:
                    if isinstance(c, dict) and c.get('type') == 'tool_use':
                        nm = c['name']; tool_ct[nm] += 1; names[nm] += 1; n_tool += 1; id2name[c['id']] = nm
                        if nm.endswith('browser_run'):
                            cmd = str((c.get('input') or {}).get('command', ''))
                            fw = cmd.split()[0] if cmd.split() else ''
                            run_cmds[fw] += 1
                            if fw == 'eval':
                                eval_ct += 1
            elif d.get('type') == 'user' and isinstance(m.get('content'), list):
                for c in m['content']:
                    if c.get('type') == 'tool_result':
                        nm = id2name.get(c.get('tool_use_id'), '?')
                        cc = c.get('content')
                        if isinstance(cc, list):
                            txt = ''.join(x.get('text', '') for x in cc if x.get('type') == 'text')
                            img_ct += sum(1 for x in cc if x.get('type') == 'image')
                        else:
                            txt = str(cc or '')
                        res_len[nm].append(len(txt))
                        if c.get('is_error'):
                            n_err += 1; err_ct[nm] += 1; err_msgs[txt[:120]] += 1
                        else:
                            low = txt[:300].lower()
                            for k in ('error', 'not found', 'timeout', 'timed out', 'failed', 'no element', 'not visible', 'not attached', 'detached', 'intercept', 'strict mode', 'unable'):
                                if k in low:
                                    soft[(nm, k)] += 1
                                    break
    per.append(dict(f=f, turns=n_turn, tools=n_tool, errs=n_err, tin=toks_in, tout=toks_out, cr=cache_r, cc=cache_c,
                    bytes=os.path.getsize(p), names=dict(names), t0=min(ts) if ts else None, t1=max(ts) if ts else None))
json.dump(per, open(os.path.join(WORK, 'per_file.json'), 'w'))

def q(v):
    v = sorted(v)
    return [v[0], v[len(v) // 2], v[int(len(v) * .9)], v[-1]] if v else [0, 0, 0, 0]

print('files', len(per))
print('turns min/p50/p90/max', q([x['turns'] for x in per]))
print('tools min/p50/p90/max', q([x['tools'] for x in per]))
print('errs min/p50/p90/max', q([x['errs'] for x in per]))
print('total tool calls', sum(tool_ct.values()), 'total errs', sum(err_ct.values()))
print('total tokens: in', sum(x['tin'] for x in per), 'out', sum(x['tout'] for x in per), 'cache_read', sum(x['cr'] for x in per), 'cache_create', sum(x['cc'] for x in per))
print('images', img_ct, 'eval', eval_ct)
print('\n== models'); [print(f'{v:6} {k}') for k, v in models.most_common()]
print('\n== versions'); [print(f'{v:6} {k}') for k, v in versions.most_common(8)]
print('\n== tools')
for k, v in tool_ct.most_common():
    r = q(res_len[k])
    print(f'{v:6} {k}  err={err_ct[k]}  res_len p50/p90/max={r[1]}/{r[2]}/{r[3]}')
print('\n== browser_run first word'); [print(f'{v:6} {k}') for k, v in run_cmds.most_common(30)]
print('\n== is_error messages top 50'); [print(f'{v:5} {k!r}') for k, v in err_msgs.most_common(50)]
print('\n== soft-error keyword hits in non-error results'); [print(f'{v:5} {k}') for k, v in soft.most_common(40)]
