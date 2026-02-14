import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Store } from '../db/store.js';
import { loadConfig } from '../core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf-8');

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    params[k] = v;
  }
  return params;
}

function readBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxSize) { req.destroy(); resolve({}); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

export function startServer(port = 3333) {
  let db;
  try {
    db = new Store().open();
  } catch (err) {
    console.error(`Cannot open database: ${err.message}`);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = req.url;
    const method = req.method;
    const path = url.split('?')[0];
    const query = parseQuery(url);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(INDEX_HTML);
        return;
      }

      if (path === '/api/stats' && method === 'GET') {
        const stats = db.getStats();
        const cfg = loadConfig();
        const categories = db.getCategoryStats(query.project || null);
        return jsonResponse(res, { ...stats, categories, config: { maxMemoriesPerProject: cfg.maxMemoriesPerProject, pruneThreshold: cfg.pruneThreshold, decayFactor: cfg.decayFactor } });
      }

      if (path === '/api/memories' && method === 'GET') {
        const result = db.getMemoriesPaginated({
          project: query.project || null,
          category: query.category || null,
          search: query.search || null,
          sort: query.sort || 'score',
          order: query.order || 'desc',
          page: parseInt(query.page) || 1,
          limit: Math.min(Math.max(1, parseInt(query.limit) || 50), 200),
        });
        return jsonResponse(res, result);
      }

      const memoryMatch = path.match(/^\/api\/memories\/(\d+)$/);
      if (memoryMatch) {
        const id = parseInt(memoryMatch[1]);
        if (method === 'GET') {
          const mem = db.getMemoryById(id);
          if (!mem) return jsonResponse(res, { error: 'Not found' }, 404);
          return jsonResponse(res, mem);
        }
        if (method === 'DELETE') {
          const changes = db.deleteMemory(id);
          return jsonResponse(res, { deleted: changes > 0 });
        }
      }

      if (path === '/api/projects' && method === 'GET') {
        const stats = db.getStats();
        return jsonResponse(res, stats.byProject);
      }

      if (path === '/api/sessions' && method === 'GET') {
        const stats = db.getStats();
        return jsonResponse(res, stats.sessions);
      }

      if (path === '/api/config' && method === 'GET') {
        const cfg = loadConfig();
        const show = { ...cfg };
        show.stopwords = cfg.stopwords.size + ' words';
        return jsonResponse(res, show);
      }

      if (path === '/api/prune' && method === 'POST') {
        const body = await readBody(req);
        let pruned = 0;
        if (body.olderThan) {
          pruned += db.pruneOld(parseInt(body.olderThan) || 30);
        }
        if (body.belowScore) {
          pruned += db.pruneBelowScore(parseFloat(body.belowScore) || 0.05);
        }
        if (!body.olderThan && !body.belowScore) {
          pruned = db.decayAndPrune();
        }
        return jsonResponse(res, { pruned });
      }

      jsonResponse(res, { error: 'Not found' }, 404);
    } catch (err) {
      jsonResponse(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Infinite Context Dashboard`);
    console.log(`  http://localhost:${port}\n`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    db.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
