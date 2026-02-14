import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { restoreContext, recallForPrompt } from '../src/core/restorer.js';
import { resetConfig } from '../src/core/config.js';

describe('restoreContext', () => {
  beforeEach(() => resetConfig());

  it('should return empty for no memories', () => {
    const { text, ids } = restoreContext([]);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });

  it('should return empty for null', () => {
    const { text, ids } = restoreContext(null);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });

  it('should format memories by category', () => {
    const memories = [
      { id: 1, category: 'decision', content: 'Use SQLite', score: 0.9, access_count: 2, created_at: new Date().toISOString(), last_accessed: new Date().toISOString() },
      { id: 2, category: 'file_change', content: 'Modified index.js', score: 0.5, access_count: 0, created_at: new Date().toISOString(), last_accessed: new Date().toISOString() },
      { id: 3, category: 'error', content: 'Build failed', score: 0.8, access_count: 1, created_at: new Date().toISOString(), last_accessed: new Date().toISOString() },
    ];

    const { text, ids } = restoreContext(memories, 4000);
    assert.ok(text.includes('Key Decisions'));
    assert.ok(text.includes('Use SQLite'));
    assert.ok(text.includes('Files Modified'));
    assert.ok(text.includes('Known Issues'));
    assert.equal(ids.length, 3);
  });

  it('should respect token budget', () => {
    const memories = [];
    for (let i = 0; i < 100; i++) {
      memories.push({
        id: i,
        category: 'note',
        content: `Memory item number ${i} with some longer text to take up space in the context window`,
        score: 1 - i * 0.01,
        access_count: 0,
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
      });
    }

    const { text, ids } = restoreContext(memories, 500);
    assert.ok(ids.length < 100);
    assert.ok(ids.length > 0);
    // Token estimate: text.length / 3.5 should be roughly within budget
    const tokens = Math.ceil(text.length / 3.5);
    assert.ok(tokens <= 600, `Tokens ${tokens} should be near budget 500`);
  });

  it('should rank by importance (score * recency * frequency)', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86400000).toISOString();

    const memories = [
      { id: 1, category: 'note', content: 'Old unused', score: 0.9, access_count: 0, created_at: old, last_accessed: old },
      { id: 2, category: 'note', content: 'Recent used', score: 0.5, access_count: 5, created_at: now, last_accessed: now },
    ];

    const { ids } = restoreContext(memories, 4000);
    // Recent+used should rank higher despite lower base score
    assert.equal(ids[0], 2);
  });
});

describe('recallForPrompt', () => {
  it('should format search results', () => {
    const results = [
      { id: 1, category: 'decision', content: 'Use TypeScript' },
      { id: 2, category: 'file_change', content: 'Modified tsconfig.json' },
    ];

    const { text, ids } = recallForPrompt(results);
    assert.ok(text.includes('Relevant prior context'));
    assert.ok(text.includes('[decision] Use TypeScript'));
    assert.equal(ids.length, 2);
  });

  it('should return empty for no results', () => {
    const { text, ids } = recallForPrompt([]);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });
});
