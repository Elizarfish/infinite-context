#!/usr/bin/env node
import { Store } from './db/store.js';
import { install, uninstall } from './install.js';
import { loadConfig, DATA_DIR } from './core/config.js';

const [,, command, ...args] = process.argv;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function doStatus() {
  const db = new Store().open();
  try {
    const stats = db.getStats();
    console.log('\n  Infinite Context — Status\n');
    console.log(`  Database:    ${loadConfig().dbPath}`);
    console.log(`  Size:        ${formatBytes(stats.dbSize)}`);
    console.log(`  Total:       ${stats.total} memories`);
    console.log('');

    if (stats.byProject.length > 0) {
      console.log('  By project:');
      for (const { project, cnt } of stats.byProject) {
        const short = project.length > 50 ? '...' + project.slice(-47) : project;
        console.log(`    ${short}: ${cnt}`);
      }
      console.log('');
    }

    if (stats.sessions.length > 0) {
      console.log(`  Sessions: ${stats.sessions.length}`);
      for (const s of stats.sessions.slice(0, 5)) {
        const ended = s.ended_at ? ` → ${s.ended_at}` : ' (active)';
        console.log(`    ${s.session_id.slice(0, 8)}... | ${s.started_at}${ended} | ${s.memories_created} memories, ${s.compactions} compactions`);
      }
      console.log('');
    }
  } finally {
    db.close();
  }
}

function doSearch(query) {
  if (!query) {
    console.error('Usage: ic search <keywords>');
    process.exit(1);
  }

  const projIdx = args.indexOf('--project');
  const project = (projIdx !== -1 && args[projIdx + 1]) ? args[projIdx + 1] : null;
  const db = new Store().open();
  try {
    const results = db.search(query, project, 20);
    if (results.length === 0) {
      console.log('No matches found.');
      return;
    }
    console.log(`\n  Found ${results.length} memories:\n`);
    for (const m of results) {
      const proj = m.project.length > 30 ? '...' + m.project.slice(-27) : m.project;
      console.log(`  [${m.category}] score=${m.score.toFixed(2)} | ${proj}`);
      console.log(`    ${m.content.slice(0, 200)}`);
      console.log(`    created: ${m.created_at} | accessed: ${m.access_count}x`);
      console.log('');
    }
  } finally {
    db.close();
  }
}

function doExport() {
  const projIdx = args.indexOf('--project');
  const project = (projIdx !== -1 && args[projIdx + 1]) ? args[projIdx + 1] : null;
  const db = new Store().open();
  try {
    const memories = db.exportAll(project);
    console.log(JSON.stringify(memories, null, 2));
  } finally {
    db.close();
  }
}

function doPrune() {
  const dryRun = args.includes('--dry-run');
  const olderThanIdx = args.indexOf('--older-than');
  const belowScoreIdx = args.indexOf('--below-score');

  const db = new Store().open();
  try {
    let totalPruned = 0;

    if (olderThanIdx !== -1) {
      const val = args[olderThanIdx + 1] || '30';
      const days = parseInt(val, 10);
      if (dryRun) {
        const count = db.countOld(days);
        console.log(`Would prune ${count} memories older than ${days} days (never accessed).`);
      } else {
        totalPruned += db.pruneOld(days);
      }
    }

    if (belowScoreIdx !== -1) {
      const threshold = parseFloat(args[belowScoreIdx + 1] || '0.1');
      if (dryRun) {
        const count = db.countBelowScore(threshold);
        console.log(`Would prune ${count} memories with score below ${threshold}.`);
      } else {
        totalPruned += db.pruneBelowScore(threshold);
      }
    }

    if (olderThanIdx === -1 && belowScoreIdx === -1) {
      if (dryRun) {
        const cfg = loadConfig();
        const count = db.countBelowScore(cfg.pruneThreshold);
        console.log(`Would prune ${count} memories below score ${cfg.pruneThreshold}.`);
      } else {
        totalPruned = db.decayAndPrune();
      }
    }

    if (!dryRun) {
      console.log(`Pruned ${totalPruned} memories.`);
    }
  } finally {
    db.close();
  }
}

function doConfig() {
  const cfg = loadConfig();
  if (args.length === 0) {
    console.log('\n  Configuration:\n');
    const show = { ...cfg };
    show.stopwords = `${cfg.stopwords.size} words`;
    console.log(JSON.stringify(show, null, 2));
  } else {
    console.log(`  ${args[0]}: ${JSON.stringify(cfg[args[0]])}`);
  }
}

async function doDashboard() {
  const portIdx = args.indexOf('--port');
  const port = (portIdx !== -1 && args[portIdx + 1]) ? parseInt(args[portIdx + 1], 10) : 3333;
  const { startServer } = await import('./web/server.js');
  startServer(port);
}

function showHelp() {
  console.log(`
  infinite-context (ic) — Infinite context for Claude Code

  Commands:
    install              Install hooks into Claude Code settings
    uninstall            Remove hooks (data preserved)
    status               Show database statistics
    search <keywords>    Search memories [--project <path>]
    export               Export all memories as JSON [--project <path>]
    prune                Decay and prune old memories
                         [--older-than <days>] [--below-score <n>] [--dry-run]
    dashboard            Start web dashboard [--port 3333]
    config               Show configuration
    help                 Show this help

  Data: ${DATA_DIR}
`);
}

switch (command) {
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': doStatus(); break;
  case 'search': {
    const projIdx = args.indexOf('--project');
    const searchArgs = projIdx !== -1 ? [...args.slice(0, projIdx), ...args.slice(projIdx + 2)] : [...args];
    doSearch(searchArgs.join(' '));
    break;
  }
  case 'export': doExport(); break;
  case 'prune': doPrune(); break;
  case 'dashboard': case 'web': doDashboard(); break;
  case 'config': doConfig(); break;
  case 'help': case '--help': case '-h': case undefined: showHelp(); break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}
