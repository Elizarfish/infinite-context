#!/usr/bin/env node
import { readStdin, openDb, writeHookOutput, log, runHook } from './common.js';
import { extractKeywords, estimateTokens } from '../core/scorer.js';
import { recallForPrompt } from '../core/restorer.js';
import { loadConfig } from '../core/config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.claude', 'infinite-context');
const STATE_FILE = join(STATE_DIR, 'prompt-state.json');

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return {};
}

function saveState(state) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch {}
}

runHook('user-prompt-submit', async () => {
  const input = await readStdin();
  if (!input) return;

  const { cwd, prompt, session_id: sessionId } = input;
  if (!cwd || !prompt) return;

  // Skip very short prompts and system-like messages
  if (prompt.length < 15) return;
  if (/^<[a-z]/i.test(prompt.trim())) return;
  if (/<task-notification>/i.test(prompt)) return;

  const keywords = extractKeywords(prompt);
  if (!keywords || keywords.split(' ').length < 2) return;

  // Rate limit: max 1 recall per 60 seconds per session to avoid context bloat
  const state = loadState();
  const stateKey = sessionId || cwd;
  const now = Date.now();
  const lastRecall = state[stateKey] || 0;
  if (now - lastRecall < 60000) {
    log('user-prompt-submit: skipping (rate limited, <60s since last recall)');
    return;
  }

  const db = openDb();
  if (!db) return;

  try {
    const cfg = loadConfig();
    const maxResults = Math.min(cfg.maxPromptRecallResults, 3);
    const results = db.search(keywords, cwd, maxResults);

    if (!results || results.length === 0) return;

    const { text, ids } = recallForPrompt(results);
    if (!text) return;

    // Cap total output to ~500 tokens to minimize context bloat
    const tokens = estimateTokens(text);
    if (tokens > 600) {
      const lines = text.split('\n');
      let trimmed = lines[0];
      let t = estimateTokens(trimmed);
      for (let i = 1; i < lines.length && t < 500; i++) {
        trimmed += '\n' + lines[i];
        t = estimateTokens(trimmed);
      }
      db.touchMemories(ids);
      state[stateKey] = now;
      saveState(state);
      log(`user-prompt-submit: recalled ${ids.length} memories (trimmed to ~500 tokens)`);
      writeHookOutput('UserPromptSubmit', trimmed);
      return;
    }

    db.touchMemories(ids);
    state[stateKey] = now;
    saveState(state);

    log(`user-prompt-submit: recalled ${ids.length} memories for keywords: ${keywords.split(' ').slice(0, 5).join(', ')}`);
    writeHookOutput('UserPromptSubmit', text);
  } finally {
    db.close();
  }
});
