#!/usr/bin/env node
import { readStdin, openDb, writeHookOutput, log, runHook } from './common.js';
import { restoreContext } from '../core/restorer.js';
import { loadConfig } from '../core/config.js';

runHook('session-start', async () => {
  const input = await readStdin();
  if (!input) return;

  const { session_id: sessionId, cwd, source } = input;
  if (!cwd) return;

  if (source && !['compact', 'clear', 'resume', 'startup'].includes(source)) return;

  const db = openDb();
  if (!db) return;

  try {
    if (sessionId) {
      db.upsertSession(sessionId, cwd);
    }

    const memories = db.getTopMemories(cwd);
    if (!memories || memories.length === 0) {
      log('session-start: no memories for this project');
      return;
    }

    // Use reduced budget after compaction to avoid re-bloating context
    const cfg = loadConfig();
    const budget = (source === 'compact')
      ? Math.min(cfg.maxRestoreTokens, 2000)
      : cfg.maxRestoreTokens;

    const { text, ids } = restoreContext(memories, budget);
    if (!text) return;

    db.touchMemories(ids);

    log(`session-start: restored ${ids.length} memories for ${cwd} (source=${source || 'unknown'}, budget=${budget})`);
    writeHookOutput('SessionStart', text);
  } finally {
    db.close();
  }
});
