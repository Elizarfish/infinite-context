import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMemory, computeImportance, extractKeywords, estimateTokens } from '../src/core/scorer.js';
import { resetConfig } from '../src/core/config.js';

describe('scoreMemory', () => {
  beforeEach(() => resetConfig());

  it('should score architecture highest', () => {
    const arch = scoreMemory('architecture', 'Some content');
    const note = scoreMemory('note', 'Some content');
    assert.ok(arch > note);
  });

  it('should give length bonus for detailed content', () => {
    const short = scoreMemory('note', 'Short');
    const long = scoreMemory('note', 'A'.repeat(500));
    assert.ok(long > short);
  });

  it('should cap at 1.0', () => {
    const score = scoreMemory('architecture', 'A'.repeat(10000));
    assert.ok(score <= 1.0);
  });
});

describe('computeImportance', () => {
  it('should rank recent memories higher', () => {
    const now = Date.now();
    const recent = computeImportance({
      score: 0.5, access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    const old = computeImportance({
      score: 0.5, access_count: 0,
      created_at: new Date(now - 30 * 86400000).toISOString(),
      last_accessed: new Date(now - 30 * 86400000).toISOString(),
    }, now);

    assert.ok(recent > old, `Recent ${recent} should be > old ${old}`);
  });

  it('should rank frequently accessed memories higher', () => {
    const now = Date.now();
    const accessed = computeImportance({
      score: 0.5, access_count: 10,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    const untouched = computeImportance({
      score: 0.5, access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);

    assert.ok(accessed > untouched);
  });

  it('should factor in base score', () => {
    const now = Date.now();
    const high = computeImportance({
      score: 0.9, access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    const low = computeImportance({
      score: 0.1, access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);

    assert.ok(high > low);
  });
});

describe('extractKeywords', () => {
  beforeEach(() => resetConfig());

  it('should remove stopwords', () => {
    const kw = extractKeywords('the quick brown fox jumps over the lazy dog');
    assert.ok(!kw.includes('the'));
    assert.ok(!kw.includes('over'));
    assert.ok(kw.includes('quick'));
    assert.ok(kw.includes('brown'));
  });

  it('should remove short words', () => {
    const kw = extractKeywords('a is it me');
    assert.equal(kw, '');
  });

  it('should deduplicate', () => {
    const kw = extractKeywords('react react react vue vue');
    const words = kw.split(' ');
    assert.equal(words.filter(w => w === 'react').length, 1);
  });

  it('should handle empty input', () => {
    assert.equal(extractKeywords(''), '');
    assert.equal(extractKeywords(null), '');
  });
});

describe('estimateTokens', () => {
  it('should approximate token count', () => {
    const tokens = estimateTokens('Hello world, this is a test');
    assert.ok(tokens > 0);
    assert.ok(tokens < 20);
  });

  it('should return 0 for empty', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
  });
});
