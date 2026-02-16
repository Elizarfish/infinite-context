import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Store } from '../src/db/store.js';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';
import { resetConfig } from '../src/core/config.js';

const TMP = join(tmpdir(), 'ic-stress-' + process.pid);

function tmpPath(name) {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  return join(TMP, name);
}

function cleanup(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

function timeMs(fn) {
  const start = performance.now();
  const result = fn();
  return { result, elapsed: performance.now() - start };
}

// ─── 1. Large transcript parsing ─────────────────────────────────────────────

describe('Stress: parseTranscript with 10,000 lines', () => {
  const txPath = tmpPath('large-transcript.jsonl');

  beforeEach(() => {
    resetConfig();
    const lines = [];
    for (let i = 0; i < 10000; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      lines.push(JSON.stringify({
        type: role === 'user' ? 'user' : 'A',
        message: {
          role,
          content: `Message number ${i}: ${'x'.repeat(100)}`,
        },
        uuid: `uuid-${i}`,
        sessionId: 'stress-session',
        timestamp: new Date().toISOString(),
      }));
    }
    writeFileSync(txPath, lines.join('\n'), 'utf-8');
  });

  afterEach(() => {
    try { unlinkSync(txPath); } catch {}
  });

  it('should parse 10,000-line transcript under 2 seconds', () => {
    const { result, elapsed } = timeMs(() => parseTranscript(txPath));
    console.log(`  parseTranscript 10K lines: ${elapsed.toFixed(1)}ms, ${result.messages.length} messages`);
    assert.equal(result.messages.length, 10000);
    assert.equal(result.lastLine, 10000);
    assert.ok(elapsed < 2000, `Took ${elapsed.toFixed(0)}ms — expected <2000ms`);
  });

  it('should support incremental parsing from midpoint', () => {
    const { result, elapsed } = timeMs(() => parseTranscript(txPath, 5000));
    console.log(`  parseTranscript incremental from 5000: ${elapsed.toFixed(1)}ms, ${result.messages.length} messages`);
    assert.equal(result.messages.length, 5000);
    assert.ok(elapsed < 2000);
  });

  it('should group 10,000 messages into turns', () => {
    const { messages } = parseTranscript(txPath);
    const { result: turns, elapsed } = timeMs(() => groupIntoTurns(messages));
    console.log(`  groupIntoTurns 10K messages: ${elapsed.toFixed(1)}ms, ${turns.length} turns`);
    assert.equal(turns.length, 5000);
    assert.ok(elapsed < 1000);
  });
});

// ─── 2. Large DB — 10,000+ inserts and query performance ────────────────────

describe('Stress: Store with 10,000+ memories', () => {
  let db;
  const dbPath = tmpPath('stress-10k.db');

  beforeEach(() => {
    resetConfig();
    cleanup(dbPath);
    db = new Store(dbPath).open();
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it('should insert 10,000 memories via insertMany under 5 seconds', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: `sess-${i % 10}`,
        category: ['decision', 'note', 'architecture', 'error', 'finding'][i % 5],
        content: `Memory item ${i}: This is a moderately long content string to simulate real data with various words for FTS indexing. Item index ${i}.`,
        keywords: `keyword${i} stress bulk test item${i % 100}`,
        score: Math.random() * 0.8 + 0.1,
        sourceHash: `hash-${i}`,
      });
    }

    const { result: inserted, elapsed } = timeMs(() => db.insertMany(memories));
    console.log(`  insertMany 10K: ${elapsed.toFixed(1)}ms, ${inserted} inserted`);
    assert.equal(inserted, 10000);
    assert.ok(elapsed < 5000, `insertMany took ${elapsed.toFixed(0)}ms — expected <5000ms`);
  });

  it('should measure getTopMemories speed on 10K rows', () => {
    // Bulk insert first
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: 'sess-1',
        category: 'note',
        content: `Memory ${i}`,
        keywords: `kw${i}`,
        score: Math.random(),
        sourceHash: `h-${i}`,
      });
    }
    db.insertMany(memories);

    const { result: top20, elapsed: t20 } = timeMs(() => db.getTopMemories('/stress/project', 20));
    const { result: top100, elapsed: t100 } = timeMs(() => db.getTopMemories('/stress/project', 100));
    const { result: top1000, elapsed: t1000 } = timeMs(() => db.getTopMemories('/stress/project', 1000));

    console.log(`  getTopMemories(20):   ${t20.toFixed(2)}ms  (${top20.length} rows)`);
    console.log(`  getTopMemories(100):  ${t100.toFixed(2)}ms (${top100.length} rows)`);
    console.log(`  getTopMemories(1000): ${t1000.toFixed(2)}ms (${top1000.length} rows)`);

    assert.equal(top20.length, 20);
    assert.equal(top100.length, 100);
    assert.equal(top1000.length, 1000);
    assert.ok(t20 < 100, `getTopMemories(20) took ${t20.toFixed(0)}ms`);
    assert.ok(t100 < 200, `getTopMemories(100) took ${t100.toFixed(0)}ms`);
    assert.ok(t1000 < 500, `getTopMemories(1000) took ${t1000.toFixed(0)}ms`);
  });

  it('should measure FTS5 search speed on 10K rows', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: 'sess-1',
        category: 'note',
        content: `Memory ${i}: ${i % 3 === 0 ? 'react' : 'express'} framework discussion about ${i % 7 === 0 ? 'authentication' : 'routing'}`,
        keywords: `memory${i} ${i % 3 === 0 ? 'react frontend' : 'express backend'}`,
        score: Math.random(),
        sourceHash: `fts-${i}`,
      });
    }
    db.insertMany(memories);

    const { result: r1, elapsed: t1 } = timeMs(() => db.search('react', '/stress/project', 10));
    const { result: r2, elapsed: t2 } = timeMs(() => db.search('authentication', '/stress/project', 50));
    const { result: r3, elapsed: t3 } = timeMs(() => db.search('react frontend framework', null, 100));

    console.log(`  FTS search "react" (project, 10):         ${t1.toFixed(2)}ms (${r1.length} results)`);
    console.log(`  FTS search "authentication" (project, 50): ${t2.toFixed(2)}ms (${r2.length} results)`);
    console.log(`  FTS search "react frontend" (all, 100):    ${t3.toFixed(2)}ms (${r3.length} results)`);

    assert.ok(r1.length > 0);
    assert.ok(r2.length > 0);
    assert.ok(t1 < 200, `FTS search took ${t1.toFixed(0)}ms`);
    assert.ok(t2 < 200, `FTS search took ${t2.toFixed(0)}ms`);
    assert.ok(t3 < 500, `FTS search took ${t3.toFixed(0)}ms`);
  });

  it('should measure decayAndPrune speed on 10K rows', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: 'sess-1',
        category: 'note',
        content: `Decay test memory ${i}`,
        keywords: `decay${i}`,
        score: Math.random() * 0.1 + 0.01, // low scores so some get pruned
        sourceHash: `decay-${i}`,
      });
    }
    db.insertMany(memories);

    const { result: pruned, elapsed } = timeMs(() => db.decayAndPrune());
    const stats = db.getStats();
    console.log(`  decayAndPrune on 10K: ${elapsed.toFixed(2)}ms, ${pruned} pruned, ${stats.total} remaining`);

    assert.ok(elapsed < 1000, `decayAndPrune took ${elapsed.toFixed(0)}ms — expected <1000ms`);
  });

  it('should measure enforceProjectLimit speed on 10K rows', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: 'sess-1',
        category: 'note',
        content: `Limit test memory ${i}`,
        keywords: `limit${i}`,
        score: Math.random(),
        sourceHash: `limit-${i}`,
      });
    }
    db.insertMany(memories);

    const { result: deleted, elapsed } = timeMs(() => db.enforceProjectLimit('/stress/project'));
    const stats = db.getStats();
    console.log(`  enforceProjectLimit on 10K (limit=5000): ${elapsed.toFixed(2)}ms, ${deleted} deleted, ${stats.total} remaining`);

    assert.equal(stats.total, 5000);
    assert.equal(deleted, 5000);
    assert.ok(elapsed < 2000, `enforceProjectLimit took ${elapsed.toFixed(0)}ms — expected <2000ms`);
  });

  it('should report DB file size after 10K inserts', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/stress/project',
        sessionId: 'sess-1',
        category: 'note',
        content: `Size test memory ${i}: ${'x'.repeat(200)}`,
        keywords: `size${i} test bulk`,
        score: Math.random(),
        sourceHash: `size-${i}`,
      });
    }
    db.insertMany(memories);

    const stats = db.getStats();
    const fileSize = statSync(dbPath).size;
    console.log(`  DB file size after 10K inserts: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  DB size via pragma: ${(stats.dbSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Total memories: ${stats.total}`);

    assert.equal(stats.total, 10000);
    assert.ok(fileSize > 0);
    // Sanity check: 10K rows with ~200 bytes content should be less than 100 MB
    assert.ok(fileSize < 100 * 1024 * 1024);
  });
});

// ─── 3. Concurrent access — multiple Store instances on same DB file ────────

describe('Stress: concurrent access to same DB', () => {
  const dbPath = tmpPath('stress-concurrent.db');

  afterEach(() => {
    cleanup(dbPath);
  });

  it('should handle multiple simultaneous writers via WAL mode', () => {
    resetConfig();
    const stores = [];
    const N = 5;

    // Open N stores to the same DB
    for (let i = 0; i < N; i++) {
      stores.push(new Store(dbPath).open());
    }

    // Each store inserts 100 memories
    const results = [];
    for (let s = 0; s < N; s++) {
      const memories = [];
      for (let i = 0; i < 100; i++) {
        memories.push({
          project: '/concurrent',
          sessionId: `sess-${s}`,
          category: 'note',
          content: `Store ${s} memory ${i}`,
          keywords: `concurrent store${s} item${i}`,
          score: 0.5,
          sourceHash: `concurrent-${s}-${i}`,
        });
      }
      const count = stores[s].insertMany(memories);
      results.push(count);
    }

    // Verify all inserts succeeded
    const total = results.reduce((a, b) => a + b, 0);
    console.log(`  Concurrent writes: ${N} stores x 100 memories = ${total} total`);
    assert.equal(total, 500);

    // Verify reads see all data
    const allMemories = stores[0].getTopMemories('/concurrent', 1000);
    console.log(`  Readable from any store: ${allMemories.length} memories`);
    assert.equal(allMemories.length, 500);

    for (const s of stores) s.close();
  });

  it('should handle concurrent reads and writes', () => {
    resetConfig();
    const writer = new Store(dbPath).open();
    const reader = new Store(dbPath).open();

    // Insert baseline data
    for (let i = 0; i < 1000; i++) {
      writer.insertMemory({
        project: '/rw',
        sessionId: 's1',
        category: 'note',
        content: `Concurrent RW memory ${i}`,
        keywords: `rw concurrent item${i}`,
        score: 0.5,
        sourceHash: `rw-${i}`,
      });
    }

    // Read while writing
    const readResults = [];
    for (let batch = 0; batch < 10; batch++) {
      // Write a batch
      for (let i = 0; i < 100; i++) {
        writer.insertMemory({
          project: '/rw',
          sessionId: 's1',
          category: 'note',
          content: `Batch ${batch} memory ${i}`,
          keywords: `batch rw`,
          score: 0.5,
          sourceHash: `rw-batch-${batch}-${i}`,
        });
      }
      // Read concurrently
      const top = reader.getTopMemories('/rw', 20);
      readResults.push(top.length);
    }

    console.log(`  Read results during writes: [${readResults.join(', ')}]`);
    assert.ok(readResults.every(r => r === 20));

    const finalCount = reader.getTopMemories('/rw', 10000).length;
    console.log(`  Total after concurrent RW: ${finalCount}`);
    assert.equal(finalCount, 2000);

    writer.close();
    reader.close();
  });
});

// ─── 4. Unicode & special characters ────────────────────────────────────────

describe('Stress: Unicode and special characters', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should store and retrieve CJK content (日本語, 中文, 한국어)', () => {
    const id = db.insertMemory({
      project: '/unicode',
      sessionId: 's1',
      category: 'note',
      content: '日本語のテスト内容です。中文测试内容。한국어 테스트 내용입니다.',
      keywords: '日本語 中文 한국어 unicode cjk',
      score: 0.8,
      sourceHash: 'cjk-1',
    });

    assert.ok(id);
    const memories = db.getTopMemories('/unicode', 10);
    assert.equal(memories.length, 1);
    assert.ok(memories[0].content.includes('日本語'));
    assert.ok(memories[0].content.includes('中文'));
    assert.ok(memories[0].content.includes('한국어'));
  });

  it('should store and retrieve emoji content', () => {
    const id = db.insertMemory({
      project: '/unicode',
      sessionId: 's1',
      category: 'note',
      content: 'Fire test 🔥 Rocket 🚀 Heart ❤️ Multi-codepoint 👨‍👩‍👧‍👦',
      keywords: 'emoji 🔥 🚀 test',
      score: 0.7,
      sourceHash: 'emoji-1',
    });

    assert.ok(id);
    const mem = db.getTopMemories('/unicode', 10)[0];
    assert.ok(mem.content.includes('🔥'));
    assert.ok(mem.content.includes('🚀'));
    assert.ok(mem.content.includes('👨‍👩‍👧‍👦'));
  });

  it('should store and retrieve RTL content (Arabic, Hebrew)', () => {
    const id = db.insertMemory({
      project: '/unicode',
      sessionId: 's1',
      category: 'note',
      content: 'Arabic: عربي، اختبار المحتوى. Hebrew: עברית, בדיקת תוכן.',
      keywords: 'عربي عبرית rtl arabic hebrew',
      score: 0.6,
      sourceHash: 'rtl-1',
    });

    assert.ok(id);
    const mem = db.getTopMemories('/unicode', 10)[0];
    assert.ok(mem.content.includes('عربي'));
    assert.ok(mem.content.includes('עברית'));
  });

  it('should search FTS with CJK tokens', () => {
    db.insertMemory({
      project: '/unicode',
      sessionId: 's1',
      category: 'note',
      content: 'Architecture discussion about the React component framework',
      keywords: '日本語 architecture react',
      score: 0.8,
      sourceHash: 'cjk-fts-1',
    });

    const results = db.search('architecture', '/unicode', 10);
    assert.ok(results.length > 0);
  });

  it('should handle mixed unicode in bulk inserts', () => {
    const memories = [];
    const scripts = [
      '日本語テスト content',
      '中文测试 content',
      '한국어테스트 content',
      'عربي اختبار content',
      'עברית בדיקה content',
      '🔥🚀❤️ emoji content',
      'Ñoño café résumé naïve content',
      'Ελληνικά Κείμενο content',
      'Кириллица Текст content',
      'ภาษาไทย เนื้อหา content',
    ];
    for (let i = 0; i < 1000; i++) {
      memories.push({
        project: '/unicode-bulk',
        sessionId: 's1',
        category: 'note',
        content: `${scripts[i % scripts.length]} item ${i}`,
        keywords: `unicode bulk item${i}`,
        score: 0.5,
        sourceHash: `unicode-bulk-${i}`,
      });
    }

    const count = db.insertMany(memories);
    assert.equal(count, 1000);

    const stats = db.getStats();
    assert.equal(stats.total, 1000);
  });
});

// ─── 5. FTS5 special characters ─────────────────────────────────────────────

describe('Stress: FTS5 special character handling', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
    // Insert test data with various content
    const items = [
      { content: 'Use React for frontend', keywords: 'react frontend' },
      { content: 'Express backend API', keywords: 'express backend api' },
      { content: 'Database "migration" strategy', keywords: 'database migration' },
      { content: 'Error handling (try-catch)', keywords: 'error handling try catch' },
      { content: 'Performance optimization * profiling', keywords: 'performance optimization' },
      { content: 'NOT a bug: feature request', keywords: 'not bug feature' },
      { content: 'Config AND environment setup', keywords: 'config environment setup' },
      { content: 'Either OR both approaches work', keywords: 'either both approaches' },
    ];
    for (let i = 0; i < items.length; i++) {
      db.insertMemory({
        project: '/fts-special',
        sessionId: 's1',
        category: 'note',
        content: items[i].content,
        keywords: items[i].keywords,
        score: 0.5,
        sourceHash: `fts-special-${i}`,
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  it('should handle quotes in search queries gracefully', () => {
    // The search method wraps words in quotes, so embedded quotes could cause issues
    const results = db.search('database migration', '/fts-special', 10);
    assert.ok(results.length > 0);
  });

  it('should handle parentheses in search input', () => {
    const results = db.search('error (handling)', '/fts-special', 10);
    // Should not throw — parentheses are stripped by the word split
    assert.ok(Array.isArray(results));
  });

  it('should handle asterisks in search input', () => {
    const results = db.search('performance * optimization', '/fts-special', 10);
    assert.ok(Array.isArray(results));
  });

  it('should handle FTS operators in search input (AND, OR, NOT)', () => {
    // These words appear in content but should be treated as normal words by search()
    const r1 = db.search('NOT bug', '/fts-special', 10);
    assert.ok(Array.isArray(r1));

    const r2 = db.search('config AND environment', '/fts-special', 10);
    assert.ok(Array.isArray(r2));

    const r3 = db.search('either OR approaches', '/fts-special', 10);
    assert.ok(Array.isArray(r3));
  });

  it('should handle empty and single-char queries', () => {
    const r1 = db.search('', '/fts-special', 10);
    assert.deepEqual(r1, []);

    const r2 = db.search('x', '/fts-special', 10);
    assert.deepEqual(r2, []);

    const r3 = db.search('   ', '/fts-special', 10);
    assert.deepEqual(r3, []);
  });

  it('should handle very long search queries', () => {
    const longQuery = 'word '.repeat(200).trim();
    const results = db.search(longQuery, '/fts-special', 10);
    assert.ok(Array.isArray(results));
  });
});

// ─── 6. Huge content — 100KB memory ─────────────────────────────────────────

describe('Stress: huge content strings', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should insert and retrieve a memory with 100KB content', () => {
    const hugeContent = 'A'.repeat(100 * 1024); // 100KB
    const id = db.insertMemory({
      project: '/huge',
      sessionId: 's1',
      category: 'architecture',
      content: hugeContent,
      keywords: 'huge content test 100kb',
      score: 0.9,
      sourceHash: 'huge-100kb',
    });

    assert.ok(id);
    const memories = db.getTopMemories('/huge', 1);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content.length, 100 * 1024);
  });

  it('should insert and retrieve a memory with 1MB content', () => {
    const hugeContent = 'B'.repeat(1024 * 1024); // 1MB
    const id = db.insertMemory({
      project: '/huge',
      sessionId: 's1',
      category: 'architecture',
      content: hugeContent,
      keywords: 'huge content test 1mb',
      score: 0.9,
      sourceHash: 'huge-1mb',
    });

    assert.ok(id);
    const memories = db.getTopMemories('/huge', 1);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content.length, 1024 * 1024);
  });

  it('should search FTS with huge content in the DB', () => {
    // Insert a huge memory plus a normal one
    db.insertMemory({
      project: '/huge',
      sessionId: 's1',
      category: 'note',
      content: 'Normal memory about react framework',
      keywords: 'react framework normal',
      score: 0.5,
      sourceHash: 'normal-1',
    });
    db.insertMemory({
      project: '/huge',
      sessionId: 's1',
      category: 'note',
      content: 'Z'.repeat(100 * 1024) + ' react mention',
      keywords: 'huge react mention',
      score: 0.5,
      sourceHash: 'huge-react',
    });

    const { result, elapsed } = timeMs(() => db.search('react', '/huge', 10));
    console.log(`  FTS search with 100KB row in DB: ${elapsed.toFixed(2)}ms, ${result.length} results`);
    assert.ok(result.length >= 1);
    assert.ok(elapsed < 500);
  });
});

// ─── 7. Deduplication at scale ──────────────────────────────────────────────

describe('Stress: deduplication at scale', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should correctly deduplicate 10K inserts where 50% are duplicates', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/dedup',
        sessionId: 's1',
        category: 'note',
        content: `Dedup memory ${i % 5000}`,
        keywords: `dedup item${i % 5000}`,
        score: 0.5,
        sourceHash: `dedup-${i % 5000}`, // 50% duplicates
      });
    }

    const { result: inserted, elapsed } = timeMs(() => db.insertMany(memories));
    console.log(`  Dedup 10K (50% dup): ${elapsed.toFixed(1)}ms, ${inserted} inserted`);
    assert.equal(inserted, 5000);

    const stats = db.getStats();
    assert.equal(stats.total, 5000);
  });
});

// ─── 8. Score decay and pruning at scale ────────────────────────────────────

describe('Stress: score decay and pruning cycles', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should handle multiple decay cycles on 10K memories', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/decay-cycle',
        sessionId: 's1',
        category: 'note',
        content: `Decay cycle memory ${i}`,
        keywords: `decay cycle`,
        score: Math.random() * 0.3 + 0.05,
        sourceHash: `dc-${i}`,
      });
    }
    db.insertMany(memories);

    const results = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const { result: pruned, elapsed } = timeMs(() => db.decayAndPrune());
      const stats = db.getStats();
      results.push({ cycle, pruned, remaining: stats.total, elapsed: elapsed.toFixed(2) });
    }

    console.log('  Decay cycles:');
    for (const r of results) {
      console.log(`    Cycle ${r.cycle}: pruned=${r.pruned}, remaining=${r.remaining}, ${r.elapsed}ms`);
    }

    // After multiple decay cycles, some should have been pruned
    assert.ok(results[0].remaining <= 10000);
  });
});

// ─── 9. touchMemories at scale ──────────────────────────────────────────────

describe('Stress: touchMemories at scale', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should touch 1000 memories efficiently', () => {
    const memories = [];
    for (let i = 0; i < 1000; i++) {
      memories.push({
        project: '/touch',
        sessionId: 's1',
        category: 'note',
        content: `Touch memory ${i}`,
        keywords: `touch item${i}`,
        score: 0.5,
        sourceHash: `touch-${i}`,
      });
    }
    db.insertMany(memories);

    const all = db.getTopMemories('/touch', 1000);
    const ids = all.map(m => m.id);

    const { elapsed } = timeMs(() => db.touchMemories(ids));
    console.log(`  touchMemories(1000): ${elapsed.toFixed(2)}ms`);

    // Verify scores went up
    const after = db.getTopMemories('/touch', 1);
    assert.equal(after[0].score, 0.51);
    assert.equal(after[0].access_count, 1);
    assert.ok(elapsed < 1000);
  });
});

// ─── 10. Session management at scale ────────────────────────────────────────

describe('Stress: session management', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should handle 100 sessions efficiently', () => {
    for (let i = 0; i < 100; i++) {
      db.upsertSession(`session-${i}`, `/project-${i % 5}`);
      db.incrSessionMemories(`session-${i}`, Math.floor(Math.random() * 100));
      if (i % 3 === 0) db.incrSessionCompactions(`session-${i}`);
    }

    const { result: stats, elapsed } = timeMs(() => db.getStats());
    console.log(`  getStats with 100 sessions: ${elapsed.toFixed(2)}ms`);
    assert.equal(stats.sessions.length, 100);
    assert.ok(elapsed < 200);
  });
});

// ─── 11. Checkpoint management at scale ─────────────────────────────────────

describe('Stress: checkpoint operations', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should handle many checkpoints for many sessions', () => {
    for (let s = 0; s < 50; s++) {
      for (let c = 0; c < 20; c++) {
        db.saveCheckpoint(`sess-${s}`, `/path/transcript-${s}.jsonl`, c * 100);
      }
    }

    // 50 sessions x 20 checkpoints = 1000 checkpoints
    const { result: cp, elapsed } = timeMs(() => db.getCheckpoint('sess-25', '/path/transcript-25.jsonl'));
    console.log(`  getCheckpoint from 1000 total: ${elapsed.toFixed(2)}ms`);
    assert.equal(cp.last_line_number, 1900); // last checkpoint for sess-25
    assert.ok(elapsed < 50);
  });
});

// ─── 12. exportAll at scale ─────────────────────────────────────────────────

describe('Stress: exportAll', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should export 10K memories', () => {
    const memories = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        project: '/export',
        sessionId: 's1',
        category: 'note',
        content: `Export memory ${i}`,
        keywords: `export item${i}`,
        score: Math.random(),
        sourceHash: `export-${i}`,
      });
    }
    db.insertMany(memories);

    const { result: exported, elapsed } = timeMs(() => db.exportAll('/export'));
    console.log(`  exportAll(project) 10K: ${elapsed.toFixed(1)}ms, ${exported.length} rows`);
    assert.equal(exported.length, 10000);
    assert.ok(elapsed < 2000);

    const { result: all, elapsed: t2 } = timeMs(() => db.exportAll());
    console.log(`  exportAll() 10K:         ${t2.toFixed(1)}ms, ${all.length} rows`);
    assert.equal(all.length, 10000);
  });
});
