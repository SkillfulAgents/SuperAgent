"""Prototype: jsonl transcript -> compact trace + friction signals.

Usage: python3 compact.py <workdir> [N]   (N = number of files to process; default all)
Writes traces to ./traces/<agentId>.txt and ./sessions.jsonl with per-session metrics.
"""
import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()

import json, os, sys, re, collections, difflib
from datetime import datetime

ROOT = os.path.join(WORK, 'data')
OUT = os.path.join(WORK, 'traces')
os.makedirs(OUT, exist_ok=True)

INFRA = re.compile(r'Browser is owned by session|Daemon failed to start|Failed to connect: No such file|410 Gone|402|Browserbase context|Chrome exited early|Browser is not active|Stream closed|permission stream closed|ECONNREFUSED')
WORKAROUND = re.compile(r"let me try|instead|alternative|fall ?back|didn't work|did not work|workaround|try again|different approach|try a different|not working|stuck|still showing|no effect|nothing happened|use javascript|directly via|manually|retry|stale|truncated|cut off", re.I)
BLOCKER = re.compile(r'captcha|cloudflare|verify you are human|press & hold|press and hold|bot[- ]check|access denied|sign in|log ?in required', re.I)

def ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None

def brief_input(name, inp):
    inp = inp or {}
    if name == 'browser_open':
        return inp.get('url', '')[:120]
    if name in ('browser_click', 'browser_hover'):
        return inp.get('ref') or inp.get('selector') or json.dumps(inp)[:80]
    if name == 'browser_fill':
        return f"{inp.get('ref')} <- {str(inp.get('value',''))[:40]!r}"
    if name == 'browser_type':
        return f"{str(inp.get('text',''))[:40]!r}"
    if name == 'browser_press':
        return inp.get('key', '')
    if name == 'browser_select':
        return f"{inp.get('ref')} <- {str(inp.get('value', inp.get('values','')))[:40]!r}"
    if name == 'browser_run':
        cmd = str(inp.get('command') or ' '.join(map(str, inp.get('args') or [])))
        return re.sub(r'\s+', ' ', cmd)[:160]
    if name == 'browser_eval':
        return 'JS: ' + re.sub(r'\s+', ' ', str(inp.get('script', inp)))[:160]
    if name == 'browser_scroll':
        return json.dumps(inp)[:60]
    if name == 'browser_wait':
        return json.dumps(inp)[:80]
    return json.dumps(inp)[:100] if inp else ''

def snapshot_summary(txt):
    lines = txt.splitlines()
    roles = collections.Counter()
    refs = set()
    for l in lines:
        m = re.match(r'\s*-\s+(\w+)', l)
        if m:
            roles[m.group(1)] += 1
        for r in re.findall(r'\[ref=(e\d+)', l):
            refs.add(r)
    top = ', '.join(f'{k}:{v}' for k, v in roles.most_common(6))
    return f'{len(lines)} lines, {len(refs)} refs [{top}]', refs

def brief_result(name, txt, is_error):
    if is_error:
        return 'ERR ' + re.sub(r'\s+', ' ', txt)[:200]
    if name in ('browser_snapshot', 'browser_get_state'):
        s, refs = snapshot_summary(txt)
        url = re.search(r'\*\*Current URL:\*\*\s*(\S+)', txt)
        return (f'url={url.group(1)[:100]} ' if url else '') + s, refs
    return re.sub(r'\s+', ' ', txt)[:200], None

def process(path):
    agent_id = os.path.basename(path).replace('.jsonl', '')
    lines_out = []
    id2 = {}
    t_first = None; t_last = None; t_prev = None
    n = 0; n_err = 0; n_infra = 0; n_eval = 0; n_run = 0; n_shot = 0; n_snap = 0
    n_workaround = 0; n_blocker = 0; n_repeat = 0; n_unknown_ref = 0; n_snap_shot = 0; n_text = 0
    prev_key = None; prev_name = None; last_refs = set(); last_snapshot = None
    task = ''; final = ''; model = None; tokens_out = 0; cache_read = 0
    snap_bytes = 0
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = ts(d.get('timestamp', ''))
            if t:
                t_first = t_first or t; t_last = t
            m = d.get('message') or {}
            if d.get('type') == 'user' and isinstance(m.get('content'), str) and not task:
                task = m['content']
                lines_out.append('TASK: ' + re.sub(r'\s+', ' ', task)[:600])
            if d.get('type') == 'assistant':
                model = model or m.get('model')
                u = m.get('usage') or {}
                tokens_out += u.get('output_tokens', 0); cache_read += u.get('cache_read_input_tokens', 0)
                for c in m.get('content') or []:
                    if not isinstance(c, dict):
                        continue
                    if c.get('type') == 'text' and c['text'].strip():
                        n_text += 1
                        final = c['text']
                        flag = ''
                        if WORKAROUND.search(c['text']):
                            n_workaround += 1; flag = ' [WORKAROUND?]'
                        if BLOCKER.search(c['text']):
                            n_blocker += 1; flag += ' [BLOCKER?]'
                        lines_out.append(f'  > {re.sub(r"\s+", " ", c["text"])[:240]}{flag}')
                    elif c.get('type') == 'tool_use':
                        n += 1
                        name = c['name'].replace('mcp__browser__', '')
                        id2[c['id']] = (name, n)
                        key = (name, json.dumps(c.get('input'), sort_keys=True))
                        rep = ''
                        if key == prev_key:
                            n_repeat += 1; rep = ' [REPEAT]'
                        if name == 'browser_screenshot' and prev_name == 'browser_snapshot':
                            n_snap_shot += 1; rep += ' [SNAP->SHOT]'
                        prev_key = key; prev_name = name
                        if name == 'browser_eval' or (name == 'browser_run' and str((c.get('input') or {}).get('command', '')).startswith('eval')):
                            n_eval += 1
                        if name == 'browser_run':
                            n_run += 1
                        if name == 'browser_screenshot':
                            n_shot += 1
                        if name == 'browser_snapshot':
                            n_snap += 1
                        dt = f'+{int((t - t_prev).total_seconds())}s' if (t and t_prev) else ''
                        t_prev = t or t_prev
                        ref = (c.get('input') or {}).get('ref')
                        stale = ''
                        if ref and last_refs and ref not in last_refs:
                            stale = ' [REF-NOT-IN-LAST-SNAPSHOT]'
                        lines_out.append(f'#{n} {dt} {name}({brief_input(name, c.get("input"))}){rep}{stale}')
            elif d.get('type') == 'user' and isinstance(m.get('content'), list):
                for c in m['content']:
                    if c.get('type') != 'tool_result':
                        continue
                    name, idx = id2.get(c.get('tool_use_id'), ('?', 0))
                    cc = c.get('content')
                    imgs = 0
                    if isinstance(cc, list):
                        txt = ''.join(x.get('text', '') for x in cc if x.get('type') == 'text')
                        imgs = sum(1 for x in cc if x.get('type') == 'image')
                    else:
                        txt = str(cc or '')
                    is_err = bool(c.get('is_error'))
                    if is_err:
                        n_err += 1
                        if INFRA.search(txt):
                            n_infra += 1
                        if 'Unknown ref' in txt:
                            n_unknown_ref += 1
                    r = brief_result(name, txt, is_err)
                    refs = None
                    if isinstance(r, tuple):
                        r, refs = r
                    if refs is not None:
                        snap_bytes += len(txt)
                        diff = ''
                        if last_snapshot is not None:
                            ratio = difflib.SequenceMatcher(None, last_snapshot[:4000], txt[:4000]).quick_ratio()
                            diff = f' sim-to-prev={ratio:.2f}'
                            if ratio > 0.98:
                                diff += ' [UNCHANGED?]'
                        last_snapshot = txt; last_refs = refs
                        r += diff
                    lines_out.append(f'    <- {"[img] " if imgs else ""}{r}')
    dur = int((t_last - t_first).total_seconds()) if (t_first and t_last) else 0
    metrics = dict(agent=agent_id, file=os.path.relpath(path, ROOT), model=model, tools=n, errors=n_err, infra_errors=n_infra,
                   evals=n_eval, runs=n_run, snapshots=n_snap, screenshots=n_shot, repeats=n_repeat, unknown_ref=n_unknown_ref,
                   snap_then_shot=n_snap_shot, workaround_msgs=n_workaround, blocker_msgs=n_blocker, texts=n_text,
                   duration_s=dur, tokens_out=tokens_out, cache_read=cache_read, snapshot_bytes=snap_bytes,
                   raw_bytes=os.path.getsize(path), task=task[:200], final=final[:300])
    # friction score: harness-attributable signals, infra excluded
    soft = (n_err - n_infra) + n_repeat + n_unknown_ref + n_snap_shot + n_workaround + 0.5 * n_eval
    metrics['friction'] = round(soft / max(n, 1), 3)
    metrics['friction_abs'] = soft
    body = '\n'.join(lines_out)
    with open(os.path.join(OUT, agent_id + '.txt'), 'w') as fo:
        fo.write(f'FILE: {metrics["file"]}\nMODEL: {model}  TOOLS: {n}  ERRORS: {n_err} (infra {n_infra})  DURATION: {dur}s\n')
        fo.write(body + '\n')
    metrics['trace_bytes'] = len(body)
    return metrics

if __name__ == '__main__':
    files = [l.strip() for l in open(os.path.join(ROOT, 'files.txt'))]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else len(files)
    out = open(os.path.join(WORK, 'sessions.jsonl'), 'w')
    raw = 0; comp = 0
    for f in files[:limit]:
        mtr = process(os.path.join(ROOT, f))
        raw += mtr['raw_bytes']; comp += mtr['trace_bytes']
        out.write(json.dumps(mtr) + '\n')
    print(f'processed {limit}: raw {raw/1e6:.1f}MB -> traces {comp/1e6:.1f}MB (x{raw/max(comp,1):.0f} smaller)')
