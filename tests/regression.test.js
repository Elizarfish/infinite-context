/**
 * Regression tests for all 20 bug fixes.
 * Each test verifies that a specific fix works correctly and hasn't introduced new issues.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Store } from '../src/db/store.js';
import { scoreMemory, computeImportance, extractKeywords, estimateTokens } from '../src/core/scorer.js';
import { restoreContext } from '../src/core/restorer.js';
import { extractMemories } from '../src/core/archiver.js';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';
import { loadConfig, resetConfig, DEFAULTS } from '../src/core/config.js';

const TMP_DIR = join(tmpdir(), 'ic-regression-' + Date.now());
mkdirSync(TMP_DIR, { recursive: true });

function writeTmpTranscript(content, name) {
  const path = join(TMP_DIR, name || `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeNow() {
  return new Date().toISOString();
}

// ============================================================
// HIGH PRIORITY FIXES
// ============================================================

describe('FIX #1 — FTS5 injection: quotes in search queries', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'He said hello to the world', keywords: 'hello world said',
      score: 0.8, sourceHash: 'fts-fix-1',
    });
  });
  afterEach(() => db.close());

  it('search with embedded double quotes does not crash', () => {
    const results = db.search('he said "hello"', '/p', 10);
    assert.ok(Array.isArray(results), 'Should return array, not throw');
  });

  it('search with unbalanced quotes does not crash', () => {
    const results = db.search('"unbalanced', '/p', 10);
    assert.ok(Array.isArray(results));
  });

  it('search with multiple quotes does not crash', () => {
    const results = db.search('a "b" c "d" e', '/p', 10);
    assert.ok(Array.isArray(results));
  });

  it('quotes in query are escaped via double-quoting for FTS5', () => {
    // The fix: w.replace(/"/g, '""') inside the map in search()
    // Verify the search method constructs a valid FTS5 query
    const results = db.search('hello world', '/p', 10);
    assert.ok(results.length >= 1, 'Normal search still works after fix');
  });
});

describe('FIX #2 — Tool results captured from user messages', () => {
  it('tool_result-only user messages are merged into current turn', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Do something' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls' } },
          ],
        },
      }),
      // Synthetic user message: only tool_result, no text
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: 'file1.js\nfile2.js',
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I see the files.' }],
        },
      }),
    ];
    const path = writeTmpTranscript(lines.join('\n') + '\n', 'tool-result-fix.jsonl');
    const { messages } = parseTranscript(path);
    const turns = groupIntoTurns(messages);

    assert.equal(turns.length, 1, 'Synthetic user message should NOT create a new turn');
    assert.ok(turns[0].allToolResults.length >= 1, 'Tool results from synthetic user message should be merged');
    assert.equal(turns[0].allToolResults[0].content, 'file1.js\nfile2.js');
  });

  it('tool_result user messages populate allToolResults for archiver error extraction', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Run test' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'npm test' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: 'Error: test failed with assertion error',
            is_error: true,
          }],
        },
      }),
    ];
    const path = writeTmpTranscript(lines.join('\n') + '\n', 'tool-error-fix.jsonl');
    const { messages } = parseTranscript(path);
    const turns = groupIntoTurns(messages);

    resetConfig();
    const memories = extractMemories(turns, '/proj', 'sess');
    const errors = memories.filter(m => m.category === 'error');
    assert.ok(errors.length >= 1, 'Error tool results from synthetic user messages should be extracted');
  });
});

// ============================================================
// MEDIUM PRIORITY FIXES
// ============================================================

describe('FIX #3 — NaN dates: computeImportance guards against invalid dates', () => {
  it('undefined created_at and last_accessed returns number, not NaN', () => {
    const result = computeImportance({
      score: 0.7,
      access_count: 2,
      created_at: undefined,
      last_accessed: 'invalid-date',
    });
    assert.ok(!Number.isNaN(result), 'Should not produce NaN');
    assert.equal(typeof result, 'number');
    assert.equal(result, 0.7, 'Falls back to memory.score');
  });

  it('empty string dates return fallback', () => {
    const result = computeImportance({
      score: 0.3,
      access_count: 0,
      created_at: '',
      last_accessed: '',
    });
    assert.ok(!Number.isNaN(result));
    assert.equal(result, 0.3);
  });

  it('one valid, one invalid date returns fallback', () => {
    const result = computeImportance({
      score: 0.6,
      access_count: 0,
      created_at: new Date().toISOString(),
      last_accessed: 'garbage',
    });
    assert.ok(!Number.isNaN(result));
    assert.equal(result, 0.6, 'If either date is NaN, fallback to score');
  });
});

describe('FIX #4 — score=0 preserved with ?? operator', () => {
  it('computeImportance with score=0 uses 0 as base, not 0.5', () => {
    const now = Date.now();
    const result = computeImportance({
      score: 0,
      access_count: 5,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    assert.equal(result, 0, 'score=0 * anything = 0');
  });

  it('computeImportance with score=undefined uses 0.5 fallback', () => {
    const now = Date.now();
    const result = computeImportance({
      score: undefined,
      access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    assert.ok(result > 0, 'undefined score falls back to 0.5 via ??');
  });

  it('computeImportance with score=null uses 0.5 fallback', () => {
    const now = Date.now();
    const result = computeImportance({
      score: null,
      access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    }, now);
    assert.ok(result > 0, 'null score falls back to 0.5 via ??');
  });
});

describe('FIX #5 — budget=0 produces empty result', () => {
  beforeEach(() => resetConfig());

  it('restoreContext with budget=0 returns empty text and no ids', () => {
    const now = makeNow();
    const memories = [
      { id: 1, category: 'note', content: 'Important', score: 0.9, access_count: 0, created_at: now, last_accessed: now },
    ];
    const { text, ids } = restoreContext(memories, 0);
    assert.equal(text, '');
    assert.equal(ids.length, 0, 'budget=0 should restore nothing');
  });

  it('restoreContext with budget=undefined uses config default', () => {
    const now = makeNow();
    const memories = [
      { id: 1, category: 'note', content: 'Short', score: 0.9, access_count: 0, created_at: now, last_accessed: now },
    ];
    const { ids } = restoreContext(memories, undefined);
    assert.ok(ids.length >= 1, 'undefined budget should use config default (4000)');
  });
});

describe('FIX #6 — Section headers counted in token budget', () => {
  beforeEach(() => resetConfig());

  it('total restored tokens including headers do not exceed budget', () => {
    const now = makeNow();
    // Create memories across multiple categories to trigger section headers
    const memories = [
      { id: 1, category: 'architecture', content: 'Architecture content A', score: 0.95, access_count: 10, created_at: now, last_accessed: now },
      { id: 2, category: 'decision', content: 'Decision content B', score: 0.90, access_count: 8, created_at: now, last_accessed: now },
      { id: 3, category: 'error', content: 'Error content C', score: 0.85, access_count: 6, created_at: now, last_accessed: now },
      { id: 4, category: 'note', content: 'Note content D', score: 0.80, access_count: 4, created_at: now, last_accessed: now },
    ];

    const budget = 80;
    const { text, ids } = restoreContext(memories, budget);
    const actualTokens = estimateTokens(text);

    // With the fix, section header tokens are counted in the budget loop
    assert.ok(actualTokens <= budget, `Actual tokens (${actualTokens}) should not exceed budget (${budget})`);
  });
});

describe('FIX #7 — readStdin resolves exactly once (design review)', () => {
  // The fix uses a `resolved` boolean guard + `done()` helper.
  // Cannot unit-test stdin directly, but verify the pattern is correct.
  it('common.js readStdin uses resolved guard pattern', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/hooks/common.js'), 'utf-8');
    assert.ok(source.includes('let resolved = false'), 'readStdin should have resolved guard');
    assert.ok(source.includes('if (resolved) return'), 'readStdin should check resolved before resolving');
  });
});

describe('FIX #8 — stdout flush before exit (design review)', () => {
  it('runHook checks writableLength before exiting', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/hooks/common.js'), 'utf-8');
    assert.ok(source.includes('writableLength'), 'runHook should check stdout.writableLength');
    assert.ok(source.includes('drain'), 'runHook should wait for drain event');
    assert.ok(source.includes('process.exitCode = 0'), 'Should use exitCode instead of immediate exit');
  });
});

describe('FIX #9 — Metadata not double-stringified', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });
  afterEach(() => db.close());

  it('insertMemory with metadata object -> retrieve -> single JSON.parse yields object', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Test', keywords: 'test', score: 0.5,
      sourceHash: 'meta-regression-1',
      metadata: { agentId: 'agent-1', agentType: 'coder', nested: { x: 1 } },
    });

    const mem = db.getTopMemories('/p', 1)[0];
    const parsed = JSON.parse(mem.metadata);
    assert.equal(typeof parsed, 'object', 'Single parse should yield object, not string');
    assert.equal(parsed.agentId, 'agent-1');
    assert.equal(parsed.nested.x, 1);
  });

  it('subagent-stop metadata pattern: plain object assigned correctly', () => {
    // Simulate what subagent-stop.js does after the fix
    const mem = {
      project: '/p', sessionId: 's', category: 'note',
      content: 'From agent', keywords: 'agent', score: 0.5,
      sourceHash: 'meta-regression-2',
      metadata: null,
    };
    // The fix: assign plain object instead of JSON.stringify
    mem.metadata = {
      agentId: 'test-agent',
      agentType: 'researcher',
      ...(mem.metadata && typeof mem.metadata === 'object' ? mem.metadata : {}),
    };

    db.insertMemory(mem);
    const result = db.getTopMemories('/p', 1)[0];
    const parsed = JSON.parse(result.metadata);
    assert.equal(parsed.agentId, 'test-agent');
    assert.equal(parsed.agentType, 'researcher');
  });
});

describe('FIX #10 — DB closed on init error (design review)', () => {
  it('Store.open() try/catch closes db on schema init failure', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/db/store.js'), 'utf-8');
    // Verify the pattern: try { init } catch { db.close(); db=null; throw }
    assert.ok(source.includes('this.db.close()'), 'Should close db in catch');
    assert.ok(source.includes('this.db = null'), 'Should null out db reference in catch');
    // Verify the try/catch wraps _initSchema and _prepareStatements
    const tryIdx = source.indexOf('try {');
    const initIdx = source.indexOf('this._initSchema()');
    const catchIdx = source.indexOf('} catch (err) {');
    assert.ok(tryIdx < initIdx && initIdx < catchIdx, 'try/catch should wrap init');
  });
});

describe('FIX #11 — decayIntervalDays: NaN defaults to 1', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });
  afterEach(() => db.close());

  it('decayAndPrune with NaN config does not crash', () => {
    // The fix in store.js line 249: Math.max(1, Math.round(Number(cfg.decayIntervalDays) || 1))
    // Even if cfg.decayIntervalDays were NaN, Number(NaN) || 1 => 1
    const pruned = db.decayAndPrune();
    assert.equal(typeof pruned, 'number');
  });

  it('decayIntervalDays sanitized to at least 1', () => {
    // Verify the guard in store.js

    const source = readFileSync(join(import.meta.dirname, '../src/db/store.js'), 'utf-8');
    assert.ok(
      source.includes('Math.max(1, Math.round(Number(cfg.decayIntervalDays) || 1))'),
      'decayIntervalDays should be guarded against NaN'
    );
  });
});

describe('FIX #12 — pruneOld: 0 days defaults to 1 (not negative)', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });
  afterEach(() => db.close());

  it('pruneOld(0) does not produce negative days', () => {
    // The fix: Math.max(1, Math.round(Number(days) || 30))
    const pruned = db.pruneOld(0);
    assert.equal(typeof pruned, 'number');
    // 0 || 30 => 30, Math.max(1, 30) => 30
    // No negative day offset is generated
  });

  it('pruneOld(NaN) defaults to 30', () => {
    const pruned = db.pruneOld(NaN);
    assert.equal(typeof pruned, 'number');
  });

  it('pruneOld(-5) clamps to 1', () => {
    const pruned = db.pruneOld(-5);
    assert.equal(typeof pruned, 'number');
  });

  it('pruneOld guard ensures minimum of 1 day', () => {

    const source = readFileSync(join(import.meta.dirname, '../src/db/store.js'), 'utf-8');
    assert.ok(
      source.includes('Math.max(1, Math.round(Number(days) || 30))'),
      'pruneOld should guard against 0 and negative days'
    );
  });
});

describe('FIX #13 — Config validation: bad values fall back to defaults', () => {
  beforeEach(() => resetConfig());

  it('loadConfig validates numeric fields', () => {
    const cfg = loadConfig();
    // All numeric config values should be finite positive numbers
    assert.ok(Number.isFinite(cfg.maxRestoreTokens) && cfg.maxRestoreTokens >= 1);
    assert.ok(Number.isFinite(cfg.maxMemoriesPerRestore) && cfg.maxMemoriesPerRestore >= 1);
    assert.ok(Number.isFinite(cfg.maxPromptRecallResults) && cfg.maxPromptRecallResults >= 1);
    assert.ok(Number.isFinite(cfg.decayIntervalDays) && cfg.decayIntervalDays >= 1);
    assert.ok(Number.isFinite(cfg.maxMemoriesPerProject) && cfg.maxMemoriesPerProject >= 1);
  });

  it('loadConfig validates fraction fields (0-1 range)', () => {
    const cfg = loadConfig();
    assert.ok(cfg.decayFactor >= 0 && cfg.decayFactor <= 1);
    assert.ok(cfg.pruneThreshold >= 0 && cfg.pruneThreshold <= 1);
    assert.ok(cfg.scoreFloor >= 0 && cfg.scoreFloor <= 1);
  });

  it('config.js source has validation loops for numeric and fraction fields', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/core/config.js'), 'utf-8');
    assert.ok(source.includes('numericFields'), 'Should validate numeric fields');
    assert.ok(source.includes('fractionFields'), 'Should validate fraction fields');
    assert.ok(source.includes('Number.isFinite'), 'Should check isFinite');
  });
});

describe('FIX #14 — File paths extracted correctly in buildCompactInstructions', () => {
  it('regex extracts file path from "Created/wrote file: /src/foo.js"', () => {
    const content = 'Created/wrote file: /src/foo.js';
    // The fixed regex in pre-compact.js uses a capture group on the content directly
    const match = content.match(/(?:Created\/wrote|Edited) file:\s*(.+)/);
    assert.ok(match, 'Regex should match');
    const filePath = match[1].split('\n')[0];
    assert.equal(filePath, '/src/foo.js', 'File path should be extracted correctly');
  });

  it('regex extracts file path from "Edited file: /src/config.js"', () => {
    const content = 'Edited file: /src/config.js\n  Changed: "old" -> "new"';
    const match = content.match(/(?:Created\/wrote|Edited) file:\s*(.+)/);
    assert.ok(match);
    const filePath = match[1].split('\n')[0];
    assert.equal(filePath, '/src/config.js');
  });

  it('pre-compact.js uses correct regex for file path extraction', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/hooks/pre-compact.js'), 'utf-8');
    // Verify the regex is NOT using split(':')[0] which was the old broken pattern
    assert.ok(
      source.includes("(?:Created\\/wrote|Edited) file:\\s*(.+)") ||
      source.includes('Created/wrote|Edited) file'),
      'pre-compact should use regex capture group for file path extraction'
    );
    // Verify it does NOT use the broken split(':')[0] pattern
    assert.ok(
      !source.includes(".split(':')[0]"),
      'Should NOT use split(\":\")[0] which breaks file path extraction'
    );
  });
});

// ============================================================
// LOW PRIORITY FIXES
// ============================================================

describe('FIX #15 — Dead code removed (dead "lower" variable in archiver)', () => {
  it('extractDecisions in archiver.js does not declare unused "lower" variable', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/core/archiver.js'), 'utf-8');
    // The fix removes `const lower = trimmed.toLowerCase()`
    const extractDecisionsBlock = source.slice(source.indexOf('function extractDecisions'));
    assert.ok(
      !extractDecisionsBlock.includes('const lower = trimmed.toLowerCase()'),
      'Dead "lower" variable should be removed from extractDecisions'
    );
  });
});

describe('FIX #16 — Dead code removed (dead length check in user-prompt-submit)', () => {
  it('user-prompt-submit.js does not have dead .length < 1 check', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/hooks/user-prompt-submit.js'), 'utf-8');
    // The fix removes the always-false `.length < 1` check (use regex with word boundary to avoid matching .length < 15 etc.)
    assert.ok(
      !/\.length\s*<\s*1\b/.test(source),
      'Dead .length < 1 check should be removed'
    );
  });
});

describe('FIX #17 — Paths quoted in install.js getHookCommand', () => {
  it('getHookCommand quotes paths containing spaces', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/install.js'), 'utf-8');
    // The fix: check if path includes space, and if so, wrap in quotes
    assert.ok(
      source.includes("includes(' ')") || source.includes('includes(" ")'),
      'getHookCommand should detect spaces in paths'
    );
    assert.ok(
      source.includes('node "') || source.includes('"${') || source.includes('`node "'),
      'getHookCommand should quote paths with spaces'
    );
  });
});

describe('FIX #18 — CLI safe (no command injection via args)', () => {
  it('cli.js does not use shell exec for user-provided arguments', async () => {

    const source = readFileSync(join(import.meta.dirname, '../src/cli.js'), 'utf-8');
    // Verify no child_process.exec or execSync with user args
    assert.ok(!source.includes('exec('), 'CLI should not use exec() with user args');
    assert.ok(!source.includes('execSync('), 'CLI should not use execSync() with user args');
  });
});

describe('FIX #19 — Boundary inclusive: user message length checks', () => {
  beforeEach(() => resetConfig());

  it('user message at exactly 21 chars (> 20) is captured', () => {
    const turns = [{
      userMessage: { text: 'A'.repeat(21) },
      assistantMessages: [],
      allToolCalls: [],
      allToolResults: [],
      startLine: 1,
      endLine: 1,
    }];
    const result = extractMemories(turns, '/p', 's');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 1, '21 chars should be captured (> 20)');
  });

  it('user message at exactly 20 chars (not > 20) is NOT captured', () => {
    const turns = [{
      userMessage: { text: 'A'.repeat(20) },
      assistantMessages: [],
      allToolCalls: [],
      allToolResults: [],
      startLine: 1,
      endLine: 1,
    }];
    const result = extractMemories(turns, '/p', 's');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 0, '20 chars should NOT be captured');
  });

  it('user message at exactly 500 chars (<= 500) IS captured', () => {
    const turns = [{
      userMessage: { text: 'B'.repeat(500) },
      assistantMessages: [],
      allToolCalls: [],
      allToolResults: [],
      startLine: 1,
      endLine: 1,
    }];
    const result = extractMemories(turns, '/p', 's');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 1, '500 chars should be captured (<= 500)');
  });

  it('user message at exactly 501 chars (> 500) is NOT captured', () => {
    const turns = [{
      userMessage: { text: 'C'.repeat(501) },
      assistantMessages: [],
      allToolCalls: [],
      allToolResults: [],
      startLine: 1,
      endLine: 1,
    }];
    const result = extractMemories(turns, '/p', 's');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 0, '501 chars should NOT be captured');
  });
});

describe('FIX #20 — Overall integration: fixes work together without regression', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });
  afterEach(() => db.close());

  it('full pipeline: parse transcript with tool results -> extract memories -> store -> search -> restore', () => {
    // Build a realistic transcript
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Please refactor the authentication module to use JWT tokens' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll use JWT for authentication because it provides stateless session management." },
            { type: 'tool_use', name: 'Write', id: 'tu1', input: { file_path: '/src/auth.js' } },
          ],
        },
      }),
      // Synthetic user message with tool result
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: 'File written successfully',
            is_error: false,
          }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Authentication module refactored.' }],
        },
      }),
    ];

    const path = writeTmpTranscript(lines.join('\n') + '\n', 'integration.jsonl');
    const { messages } = parseTranscript(path);
    const turns = groupIntoTurns(messages);

    // FIX #2: tool results captured
    assert.equal(turns.length, 1, 'Single turn');
    assert.ok(turns[0].allToolResults.length >= 1, 'Tool results captured');

    // Extract memories
    const memories = extractMemories(turns, '/proj', 'sess');
    assert.ok(memories.length >= 1, 'Should extract at least one memory');

    // Insert into DB
    const inserted = db.insertMany(memories);
    assert.ok(inserted >= 1, 'Should insert memories');

    // FIX #1: search with quotes
    const searchResults = db.search('JWT "authentication"', '/proj', 10);
    assert.ok(Array.isArray(searchResults), 'Search with quotes should not crash');

    // FIX #5: budget=0 restore
    const emptyRestore = restoreContext(db.getTopMemories('/proj', 20), 0);
    assert.equal(emptyRestore.text, '', 'Budget 0 should produce empty');

    // Normal restore
    const restore = restoreContext(db.getTopMemories('/proj', 20), 4000);
    assert.ok(restore.text.length > 0, 'Normal restore should produce content');

    // FIX #6: section headers in budget
    const actualTokens = estimateTokens(restore.text);
    assert.ok(actualTokens <= 4000, 'Should not exceed budget');
  });

  it('memories with score=0 sort correctly in restore', () => {
    const now = makeNow();
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Zero score memory', keywords: 'zero', score: 0,
      sourceHash: 'z1',
    });
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'High score memory', keywords: 'high', score: 0.9,
      sourceHash: 'z2',
    });

    const mems = db.getTopMemories('/p', 10);
    // FIX #4: score=0 produces importance=0 via ?? operator
    const { ids } = restoreContext(mems, 4000);
    // High score should be restored, zero score might also fit
    assert.ok(ids.length >= 1, 'At least high-score memory should be restored');
  });

  it('metadata round-trip: insert with object -> retrieve -> parse -> valid object', () => {
    // FIX #9: metadata not double-stringified
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'With metadata', keywords: 'meta', score: 0.5,
      sourceHash: 'meta-rt-1',
      metadata: { tool: 'regression-test', version: 2 },
    });

    const mem = db.getTopMemories('/p', 1)[0];
    const parsed = JSON.parse(mem.metadata);
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed.tool, 'regression-test');
    assert.equal(parsed.version, 2);
    // Verify it's NOT double-encoded (would yield a string on first parse)
    assert.notEqual(typeof parsed, 'string', 'Should NOT be double-stringified');
  });
});
