#!/usr/bin/env node
import { readStdin, openDb, writeHookOutput, log, runHook } from './common.js';
import { extractKeywords } from '../core/scorer.js';
import { recallForPrompt } from '../core/restorer.js';
import { loadConfig } from '../core/config.js';

runHook('user-prompt-submit', async () => {
  const input = await readStdin();
  if (!input) return;

  const { cwd, prompt } = input;
  if (!cwd || !prompt) return;

  const keywords = extractKeywords(prompt);
  if (!keywords) return;

  const db = openDb();
  if (!db) return;

  try {
    const cfg = loadConfig();
    const results = db.search(keywords, cwd, cfg.maxPromptRecallResults);

    if (!results || results.length === 0) return;

    const { text, ids } = recallForPrompt(results);
    if (!text) return;

    db.touchMemories(ids);

    log(`user-prompt-submit: recalled ${ids.length} memories for keywords: ${keywords.split(' ').slice(0, 5).join(', ')}`);
    writeHookOutput('UserPromptSubmit', text);
  } finally {
    db.close();
  }
});
