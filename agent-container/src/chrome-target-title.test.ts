import { describe, expect, it } from 'vitest';
import { decodeChromeTargetTitle } from './chrome-target-title';

describe('decodeChromeTargetTitle', () => {
  it('decodes the entities escaped by Chrome target discovery', () => {
    expect(decodeChromeTargetTitle('IAM &amp; Admin &lt;prod&gt; &quot;home&quot; &#39;one&#39;'))
      .toBe('IAM & Admin <prod> "home" \'one\'');
  });

  it('decodes only one layer of escaping', () => {
    expect(decodeChromeTargetTitle('Literal &amp;amp; text')).toBe('Literal &amp; text');
  });

  it('leaves unrelated entities and plain titles unchanged', () => {
    expect(decodeChromeTargetTitle('Research & development &copy;')).toBe('Research & development &copy;');
  });
});
