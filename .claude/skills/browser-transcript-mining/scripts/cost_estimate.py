import os, sys
WORK = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()
import json, os, collections
base = WORK
root = os.path.join(base, 'data')
files = [l.strip() for l in open(os.path.join(root, 'files.txt'))]
rows = []
for f in files:
    last_ctx = 0; text_bytes = 0; img_bytes = 0; imgs = 0; t0 = None; n = 0
    with open(os.path.join(root, f)) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t0 = t0 or d.get('timestamp')
            m = d.get('message') or {}
            if d.get('type') == 'assistant':
                u = m.get('usage') or {}
                last_ctx = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
                n += 1
            c = m.get('content')
            if isinstance(c, str):
                text_bytes += len(c)
            elif isinstance(c, list):
                for b in c:
                    if b.get('type') == 'text':
                        text_bytes += len(b.get('text', ''))
                    elif b.get('type') == 'tool_use':
                        text_bytes += len(json.dumps(b.get('input')))
                    elif b.get('type') == 'tool_result':
                        cc = b.get('content')
                        if isinstance(cc, list):
                            for x in cc:
                                if x.get('type') == 'text':
                                    text_bytes += len(x.get('text', ''))
                                elif x.get('type') == 'image':
                                    imgs += 1; img_bytes += len((x.get('source') or {}).get('data', ''))
                        else:
                            text_bytes += len(str(cc or ''))
    rows.append(dict(f=f, t0=t0 or '', ctx=last_ctx, text_tok=text_bytes // 4, imgs=imgs, turns=n))
post = [r for r in rows if r['t0'] >= '2026-06-15' and r['turns'] >= 8]
def q(v):
    v = sorted(v); return [v[len(v)//2], v[int(len(v)*.75)], v[int(len(v)*.9)], v[-1]]
print('post-audit sessions with >=8 turns:', len(post))
print('final context tokens (system+history+images) p50/p75/p90/max:', q([r['ctx'] for r in post]))
print('text-only tokens (no images, no system prompt) p50/p75/p90/max:', q([r['text_tok'] for r in post]))
print('images per session p50/p75/p90/max:', q([r['imgs'] for r in post]))
tot_text = sum(r['text_tok'] for r in post)
tot_img = sum(r['imgs'] for r in post)
print(f'all post-audit: text tokens {tot_text/1e6:.1f}M, images {tot_img} (~{tot_img*1500/1e6:.1f}M tokens at ~1.5k each)')
# cost of a single-shot review: one call per session, whole session as input
for label, sel in [('top-100 by text size', sorted(post, key=lambda r: -r['text_tok'])[:100]), ('random-ish 100 (every 8th)', post[::max(1, len(post)//100)][:100]), ('all post-audit', post)]:
    tt = sum(r['text_tok'] for r in sel); ti = sum(r['imgs'] for r in sel) * 1500
    cost_text = tt / 1e6 * 5; cost_img = ti / 1e6 * 5; out = len(sel) * 3000 / 1e6 * 25
    print(f'{label:28} n={len(sel):4} text {tt/1e6:5.1f}M img {ti/1e6:5.1f}M -> Opus5 ${cost_text+out:6.0f} text-only, ${cost_text+cost_img+out:6.0f} with images  (batch: half)')
