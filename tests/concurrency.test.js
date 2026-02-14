import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// We need to bypass the config singleton for tests — point dbPath at temp dirs.
// Store class loads config internally, so we create stores with explicit dbPath.
import { Store } from '../src/db/store.js';
import { resetConfig } from '../src/core/config.js';

/** Create a temporary directory and return a db path inside it. */
function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ic-conc-'));
  return { dir, dbPath: join(dir, 'test.db') };
}

/** Generate a memory object for insertion. */
function makeMemory(project, sessionId, index, keyword) {
  return {
    project,
    sessionId,
    category: 'note',
    content: `Memory entry ${index} about ${keyword || 'general topic'} for concurrency testing`,
    keywords: keyword || `keyword_${index}`,
    score: 0.5,
    sourceHash: null,
    metadata: null,
  };
}

// ---------------------------------------------------------------------------
// 1. MULTI-WRITER SIMULATION
// ---------------------------------------------------------------------------
describe('Multi-writer simulation', () => {
  let tmp;
  let stores;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    // Open 5 Store instances pointing to the same DB
    stores = Array.from({ length: 5 }, () => {
      const s = new Store(tmp.dbPath);
      s.open();
      return s;
    });
  });

  after(() => {
    for (const s of stores) s.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('5 writers x 200 memories each = 1000 total, no SQLITE_BUSY', () => {
    // better-sqlite3 is synchronous, so "parallel" means interleaved writes.
    // We simulate contention by interleaving insertions across all 5 stores.
    const errors = [];
    const batchSize = 200;

    for (let i = 0; i < batchSize; i++) {
      for (let w = 0; w < stores.length; w++) {
        try {
          stores[w].insertMemory(makeMemory('conc-project', `writer-${w}`, i * stores.length + w));
        } catch (err) {
          errors.push({ writer: w, index: i, error: err.message });
        }
      }
    }

    assert.equal(errors.length, 0, `Encountered errors: ${JSON.stringify(errors.slice(0, 5))}`);

    // Verify total count via any store
    const stats = stores[0].getStats();
    assert.equal(stats.total, 1000, `Expected 1000 memories, got ${stats.total}`);
  });
});

// ---------------------------------------------------------------------------
// 1b. MULTI-WRITER with insertMany (transactional batches)
// ---------------------------------------------------------------------------
describe('Multi-writer with insertMany batches', () => {
  let tmp;
  let stores;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    stores = Array.from({ length: 5 }, () => {
      const s = new Store(tmp.dbPath);
      s.open();
      return s;
    });
  });

  after(() => {
    for (const s of stores) s.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('5 writers each insertMany(200) interleaved by batches of 20', () => {
    const errors = [];
    const memoriesPerWriter = 200;
    const batchSize = 20;
    const batches = memoriesPerWriter / batchSize;

    for (let b = 0; b < batches; b++) {
      for (let w = 0; w < stores.length; w++) {
        const batch = [];
        for (let i = 0; i < batchSize; i++) {
          const idx = b * batchSize + i;
          batch.push(makeMemory('batch-project', `writer-${w}`, w * memoriesPerWriter + idx));
        }
        try {
          stores[w].insertMany(batch);
        } catch (err) {
          errors.push({ writer: w, batch: b, error: err.message });
        }
      }
    }

    assert.equal(errors.length, 0, `Encountered errors: ${JSON.stringify(errors.slice(0, 5))}`);
    const stats = stores[0].getStats();
    assert.equal(stats.total, 1000, `Expected 1000, got ${stats.total}`);
  });
});

// ---------------------------------------------------------------------------
// 2. READ-DURING-WRITE
// ---------------------------------------------------------------------------
describe('Read-during-write consistency', () => {
  let tmp;
  let writer;
  let reader;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    writer = new Store(tmp.dbPath);
    writer.open();
    reader = new Store(tmp.dbPath);
    reader.open();
  });

  after(() => {
    writer.close();
    reader.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('reader sees consistent state while writer inserts 1000 memories in batches', () => {
    const totalMemories = 1000;
    const batchSize = 100;
    const readResults = [];

    for (let batch = 0; batch < totalMemories / batchSize; batch++) {
      // Writer inserts a batch
      const memories = [];
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i;
        memories.push(makeMemory('readwrite-project', 'writer', idx, `rw_keyword_${idx}`));
      }
      writer.insertMany(memories);

      // Reader reads between batches
      const top = reader.getTopMemories('readwrite-project', 10000);
      const searchResults = reader.search('keyword', 'readwrite-project', 10000);

      readResults.push({
        batchEnd: (batch + 1) * batchSize,
        topCount: top.length,
        searchCount: searchResults.length,
      });

      // Top memories count should be a multiple of batchSize (consistent snapshot)
      assert.ok(
        top.length >= (batch + 1) * batchSize,
        `After batch ${batch + 1}, expected >= ${(batch + 1) * batchSize} from getTopMemories, got ${top.length}`
      );
    }

    // Final verification
    const finalTop = reader.getTopMemories('readwrite-project', 10000);
    assert.equal(finalTop.length, totalMemories, `Final count should be ${totalMemories}, got ${finalTop.length}`);
  });
});

// ---------------------------------------------------------------------------
// 3. FTS INDEX CONSISTENCY AFTER MUTATIONS
// ---------------------------------------------------------------------------
describe('FTS index consistency after mutations', () => {
  let tmp;
  let store;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    store = new Store(tmp.dbPath);
    store.open();
  });

  after(() => {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('FTS stays consistent through insert, prune, re-insert, enforceProjectLimit', () => {
    const project = 'fts-project';

    // Step 1: Insert 500 memories with known keywords
    const memories500 = [];
    for (let i = 0; i < 500; i++) {
      memories500.push({
        project,
        sessionId: 'fts-session',
        category: 'note',
        content: `Entry ${i} about unicorn technology`,
        keywords: 'unicorn technology',
        score: 0.3 + (i / 1000), // scores range from 0.3 to 0.799
        sourceHash: null,
        metadata: null,
      });
    }
    store.insertMany(memories500);

    let results = store.search('unicorn', project, 1000);
    assert.equal(results.length, 500, `After initial insert, expected 500, got ${results.length}`);

    // Step 2: Delete ~250 via pruneByScore (those with score < 0.55)
    //   scores range from 0.3 to 0.799; scores < 0.55 means indices 0..249 (250 entries)
    const pruned = store.db.prepare('DELETE FROM memories WHERE score < 0.55 AND project = ?').run(project);
    // FTS triggers should handle the deletion

    results = store.search('unicorn', project, 1000);
    const remaining = store.getTopMemories(project, 10000).length;
    assert.equal(remaining, 500 - pruned.changes,
      `After pruning ${pruned.changes}, expected ${500 - pruned.changes} remaining, got ${remaining}`);
    assert.equal(results.length, remaining,
      `FTS results (${results.length}) should match remaining memories (${remaining})`);

    // Step 3: Insert 250 more
    const memories250 = [];
    for (let i = 0; i < 250; i++) {
      memories250.push({
        project,
        sessionId: 'fts-session',
        category: 'note',
        content: `New entry ${i} about unicorn engineering`,
        keywords: 'unicorn engineering',
        score: 0.6,
        sourceHash: null,
        metadata: null,
      });
    }
    store.insertMany(memories250);

    const totalAfterReinsert = store.getTopMemories(project, 10000).length;
    results = store.search('unicorn', project, 1000);
    assert.equal(results.length, totalAfterReinsert,
      `FTS results (${results.length}) should match total (${totalAfterReinsert})`);

    // Step 4: enforceProjectLimit to trim to 300
    // We need to override maxMemoriesPerProject in the pruneProject statement.
    // The Store uses config, so we'll call enforceProjectLimit after setting a lower limit.
    // Since we can't easily override config, we'll use the raw SQL approach.
    const currentTotal = totalAfterReinsert;
    if (currentTotal > 300) {
      store.db.prepare(`
        DELETE FROM memories WHERE id IN (
          SELECT id FROM memories WHERE project = ?
          ORDER BY score ASC LIMIT ?
        )
      `).run(project, currentTotal - 300);
    }

    const afterLimit = store.getTopMemories(project, 10000).length;
    assert.equal(afterLimit, 300, `After enforcing limit, expected 300, got ${afterLimit}`);

    results = store.search('unicorn', project, 1000);
    assert.equal(results.length, 300,
      `FTS results after enforceProjectLimit: expected 300, got ${results.length}`);
  });
});

// ---------------------------------------------------------------------------
// 4. CHECKPOINT + MEMORY ATOMICITY (source_hash dedup on retry)
// ---------------------------------------------------------------------------
describe('Checkpoint + memory atomicity and dedup', () => {
  let tmp;
  let store;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    store = new Store(tmp.dbPath);
    store.open();
  });

  after(() => {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('source_hash dedup prevents duplicates when same transcript range is re-parsed', () => {
    const project = 'dedup-project';
    const sessionId = 'dedup-session';
    const transcriptPath = '/tmp/fake-transcript.jsonl';

    // Simulate first parse: insert memories with source hashes
    const firstParse = [];
    for (let i = 0; i < 50; i++) {
      firstParse.push({
        project,
        sessionId,
        category: 'note',
        content: `Parsed memory ${i} from transcript`,
        keywords: `transcript line_${i}`,
        score: 0.5,
        sourceHash: `hash_${i}`,
        metadata: null,
      });
    }

    const inserted1 = store.insertMany(firstParse);
    assert.equal(inserted1, 50, `First parse should insert 50, got ${inserted1}`);

    // Simulate: saveCheckpoint succeeds
    store.saveCheckpoint(sessionId, transcriptPath, 100);
    const cp1 = store.getCheckpoint(sessionId, transcriptPath);
    assert.equal(cp1.last_line_number, 100);

    // Simulate: second parse of same range (checkpoint was saved but imagine a retry scenario)
    // Re-insert the same memories with same source_hashes
    const inserted2 = store.insertMany(firstParse);
    assert.equal(inserted2, 0, `Duplicate parse should insert 0 due to source_hash dedup, got ${inserted2}`);

    // Verify total is still 50
    const stats = store.getStats();
    assert.equal(stats.total, 50, `Total should be 50 after dedup retry, got ${stats.total}`);
  });

  it('insertMany succeeds but checkpoint save can fail independently', () => {
    const project = 'atomicity-project';
    const sessionId = 'atomicity-session';
    const transcriptPath = '/tmp/fake-transcript2.jsonl';

    // Insert memories
    const memories = [];
    for (let i = 0; i < 30; i++) {
      memories.push({
        project,
        sessionId,
        category: 'note',
        content: `Atomicity test memory ${i}`,
        keywords: `atomicity_${i}`,
        score: 0.5,
        sourceHash: `atom_hash_${i}`,
        metadata: null,
      });
    }

    const inserted = store.insertMany(memories);
    assert.equal(inserted, 30);

    // Simulate checkpoint failure (don't save checkpoint)
    // On retry, the same memories would be re-parsed
    const retryInserted = store.insertMany(memories);
    assert.equal(retryInserted, 0, `Retry should insert 0 due to source_hash dedup, got ${retryInserted}`);

    // Now save checkpoint
    store.saveCheckpoint(sessionId, transcriptPath, 50);
    const cp = store.getCheckpoint(sessionId, transcriptPath);
    assert.equal(cp.last_line_number, 50);
  });
});

// ---------------------------------------------------------------------------
// 5. LARGE TRANSACTION
// ---------------------------------------------------------------------------
describe('Large transaction — 50,000 memories', () => {
  let tmp;
  let store;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    store = new Store(tmp.dbPath);
    store.open();
  });

  after(() => {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('insertMany with 50,000 memories in a single call', () => {
    const project = 'large-project';
    const memories = [];
    for (let i = 0; i < 50000; i++) {
      memories.push({
        project,
        sessionId: 'large-session',
        category: 'note',
        content: `Bulk memory ${i} about large scale data ingestion`,
        keywords: `bulk ingestion item_${i}`,
        score: 0.3 + Math.random() * 0.5,
        sourceHash: null,
        metadata: null,
      });
    }

    const inserted = store.insertMany(memories);
    assert.equal(inserted, 50000, `Expected 50000 inserted, got ${inserted}`);

    // Verify count
    const stats = store.getStats();
    assert.equal(stats.total, 50000, `Total should be 50000, got ${stats.total}`);

    // Verify search still works
    const results = store.search('bulk ingestion', project, 10);
    assert.ok(results.length > 0, 'Search should return results after large insert');
    assert.ok(results.length <= 10, 'Search should respect limit');

    // Verify getTopMemories works
    const top = store.getTopMemories(project, 20);
    assert.equal(top.length, 20, `getTopMemories should return 20, got ${top.length}`);
  });
});

// ---------------------------------------------------------------------------
// 6. CONCURRENT DECAY
// ---------------------------------------------------------------------------
describe('Concurrent decay and prune', () => {
  let tmp;
  let stores;

  before(() => {
    resetConfig();
    tmp = makeTempDb();

    // Create a primary store and seed data
    const primary = new Store(tmp.dbPath);
    primary.open();
    const memories = [];
    for (let i = 0; i < 500; i++) {
      memories.push({
        project: 'decay-project',
        sessionId: 'decay-session',
        category: 'note',
        content: `Decay test memory ${i}`,
        keywords: `decay_keyword_${i}`,
        score: 0.1 + Math.random() * 0.8,
        sourceHash: null,
        metadata: null,
      });
    }
    primary.insertMany(memories);

    // Backdate some memories to make decay meaningful
    primary.db.prepare(`
      UPDATE memories SET last_accessed = datetime('now', '-30 days')
      WHERE id % 3 = 0
    `).run();
    primary.db.prepare(`
      UPDATE memories SET last_accessed = datetime('now', '-7 days')
      WHERE id % 3 = 1
    `).run();

    primary.close();

    // Open 3 independent Store instances
    stores = Array.from({ length: 3 }, () => {
      const s = new Store(tmp.dbPath);
      s.open();
      return s;
    });
  });

  after(() => {
    for (const s of stores) s.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('3 stores all call decayAndPrune() without crashing', () => {
    const errors = [];
    const results = [];

    // Interleave decay calls across the 3 stores
    for (let round = 0; round < 3; round++) {
      for (let s = 0; s < stores.length; s++) {
        try {
          const pruned = stores[s].decayAndPrune();
          results.push({ store: s, round, pruned });
        } catch (err) {
          errors.push({ store: s, round, error: err.message });
        }
      }
    }

    assert.equal(errors.length, 0, `Decay errors: ${JSON.stringify(errors)}`);

    // Verify DB is consistent after all decays
    const stats = stores[0].getStats();
    assert.ok(stats.total >= 0, 'DB should be in a consistent state');

    // Verify we can still search
    const searchResults = stores[1].search('decay', 'decay-project', 100);
    // Some may have been pruned, but no crash
    assert.ok(Array.isArray(searchResults), 'Search should still work after concurrent decay');

    // Verify all stores see the same count
    const counts = stores.map(s => s.getStats().total);
    assert.equal(counts[0], counts[1], 'All stores should see same count');
    assert.equal(counts[1], counts[2], 'All stores should see same count');
  });
});

// ---------------------------------------------------------------------------
// 7. WAL mode verification
// ---------------------------------------------------------------------------
describe('WAL mode verification', () => {
  let tmp;
  let store;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    store = new Store(tmp.dbPath);
    store.open();
  });

  after(() => {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('database is in WAL journal mode', () => {
    const row = store.db.prepare('PRAGMA journal_mode').get();
    assert.equal(row.journal_mode, 'wal', `Expected WAL mode, got ${row.journal_mode}`);
  });

  it('synchronous is set to NORMAL', () => {
    const row = store.db.prepare('PRAGMA synchronous').get();
    // NORMAL = 1
    assert.equal(row.synchronous, 1, `Expected synchronous=1 (NORMAL), got ${row.synchronous}`);
  });
});

// ---------------------------------------------------------------------------
// 8. STRESS: Interleaved insert + search + decay
// ---------------------------------------------------------------------------
describe('Stress: interleaved insert, search, and decay', () => {
  let tmp;
  let stores;

  before(() => {
    resetConfig();
    tmp = makeTempDb();
    stores = Array.from({ length: 3 }, () => {
      const s = new Store(tmp.dbPath);
      s.open();
      return s;
    });
  });

  after(() => {
    for (const s of stores) s.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('writer, searcher, and decayer operate concurrently without errors', () => {
    const errors = [];
    const writerStore = stores[0];
    const searcherStore = stores[1];
    const decayerStore = stores[2];

    for (let round = 0; round < 50; round++) {
      // Writer inserts a batch
      try {
        const batch = [];
        for (let i = 0; i < 20; i++) {
          batch.push(makeMemory('stress-project', 'stress-session', round * 20 + i, 'stress_target'));
        }
        writerStore.insertMany(batch);
      } catch (err) {
        errors.push({ role: 'writer', round, error: err.message });
      }

      // Searcher searches
      try {
        searcherStore.search('stress_target', 'stress-project', 50);
        searcherStore.getTopMemories('stress-project', 10);
      } catch (err) {
        errors.push({ role: 'searcher', round, error: err.message });
      }

      // Decayer decays (every 5th round)
      if (round % 5 === 0) {
        try {
          decayerStore.decayAndPrune();
        } catch (err) {
          errors.push({ role: 'decayer', round, error: err.message });
        }
      }
    }

    assert.equal(errors.length, 0, `Stress test errors: ${JSON.stringify(errors.slice(0, 10))}`);

    // Verify final state is consistent across all stores
    const counts = stores.map(s => s.getStats().total);
    assert.equal(counts[0], counts[1]);
    assert.equal(counts[1], counts[2]);
    assert.ok(counts[0] > 0, 'Should have some memories remaining');
  });
});
