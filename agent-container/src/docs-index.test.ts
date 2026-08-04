import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The self-knowledge docs folder ships in the image at /opt/gamut/docs and is
// navigated purely by INDEX.md + file names. These tests keep the index and
// the folder in lockstep so retrieval never silently rots.

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const INDEX_PATH = path.join(DOCS_DIR, 'INDEX.md');

function walkDocs(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkDocs(path.join(dir, entry.name), rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

const docFiles = walkDocs(DOCS_DIR).filter((f) => f !== 'INDEX.md');
const indexContent = fs.readFileSync(INDEX_PATH, 'utf-8');
const indexedPaths = [...indexContent.matchAll(/`([\w./-]+\.md)`/g)].map((m) => m[1]);

describe('self-knowledge docs index', () => {
  it('has at least the core FAQ/how-to/platform docs', () => {
    expect(docFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('every doc file is listed in INDEX.md', () => {
    const missing = docFiles.filter((f) => !indexedPaths.includes(f));
    expect(missing).toEqual([]);
  });

  it('every INDEX.md entry points at a real file', () => {
    const dangling = indexedPaths.filter((p) => !docFiles.includes(p));
    expect(dangling).toEqual([]);
  });

  it('every doc has frontmatter with a title and description', () => {
    const bad = docFiles.filter((f) => {
      const raw = fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      return !fm || !/^title: .+/m.test(fm[1]) || !/^description: .+/m.test(fm[1]);
    });
    expect(bad).toEqual([]);
  });

  it('every /opt/gamut/docs path mentioned in the system prompt exists', () => {
    const prompt = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf-8');
    const referenced = [...prompt.matchAll(/\/opt\/gamut\/docs\/([\w./-]+\.md)/g)].map((m) => m[1]);
    const dangling = referenced.filter((p) => p !== 'INDEX.md' && !docFiles.includes(p));
    expect(dangling).toEqual([]);
  });
});
