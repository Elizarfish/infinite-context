#!/usr/bin/env node
import { readStdin, openDb, writeHookOutput, log, runHook } from './common.js';
import { restoreContext } from '../core/restorer.js';
import { loadConfig } from '../core/config.js';

runHook('subagent-start', async () => {
  const input = await readStdin();
  if (!input) return;

  const { cwd, agent_id: agentId, agent_type: agentType } = input;
  if (!cwd) return;

  const db = openDb();
  if (!db) return;

  try {
    const cfg = loadConfig();
    const budget = Math.floor(cfg.maxRestoreTokens * 0.6);
    const memories = db.getTopMemories(cwd, Math.floor(cfg.maxMemoriesPerRestore * 0.6));

    if (!memories || memories.length === 0) {
      log(`subagent-start: no memories for ${agentType || 'unknown'} agent`);
      return;
    }

    const { text, ids } = restoreContext(memories, budget);
    if (!text) return;

    db.touchMemories(ids);
    log(`subagent-start: injected ${ids.length} memories into ${agentType || 'unknown'} agent (${agentId || 'no-id'})`);
    writeHookOutput('SubagentStart', text);
  } finally {
    db.close();
  }
});
