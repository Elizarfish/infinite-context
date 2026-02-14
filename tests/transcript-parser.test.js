import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';

const TMP_DIR = join(tmpdir(), 'ic-test-' + Date.now());
mkdirSync(TMP_DIR, { recursive: true });

function writeTempTranscript(lines) {
  const path = join(TMP_DIR, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

describe('parseTranscript', () => {
  it('should parse user and assistant messages', () => {
    const path = writeTempTranscript([
      { type: 'user', message: { role: 'user', content: 'Hello' }, uuid: 'u1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }, uuid: 'a1' },
    ]);

    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].text, 'Hello');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].text, 'Hi there!');
    assert.equal(lastLine, 2);
  });

  it('should extract tool calls', () => {
    const path = writeTempTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', id: 'tu1', input: { file_path: '/a/b.js', content: 'test' } },
        { type: 'text', text: 'Writing file...' },
      ] } },
    ]);

    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].toolCalls.length, 1);
    assert.equal(messages[0].toolCalls[0].name, 'Write');
    assert.equal(messages[0].toolCalls[0].input.file_path, '/a/b.js');
    assert.equal(messages[0].text, 'Writing file...');
  });

  it('should extract thinking blocks', () => {
    const path = writeTempTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Let me think about the architecture...' },
        { type: 'text', text: 'Here is my plan.' },
      ] } },
    ]);

    const { messages } = parseTranscript(path);
    assert.equal(messages[0].thinking, 'Let me think about the architecture...');
    assert.equal(messages[0].text, 'Here is my plan.');
  });

  it('should support incremental parsing from offset', () => {
    const path = writeTempTranscript([
      { type: 'user', message: { role: 'user', content: 'First' }, uuid: 'u1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] } },
      { type: 'user', message: { role: 'user', content: 'Second' }, uuid: 'u2' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Response 2' }] } },
    ]);

    // Parse from line 2 (skip first two)
    const { messages, lastLine } = parseTranscript(path, 2);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, 'Second');
    assert.equal(messages[1].text, 'Response 2');
    assert.equal(lastLine, 4);
  });

  it('should skip malformed lines gracefully', () => {
    const path = join(TMP_DIR, 'malformed.jsonl');
    writeFileSync(path, '{"type":"user","message":{"role":"user","content":"OK"}}\nnot json at all\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fine"}]}}\n');

    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 2);
  });

  it('should handle non-existent file', () => {
    const { messages, lastLine } = parseTranscript('/nonexistent/path.jsonl');
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should skip system and non-message entries', () => {
    const path = writeTempTranscript([
      { type: 'system', subtype: 'init', message: { role: 'system', content: 'System prompt' } },
      { type: 'progress', progress: 0.5 },
      { type: 'user', message: { role: 'user', content: 'Real message' } },
    ]);

    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'Real message');
  });
});

describe('groupIntoTurns', () => {
  it('should group user + assistant into turns', () => {
    const messages = [
      { role: 'user', text: 'Question 1', toolCalls: [], toolResults: [], lineNum: 1 },
      { role: 'assistant', text: 'Answer 1', thinking: '', toolCalls: [{ name: 'Bash', input: { command: 'ls' } }], toolResults: [], lineNum: 2 },
      { role: 'user', text: 'Question 2', toolCalls: [], toolResults: [], lineNum: 3 },
      { role: 'assistant', text: 'Answer 2', thinking: '', toolCalls: [], toolResults: [], lineNum: 4 },
    ];

    const turns = groupIntoTurns(messages);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].userMessage.text, 'Question 1');
    assert.equal(turns[0].assistantMessages.length, 1);
    assert.equal(turns[0].allToolCalls.length, 1);
    assert.equal(turns[1].userMessage.text, 'Question 2');
  });

  it('should handle multiple assistant messages per turn', () => {
    const messages = [
      { role: 'user', text: 'Do something', toolCalls: [], toolResults: [], lineNum: 1 },
      { role: 'assistant', text: 'Part 1', thinking: '', toolCalls: [{ name: 'Read' }], toolResults: [], lineNum: 2 },
      { role: 'assistant', text: 'Part 2', thinking: '', toolCalls: [{ name: 'Write' }], toolResults: [], lineNum: 3 },
    ];

    const turns = groupIntoTurns(messages);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].assistantMessages.length, 2);
    assert.equal(turns[0].allToolCalls.length, 2);
  });
});
