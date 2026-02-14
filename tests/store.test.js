import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/store.js';
import { resetConfig } from '../src/core/config.js';

describe('Store', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should create schema on open', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map(t => t.name);
    assert.ok(names.includes('memories'));
    assert.ok(names.includes('checkpoints'));
    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('meta'));
  });

  it('should insert and retrieve memories', () => {
    const id = db.insertMemory({
      project: '/test/project',
      sessionId: 'sess-1',
      category: 'decision',
      content: 'Use SQLite for storage instead of PostgreSQL',
      keywords: 'sqlite storage postgresql database',
      score: 0.9,
      sourceHash: 'abc123',
    });

    assert.ok(id);
    const memories = db.getTopMemories('/test/project', 10);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, 'Use SQLite for storage instead of PostgreSQL');
    assert.equal(memories[0].category, 'decision');
  });

  it('should deduplicate by source_hash', () => {
    db.insertMemory({
      project: '/test', sessionId: 's1', category: 'note',
      content: 'First', keywords: 'first', score: 0.5, sourceHash: 'same-hash',
    });
    const id2 = db.insertMemory({
      project: '/test', sessionId: 's1', category: 'note',
      content: 'Duplicate', keywords: 'duplicate', score: 0.5, sourceHash: 'same-hash',
    });

    assert.equal(id2, null);
    const memories = db.getTopMemories('/test', 10);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, 'First');
  });

  it('should insert many with dedup', () => {
    const items = [
      { project: '/p', sessionId: 's', category: 'note', content: 'A', keywords: 'a', score: 0.5, sourceHash: 'h1' },
      { project: '/p', sessionId: 's', category: 'note', content: 'B', keywords: 'b', score: 0.5, sourceHash: 'h2' },
      { project: '/p', sessionId: 's', category: 'note', content: 'C', keywords: 'c', score: 0.5, sourceHash: 'h1' }, // dup
    ];
    const inserted = db.insertMany(items);
    assert.equal(inserted, 2);
  });

  it('should search via FTS5', () => {
    db.insertMemory({
      project: '/test', sessionId: 's1', category: 'decision',
      content: 'Use React for the frontend framework', keywords: 'react frontend framework',
      score: 0.8, sourceHash: 'h1',
    });
    db.insertMemory({
      project: '/test', sessionId: 's1', category: 'decision',
      content: 'Use Express for the backend API', keywords: 'express backend api',
      score: 0.7, sourceHash: 'h2',
    });
    db.insertMemory({
      project: '/other', sessionId: 's1', category: 'note',
      content: 'React native for mobile', keywords: 'react native mobile',
      score: 0.5, sourceHash: 'h3',
    });

    // Search within project
    const results = db.search('react', '/test', 10);
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes('React'));

    // Search all projects
    const allResults = db.search('react', null, 10);
    assert.equal(allResults.length, 2);
  });

  it('should touch memories (update access)', () => {
    db.insertMemory({
      project: '/test', sessionId: 's1', category: 'note',
      content: 'Test memory', keywords: 'test', score: 0.5, sourceHash: 'h1',
    });
    const before = db.getTopMemories('/test', 1)[0];
    assert.equal(before.access_count, 0);
    assert.equal(before.score, 0.5);

    db.touchMemories([before.id]);

    const after = db.getTopMemories('/test', 1)[0];
    assert.equal(after.access_count, 1);
    assert.equal(after.score, 0.55); // +0.05
  });

  it('should handle checkpoints', () => {
    assert.equal(db.getCheckpoint('s1', '/path/transcript.jsonl'), undefined);

    db.saveCheckpoint('s1', '/path/transcript.jsonl', 42);
    const cp = db.getCheckpoint('s1', '/path/transcript.jsonl');
    assert.equal(cp.last_line_number, 42);

    db.saveCheckpoint('s1', '/path/transcript.jsonl', 100);
    const cp2 = db.getCheckpoint('s1', '/path/transcript.jsonl');
    assert.equal(cp2.last_line_number, 100);
  });

  it('should track sessions', () => {
    db.upsertSession('s1', '/project');
    db.incrSessionMemories('s1', 5);
    db.incrSessionCompactions('s1');

    const stats = db.getStats();
    assert.equal(stats.sessions.length, 1);
    assert.equal(stats.sessions[0].memories_created, 5);
    assert.equal(stats.sessions[0].compactions, 1);

    db.endSession('s1');
    const stats2 = db.getStats();
    assert.ok(stats2.sessions[0].ended_at);
  });

  it('should return stats', () => {
    db.insertMemory({ project: '/a', sessionId: 's1', category: 'note', content: 'A', keywords: 'a', score: 0.5, sourceHash: 'h1' });
    db.insertMemory({ project: '/a', sessionId: 's1', category: 'note', content: 'B', keywords: 'b', score: 0.5, sourceHash: 'h2' });
    db.insertMemory({ project: '/b', sessionId: 's1', category: 'note', content: 'C', keywords: 'c', score: 0.5, sourceHash: 'h3' });

    const stats = db.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.byProject.length, 2);
  });

  it('should order by score descending', () => {
    db.insertMemory({ project: '/p', sessionId: 's', category: 'note', content: 'Low', keywords: 'low', score: 0.2, sourceHash: 'h1' });
    db.insertMemory({ project: '/p', sessionId: 's', category: 'decision', content: 'High', keywords: 'high', score: 0.9, sourceHash: 'h2' });
    db.insertMemory({ project: '/p', sessionId: 's', category: 'error', content: 'Mid', keywords: 'mid', score: 0.5, sourceHash: 'h3' });

    const memories = db.getTopMemories('/p', 10);
    assert.equal(memories[0].content, 'High');
    assert.equal(memories[1].content, 'Mid');
    assert.equal(memories[2].content, 'Low');
  });
});
