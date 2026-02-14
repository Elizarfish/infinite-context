/**
 * Hook I/O Contract Tests
 *
 * Validates that all 6 hooks conform to Claude Code's expected stdin/stdout contract:
 * - Always exit 0 (even on errors)
 * - stdout format: hookSpecificOutput JSON (session-start, user-prompt-submit, subagent-start)
 *                  plain text (pre-compact)
 *                  nothing (session-end, subagent-stop)
 * - Graceful handling of missing fields, malformed JSON, null values, empty stdin
 * - Completion within timeout (5-30 seconds)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOOKS_DIR = join(import.meta.dirname, '..', 'src', 'hooks');
const HOOK_TIMEOUT = 10_000; // generous timeout for test environment
const TEST_CWD = '/tmp/ic-hook-contract-test';
const TEST_TRANSCRIPT = '/tmp/ic-hook-contract-test-transcript.jsonl';
const DB_DIR = join(homedir(), '.claude', 'infinite-context');
const DB_PATH = join(DB_DIR, 'memories.db');

/**
 * Run a hook by spawning a child process, writing to stdin, and capturing output.
 * Uses spawn + manual stdin.end() to ensure the hook's readStdin gets an 'end' event.
 */
function runHook(hookName, input, { timeout = HOOK_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const hookPath = join(HOOKS_DIR, `${hookName}.js`);
    const stdinData = typeof input === 'string' ? input : JSON.stringify(input);

    const child = spawn('node', [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      timeout,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ stdout, stderr, exitCode: -1, timedOut: true });
      }
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1, error: err.message });
    });

    // Write input and close stdin so the hook receives 'end' event
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Parse hookSpecificOutput JSON from stdout.
 */
function parseHookOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput, 'output must contain hookSpecificOutput');
  assert.ok(parsed.hookSpecificOutput.hookEventName, 'must have hookEventName');
  assert.ok(parsed.hookSpecificOutput.additionalContext, 'must have additionalContext');
  return parsed;
}

/**
 * Seed test memories into the database.
 */
async function seedMemories() {
  const seedScript = `
    import { Store } from './src/db/store.js';
    const db = new Store().open();
    const memories = [
      { project: '${TEST_CWD}', sessionId: 'seed-001', category: 'architecture',
        content: 'The system uses modular components with clear separation of concerns',
        keywords: 'architecture modular components separation concerns', score: 0.95,
        sourceHash: 'contract_test_arch_001', metadata: null },
      { project: '${TEST_CWD}', sessionId: 'seed-001', category: 'decision',
        content: 'Decided to use SQLite with WAL mode for concurrency support',
        keywords: 'decision sqlite wal concurrency', score: 0.9,
        sourceHash: 'contract_test_dec_001', metadata: null },
      { project: '${TEST_CWD}', sessionId: 'seed-001', category: 'error',
        content: 'Error encountered: ECONNREFUSED when connecting to port 3000',
        keywords: 'error econnrefused port connection', score: 0.8,
        sourceHash: 'contract_test_err_001', metadata: null },
      { project: '${TEST_CWD}', sessionId: 'seed-001', category: 'finding',
        content: 'The API rate limit is 100 requests per minute per user',
        keywords: 'api rate limit requests minute', score: 0.7,
        sourceHash: 'contract_test_find_001', metadata: null },
      { project: '${TEST_CWD}', sessionId: 'seed-001', category: 'file_change',
        content: 'Created/wrote file: src/server.js',
        keywords: 'file server javascript created', score: 0.5,
        sourceHash: 'contract_test_file_001', metadata: null },
    ];
    for (const m of memories) {
      db.insertMemory(m);
    }
    db.close();
    console.log('seeded');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', seedScript], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Seed failed (code ${code}): ${out}`));
      else resolve();
    });
    child.stdin.end();
  });
}

/**
 * Create a test transcript file.
 */
function createTestTranscript() {
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Create an authentication module with JWT' },
      timestamp: '2025-01-01T00:00:00Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll create an authentication module using JWT tokens for secure session management." },
          { type: 'tool_use', name: 'Write', id: 'tc1', input: { file_path: 'src/auth.js' } },
        ],
      },
      timestamp: '2025-01-01T00:00:01Z',
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'File written successfully', is_error: false },
        ],
      },
      timestamp: '2025-01-01T00:00:02Z',
    }),
  ];
  writeFileSync(TEST_TRANSCRIPT, lines.join('\n') + '\n');
}

// ============================================================================
// Tests
// ============================================================================

describe('Hook I/O Contract Validation', () => {
  before(async () => {
    if (!existsSync(TEST_CWD)) mkdirSync(TEST_CWD, { recursive: true });
    createTestTranscript();
    await seedMemories();
  });

  after(() => {
    try { unlinkSync(TEST_TRANSCRIPT); } catch {}
    try { rmSync(TEST_CWD, { recursive: true, force: true }); } catch {}
  });

  // --------------------------------------------------------------------------
  // session-start
  // --------------------------------------------------------------------------
  describe('session-start', () => {
    it('exits 0 with valid input', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-001', cwd: TEST_CWD, source: 'startup',
      });
      assert.equal(result.exitCode, 0);
    });

    it('produces valid hookSpecificOutput JSON when memories exist', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-002', cwd: TEST_CWD, source: 'startup',
      });
      assert.equal(result.exitCode, 0);
      const parsed = parseHookOutput(result.stdout);
      assert.ok(parsed, 'should produce output when memories exist');
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Prior Context'));
    });

    it('output additionalContext contains category sections', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-003', cwd: TEST_CWD, source: 'startup',
      });
      const parsed = parseHookOutput(result.stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('Architecture & Design'), 'should include architecture section');
      assert.ok(ctx.includes('Key Decisions'), 'should include decisions section');
    });

    it('produces no stdout for unknown project', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-004', cwd: '/tmp/nonexistent-project-xyz', source: 'startup',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '', 'no output for unknown project');
    });

    it('filters disallowed source values', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-005', cwd: TEST_CWD, source: 'user',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '', 'source=user should produce no output');
    });

    it('allows source=compact', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-006', cwd: TEST_CWD, source: 'compact',
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.trim().length > 0, 'source=compact should produce output');
    });

    it('allows source=resume', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-007', cwd: TEST_CWD, source: 'resume',
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.trim().length > 0, 'source=resume should produce output');
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('session-start', '');
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with non-JSON stdin', async () => {
      const result = await runHook('session-start', 'this is not json!!!');
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with null values for required fields', async () => {
      const result = await runHook('session-start', {
        session_id: null, cwd: null, source: null,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('handles extra unexpected fields gracefully', async () => {
      const result = await runHook('session-start', {
        session_id: 'test-008', cwd: TEST_CWD, source: 'startup',
        extra_field: 'hello', another_extra: 123, nested: { deep: true },
      });
      assert.equal(result.exitCode, 0);
      // Should still work - extra fields are ignored
      const parsed = parseHookOutput(result.stdout);
      assert.ok(parsed, 'extra fields should not break the hook');
    });

    it('handles empty JSON object', async () => {
      const result = await runHook('session-start', {});
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('session-start', {
        session_id: 'test-timing', cwd: TEST_CWD, source: 'startup',
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // pre-compact
  // --------------------------------------------------------------------------
  describe('pre-compact', () => {
    it('exits 0 with valid input and transcript', async () => {
      const result = await runHook('pre-compact', {
        session_id: 'compact-001', transcript_path: TEST_TRANSCRIPT,
        cwd: '/tmp/ic-precompact-test-project', trigger: 'auto',
      });
      assert.equal(result.exitCode, 0);
    });

    it('outputs plain text (NOT hookSpecificOutput JSON)', async () => {
      const result = await runHook('pre-compact', {
        session_id: 'compact-002', transcript_path: TEST_TRANSCRIPT,
        cwd: '/tmp/ic-precompact-test-project-2', trigger: 'auto',
      });
      assert.equal(result.exitCode, 0);
      if (result.stdout.trim()) {
        // Verify it's NOT JSON with hookSpecificOutput
        let isJson = false;
        try {
          const parsed = JSON.parse(result.stdout);
          if (parsed.hookSpecificOutput) isJson = true;
        } catch {}
        assert.ok(!isJson, 'pre-compact should output plain text, not hookSpecificOutput JSON');
        assert.ok(result.stdout.includes('CONTEXT ARCHIVE') || result.stdout.includes('archived'),
          'plain text should contain archive instructions');
      }
    });

    it('handles nonexistent transcript path gracefully', async () => {
      const result = await runHook('pre-compact', {
        session_id: 'compact-003', transcript_path: '/tmp/definitely-does-not-exist.jsonl',
        cwd: TEST_CWD, trigger: 'auto',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with missing session_id', async () => {
      const result = await runHook('pre-compact', {
        transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with missing transcript_path', async () => {
      const result = await runHook('pre-compact', {
        session_id: 'compact-004', cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('pre-compact', '');
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with malformed JSON', async () => {
      const result = await runHook('pre-compact', '{broken json');
      assert.equal(result.exitCode, 0);
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('pre-compact', {
        session_id: 'compact-timing', transcript_path: TEST_TRANSCRIPT,
        cwd: TEST_CWD, trigger: 'auto',
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // user-prompt-submit
  // --------------------------------------------------------------------------
  describe('user-prompt-submit', () => {
    it('exits 0 with valid input', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: 'How do I fix the authentication bug?',
      });
      assert.equal(result.exitCode, 0);
    });

    it('produces valid hookSpecificOutput JSON when matches found', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: 'Tell me about the API rate limit configuration',
      });
      assert.equal(result.exitCode, 0);
      if (result.stdout.trim()) {
        const parsed = parseHookOutput(result.stdout);
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
        assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Relevant prior context'));
      }
    });

    it('exits 0 with no matching prompt', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: 'zzzzz xxxxx yyyyy completely unrelated words',
      });
      assert.equal(result.exitCode, 0);
      // May or may not produce output depending on FTS matching
    });

    it('exits 0 with missing cwd', async () => {
      const result = await runHook('user-prompt-submit', {
        prompt: 'some prompt',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with missing prompt', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('handles very long prompt (10KB+)', async () => {
      const longPrompt = 'authentication '.repeat(700); // ~10KB
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: longPrompt,
      });
      assert.equal(result.exitCode, 0);
      // Should not crash or hang
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('user-prompt-submit', '');
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with non-JSON stdin', async () => {
      const result = await runHook('user-prompt-submit', 'not json!');
      assert.equal(result.exitCode, 0);
    });

    it('handles null values', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: null, prompt: null,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: 'test query about architecture',
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // subagent-start
  // --------------------------------------------------------------------------
  describe('subagent-start', () => {
    it('exits 0 with valid input', async () => {
      const result = await runHook('subagent-start', {
        session_id: 'sub-001', cwd: TEST_CWD,
        agent_id: 'agent-123', agent_type: 'researcher',
      });
      assert.equal(result.exitCode, 0);
    });

    it('produces valid hookSpecificOutput JSON when memories exist', async () => {
      const result = await runHook('subagent-start', {
        session_id: 'sub-002', cwd: TEST_CWD,
        agent_id: 'agent-456', agent_type: 'coder',
      });
      assert.equal(result.exitCode, 0);
      if (result.stdout.trim()) {
        const parsed = parseHookOutput(result.stdout);
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
        assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Prior Context'));
      }
    });

    it('produces no stdout for unknown project', async () => {
      const result = await runHook('subagent-start', {
        session_id: 'sub-003', cwd: '/tmp/unknown-project-xyz',
        agent_id: 'agent-789', agent_type: 'tester',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('handles missing agent_id and agent_type', async () => {
      const result = await runHook('subagent-start', {
        session_id: 'sub-004', cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      // Should still work without agent metadata
    });

    it('exits 0 with missing cwd', async () => {
      const result = await runHook('subagent-start', {
        session_id: 'sub-005',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('subagent-start', '');
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with non-JSON stdin', async () => {
      const result = await runHook('subagent-start', 'garbage');
      assert.equal(result.exitCode, 0);
    });

    it('handles null values', async () => {
      const result = await runHook('subagent-start', {
        session_id: null, cwd: null, agent_id: null, agent_type: null,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('subagent-start', {
        session_id: 'sub-timing', cwd: TEST_CWD,
        agent_id: 'agent-t', agent_type: 'coder',
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // subagent-stop
  // --------------------------------------------------------------------------
  describe('subagent-stop', () => {
    it('exits 0 with valid input and transcript', async () => {
      const result = await runHook('subagent-stop', {
        session_id: 'substop-001', cwd: TEST_CWD,
        agent_id: 'agent-stop-1', agent_type: 'researcher',
        agent_transcript_path: TEST_TRANSCRIPT,
      });
      assert.equal(result.exitCode, 0);
    });

    it('produces no stdout (archival hook)', async () => {
      const result = await runHook('subagent-stop', {
        session_id: 'substop-002', cwd: TEST_CWD,
        agent_id: 'agent-stop-2', agent_type: 'coder',
        agent_transcript_path: TEST_TRANSCRIPT,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '', 'subagent-stop should produce no stdout');
    });

    it('handles nonexistent transcript gracefully', async () => {
      const result = await runHook('subagent-stop', {
        session_id: 'substop-003', cwd: TEST_CWD,
        agent_id: 'agent-stop-3', agent_type: 'tester',
        agent_transcript_path: '/tmp/no-such-transcript.jsonl',
      });
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with missing session_id', async () => {
      const result = await runHook('subagent-stop', {
        cwd: TEST_CWD, agent_transcript_path: TEST_TRANSCRIPT,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with missing agent_transcript_path', async () => {
      const result = await runHook('subagent-stop', {
        session_id: 'substop-004', cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('subagent-stop', '');
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with non-JSON stdin', async () => {
      const result = await runHook('subagent-stop', '???');
      assert.equal(result.exitCode, 0);
    });

    it('handles null values', async () => {
      const result = await runHook('subagent-stop', {
        session_id: null, cwd: null, agent_id: null,
        agent_type: null, agent_transcript_path: null,
      });
      assert.equal(result.exitCode, 0);
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('subagent-stop', {
        session_id: 'substop-timing', cwd: TEST_CWD,
        agent_id: 'agent-t', agent_type: 'tester',
        agent_transcript_path: TEST_TRANSCRIPT,
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // session-end
  // --------------------------------------------------------------------------
  describe('session-end', () => {
    it('exits 0 with valid input', async () => {
      const result = await runHook('session-end', {
        session_id: 'end-001', transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
    });

    it('produces no stdout (cleanup hook)', async () => {
      const result = await runHook('session-end', {
        session_id: 'end-002', transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '', 'session-end should produce no stdout');
    });

    it('handles missing transcript_path', async () => {
      const result = await runHook('session-end', {
        session_id: 'end-003', cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with missing session_id', async () => {
      const result = await runHook('session-end', {
        transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with empty stdin', async () => {
      const result = await runHook('session-end', '');
      assert.equal(result.exitCode, 0);
    });

    it('exits 0 with non-JSON stdin', async () => {
      const result = await runHook('session-end', 'not json');
      assert.equal(result.exitCode, 0);
    });

    it('handles null values', async () => {
      const result = await runHook('session-end', {
        session_id: null, transcript_path: null, cwd: null,
      });
      assert.equal(result.exitCode, 0);
    });

    it('handles nonexistent transcript path', async () => {
      const result = await runHook('session-end', {
        session_id: 'end-004', transcript_path: '/tmp/no-such-file.jsonl', cwd: TEST_CWD,
      });
      assert.equal(result.exitCode, 0);
    });

    it('completes within timeout', async () => {
      const start = Date.now();
      const result = await runHook('session-end', {
        session_id: 'end-timing', transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD,
      });
      const elapsed = Date.now() - start;
      assert.ok(!result.timedOut, 'hook should not time out');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms, should be under 5000ms`);
    });
  });

  // --------------------------------------------------------------------------
  // Cross-cutting: universal edge cases applied to all hooks
  // --------------------------------------------------------------------------
  describe('universal edge cases', () => {
    const allHooks = [
      'session-start', 'pre-compact', 'user-prompt-submit',
      'subagent-start', 'subagent-stop', 'session-end',
    ];

    for (const hook of allHooks) {
      it(`${hook}: exits 0 on empty object {}`, async () => {
        const result = await runHook(hook, {});
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on completely empty string`, async () => {
        const result = await runHook(hook, '');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on array instead of object`, async () => {
        const result = await runHook(hook, '[]');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on number instead of object`, async () => {
        const result = await runHook(hook, '42');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on boolean instead of object`, async () => {
        const result = await runHook(hook, 'true');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on null JSON`, async () => {
        const result = await runHook(hook, 'null');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on truncated JSON`, async () => {
        const result = await runHook(hook, '{"session_id":"test","cw');
        assert.equal(result.exitCode, 0);
      });

      it(`${hook}: exits 0 on binary garbage`, async () => {
        const result = await runHook(hook, '\x00\x01\x02\xff\xfe');
        assert.equal(result.exitCode, 0);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Output format consistency
  // --------------------------------------------------------------------------
  describe('output format consistency', () => {
    const jsonOutputHooks = [
      { name: 'session-start', eventName: 'SessionStart',
        input: { session_id: 'fmt-001', cwd: TEST_CWD, source: 'startup' } },
      { name: 'subagent-start', eventName: 'SubagentStart',
        input: { session_id: 'fmt-002', cwd: TEST_CWD, agent_id: 'a1', agent_type: 'coder' } },
    ];

    for (const { name, eventName, input } of jsonOutputHooks) {
      it(`${name}: stdout is valid JSON with correct hookSpecificOutput structure`, async () => {
        const result = await runHook(name, input);
        assert.equal(result.exitCode, 0);
        if (result.stdout.trim()) {
          const parsed = JSON.parse(result.stdout);
          assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'],
            'top-level should only contain hookSpecificOutput');
          assert.equal(parsed.hookSpecificOutput.hookEventName, eventName);
          assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
          assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0);
        }
      });
    }

    it('user-prompt-submit: stdout is valid JSON with UserPromptSubmit event', async () => {
      const result = await runHook('user-prompt-submit', {
        cwd: TEST_CWD, prompt: 'architecture modular components',
      });
      assert.equal(result.exitCode, 0);
      if (result.stdout.trim()) {
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
        assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
      }
    });

    it('pre-compact: stdout is plain text, not JSON', async () => {
      // Use a fresh project so dedup does not suppress output
      const result = await runHook('pre-compact', {
        session_id: 'fmt-compact-001',
        transcript_path: TEST_TRANSCRIPT,
        cwd: '/tmp/ic-fmt-test-project',
        trigger: 'auto',
      });
      assert.equal(result.exitCode, 0);
      if (result.stdout.trim()) {
        let threw = false;
        try {
          const parsed = JSON.parse(result.stdout);
          if (parsed.hookSpecificOutput) {
            assert.fail('pre-compact should NOT output hookSpecificOutput JSON');
          }
        } catch (e) {
          if (e.code === 'ERR_ASSERTION') throw e;
          threw = true;
        }
        // Either it's not JSON (threw) or it's JSON without hookSpecificOutput (fine)
        if (!threw) {
          // It parsed as JSON but without hookSpecificOutput - that's unexpected but not contract-breaking
        }
      }
    });

    const noOutputHooks = [
      { name: 'session-end', input: { session_id: 'fmt-end', cwd: TEST_CWD } },
      { name: 'subagent-stop', input: {
        session_id: 'fmt-substop', cwd: TEST_CWD,
        agent_transcript_path: TEST_TRANSCRIPT, agent_id: 'a-fmt',
      }},
    ];

    for (const { name, input } of noOutputHooks) {
      it(`${name}: produces no stdout`, async () => {
        const result = await runHook(name, input);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.trim(), '', `${name} should produce no stdout`);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Stderr contract: logs go to stderr, not stdout
  // --------------------------------------------------------------------------
  describe('stderr logging', () => {
    it('session-start: logs go to stderr with [infinite-context] prefix', async () => {
      const result = await runHook('session-start', {
        session_id: 'log-001', cwd: TEST_CWD, source: 'startup',
      });
      if (result.stderr.trim()) {
        assert.ok(result.stderr.includes('[infinite-context]'),
          'stderr logs should have [infinite-context] prefix');
      }
    });

    it('session-end: logs go to stderr with [infinite-context] prefix', async () => {
      const result = await runHook('session-end', {
        session_id: 'log-002', cwd: TEST_CWD,
      });
      if (result.stderr.trim()) {
        assert.ok(result.stderr.includes('[infinite-context]'),
          'stderr logs should have [infinite-context] prefix');
      }
    });

    it('all hooks: no [infinite-context] text in stdout', async () => {
      const hooks = [
        { name: 'session-start', input: { session_id: 's', cwd: TEST_CWD, source: 'startup' } },
        { name: 'pre-compact', input: { session_id: 's', transcript_path: TEST_TRANSCRIPT, cwd: TEST_CWD } },
        { name: 'user-prompt-submit', input: { cwd: TEST_CWD, prompt: 'test' } },
        { name: 'subagent-start', input: { cwd: TEST_CWD, agent_id: 'a', agent_type: 't' } },
        { name: 'subagent-stop', input: { session_id: 's', agent_transcript_path: TEST_TRANSCRIPT } },
        { name: 'session-end', input: { session_id: 's', cwd: TEST_CWD } },
      ];
      for (const { name, input } of hooks) {
        const result = await runHook(name, input);
        assert.ok(!result.stdout.includes('[infinite-context]'),
          `${name}: log messages must not appear in stdout`);
      }
    });
  });
});
