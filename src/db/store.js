import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import { loadConfig } from '../core/config.js';

const require = createRequire(import.meta.url);

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT,
    metadata TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, keywords, content='memories', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
    INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    last_line_number INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    memories_created INTEGER NOT NULL DEFAULT 0,
    compactions INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_project_score ON memories(project, score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source_hash ON memories(source_hash);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
`;

export class Store {
  constructor(dbPath) {
    const cfg = loadConfig();
    this.dbPath = dbPath || cfg.dbPath;
    this.db = null;
    this._stmts = {};
  }

  open() {
    if (this.db) return this;

    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 5000');
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('busy_timeout = 5000');

      this._initSchema();
      this._prepareStatements();
    } catch (err) {
      this.db.close();
      this.db = null;
      throw err;
    }
    return this;
  }

  _initSchema() {
    const version = this._getMetaInt('schema_version', 0);
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA_SQL);
      this._setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  _getMetaInt(key, fallback) {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? parseInt(row.value, 10) : fallback;
    } catch {
      return fallback;
    }
  }

  _setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  _prepareStatements() {
    this._stmts = {
      insertMemory: this.db.prepare(`
        INSERT INTO memories (project, session_id, category, content, keywords, score, source_hash, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      hashExists: this.db.prepare('SELECT 1 FROM memories WHERE source_hash = ? LIMIT 1'),
      topMemories: this.db.prepare(`
        SELECT * FROM memories WHERE project = ? ORDER BY score DESC LIMIT ?
      `),
      searchFts: this.db.prepare(`
        SELECT m.*, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
        AND m.project = ?
        ORDER BY fts.rank
        LIMIT ?
      `),
      searchFtsAll: this.db.prepare(`
        SELECT m.*, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `),
      touchMemory: this.db.prepare(`
        UPDATE memories SET access_count = access_count + 1,
        last_accessed = datetime('now'),
        score = MIN(1.0, score + 0.02 * (1.0 - score))
        WHERE id = ?
      `),
      decayScores: this.db.prepare(`
        UPDATE memories SET score = MAX(?, score * ?)
        WHERE last_accessed < datetime('now', ? || ' days')
      `),
      pruneByScore: this.db.prepare('DELETE FROM memories WHERE score < ?'),
      pruneByAge: this.db.prepare(`
        DELETE FROM memories WHERE created_at < datetime('now', ? || ' days')
        AND access_count = 0
      `),
      pruneProject: this.db.prepare(`
        DELETE FROM memories WHERE id IN (
          SELECT id FROM memories WHERE project = ?
          ORDER BY score ASC LIMIT MAX(0, (SELECT COUNT(*) FROM memories WHERE project = ?) - ?)
        )
      `),
      countByProject: this.db.prepare('SELECT project, COUNT(*) as cnt FROM memories GROUP BY project'),
      countAll: this.db.prepare('SELECT COUNT(*) as cnt FROM memories'),
      getCheckpoint: this.db.prepare(`
        SELECT * FROM checkpoints WHERE session_id = ? AND transcript_path = ?
        ORDER BY id DESC LIMIT 1
      `),
      saveCheckpoint: this.db.prepare(`
        INSERT INTO checkpoints (session_id, transcript_path, last_line_number) VALUES (?, ?, ?)
      `),
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (session_id, project) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET project = excluded.project
      `),
      incrSessionMemories: this.db.prepare(`
        UPDATE sessions SET memories_created = memories_created + ? WHERE session_id = ?
      `),
      incrSessionCompactions: this.db.prepare(`
        UPDATE sessions SET compactions = compactions + 1 WHERE session_id = ?
      `),
      endSession: this.db.prepare(`
        UPDATE sessions SET ended_at = datetime('now') WHERE session_id = ?
      `),
      allSessions: this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC'),
      getById: this.db.prepare('SELECT * FROM memories WHERE id = ?'),
      deleteById: this.db.prepare('DELETE FROM memories WHERE id = ?'),
      countBelowScore: this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE score < ?'),
      pruneBelowScore: this.db.prepare('DELETE FROM memories WHERE score < ?'),
      countOld: this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE created_at < datetime('now', ? || ' days') AND access_count = 0`),
    };
  }

  insertMemory({ project, sessionId, category, content, keywords, score, sourceHash, metadata }) {
    if (sourceHash && this._stmts.hashExists.get(sourceHash)) return null;
    const info = this._stmts.insertMemory.run(
      project, sessionId, category, content, keywords, score,
      sourceHash || null, metadata ? JSON.stringify(metadata) : null
    );
    return info.lastInsertRowid;
  }

  insertMany(memories) {
    const insert = this.db.transaction((items) => {
      let count = 0;
      for (const m of items) {
        const id = this.insertMemory(m);
        if (id) count++;
      }
      return count;
    });
    return insert(memories);
  }

  getTopMemories(project, limit) {
    const cfg = loadConfig();
    return this._stmts.topMemories.all(project, limit || cfg.maxMemoriesPerRestore);
  }

  search(query, project, limit = 10) {
    const ftsQuery = query.split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => w.replace(/[*^{}[\]():~!]/g, '').replace(/"/g, '""'))
      .filter(w => w.length > 1)
      .map(w => `"${w}"`)
      .join(' OR ');
    if (!ftsQuery) return [];
    try {
      if (project) {
        return this._stmts.searchFts.all(ftsQuery, project, limit);
      }
      return this._stmts.searchFtsAll.all(ftsQuery, limit);
    } catch {
      return [];
    }
  }

  touchMemories(ids) {
    const touch = this.db.transaction((list) => {
      for (const id of list) {
        this._stmts.touchMemory.run(id);
      }
    });
    touch(ids);
  }

  decayAndPrune() {
    const cfg = loadConfig();
    const days = Math.max(1, Math.round(Number(cfg.decayIntervalDays) || 1));
    this._stmts.decayScores.run(cfg.scoreFloor, cfg.decayFactor, `-${days}`);
    const info = this._stmts.pruneByScore.run(cfg.pruneThreshold);
    return info.changes;
  }

  pruneOld(days) {
    const d = Math.max(1, Math.round(Number(days) || 30));
    return this._stmts.pruneByAge.run(`-${d}`).changes;
  }

  enforceProjectLimit(project) {
    const cfg = loadConfig();
    return this._stmts.pruneProject.run(project, project, cfg.maxMemoriesPerProject).changes;
  }

  getCheckpoint(sessionId, transcriptPath) {
    return this._stmts.getCheckpoint.get(sessionId, transcriptPath);
  }

  saveCheckpoint(sessionId, transcriptPath, lastLineNumber) {
    this._stmts.saveCheckpoint.run(sessionId, transcriptPath, lastLineNumber);
  }

  upsertSession(sessionId, project) {
    this._stmts.upsertSession.run(sessionId, project);
  }

  incrSessionMemories(sessionId, count) {
    this._stmts.incrSessionMemories.run(count, sessionId);
  }

  incrSessionCompactions(sessionId) {
    this._stmts.incrSessionCompactions.run(sessionId);
  }

  endSession(sessionId) {
    this._stmts.endSession.run(sessionId);
  }

  getStats() {
    const total = this._stmts.countAll.get().cnt;
    const byProject = this._stmts.countByProject.all();
    const sessions = this._stmts.allSessions.all();
    let dbSize = 0;
    try {
      const row = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
      dbSize = row?.size || 0;
    } catch {}
    return { total, byProject, sessions, dbSize };
  }

  getMemoryById(id) {
    return this._stmts.getById.get(id) || null;
  }

  deleteMemory(id) {
    return this._stmts.deleteById.run(id).changes;
  }

  countBelowScore(threshold) {
    return this._stmts.countBelowScore.get(threshold).cnt;
  }

  pruneBelowScore(threshold) {
    return this._stmts.pruneBelowScore.run(threshold).changes;
  }

  countOld(days) {
    const d = Math.max(1, Math.round(Number(days) || 30));
    return this._stmts.countOld.get(`-${d}`).cnt;
  }

  bulkDelete(ids) {
    if (!ids || ids.length === 0) return 0;
    const del = this.db.transaction((list) => {
      let count = 0;
      for (const id of list) {
        count += this._stmts.deleteById.run(id).changes;
      }
      return count;
    });
    return del(ids);
  }

  getScoreDistribution() {
    return this.db.prepare(
      'SELECT MIN(10, CAST(score * 10 AS INTEGER)) as bucket, COUNT(*) as cnt FROM memories GROUP BY bucket ORDER BY bucket'
    ).all();
  }

  getTimeline(days = 30) {
    return this.db.prepare(
      `SELECT DATE(created_at) as day, COUNT(*) as cnt FROM memories WHERE created_at > datetime('now', ? || ' days') GROUP BY day ORDER BY day`
    ).all(`-${Math.max(1, days)}`);
  }

  getMemoriesPaginated({ project, category, search, sort = 'score', order = 'desc', page = 1, limit = 50 } = {}) {
    let where = [];
    let params = [];

    if (project) { where.push('m.project = ?'); params.push(project); }
    if (category) { where.push('m.category = ?'); params.push(category); }

    const validSorts = { score: 'm.score', created: 'm.created_at', accessed: 'm.last_accessed', access_count: 'm.access_count', id: 'm.id' };
    const sortCol = validSorts[sort] || 'm.score';
    const dir = order === 'asc' ? 'ASC' : 'DESC';

    if (search) {
      const ftsQuery = search.split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/[*^{}[\]():~!]/g, '').replace(/"/g, '""')).filter(w => w.length > 1).map(w => `"${w}"`).join(' OR ');
      if (ftsQuery) {
        try {
          const offset = (Math.max(1, page) - 1) * limit;
          const filterClause = where.length ? 'AND ' + where.join(' AND ') : '';
          const countParams = [ftsQuery, ...params];
          const dataParams = [ftsQuery, ...params, limit, offset];

          const total = this.db.prepare(`SELECT COUNT(*) as total FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH ? ${filterClause}`).get(...countParams).total;
          const rows = this.db.prepare(`SELECT m.* FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH ? ${filterClause} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`).all(...dataParams);
          return { rows, total, page, limit, pages: Math.ceil(total / limit) };
        } catch { return { rows: [], total: 0, page, limit, pages: 0 }; }
      }
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (Math.max(1, page) - 1) * limit;

    const total = this.db.prepare(`SELECT COUNT(*) as total FROM memories m ${whereClause}`).get(...params).total;
    const rows = this.db.prepare(`SELECT * FROM memories m ${whereClause} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }

  getCategoryStats(project) {
    const where = project ? 'WHERE project = ?' : '';
    const params = project ? [project] : [];
    return this.db.prepare(`SELECT category, COUNT(*) as cnt, AVG(score) as avg_score FROM memories ${where} GROUP BY category ORDER BY cnt DESC`).all(...params);
  }

  exportAll(project) {
    if (project) {
      return this.db.prepare('SELECT * FROM memories WHERE project = ? ORDER BY score DESC').all(project);
    }
    return this.db.prepare('SELECT * FROM memories ORDER BY project, score DESC').all();
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
