import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude', 'infinite-context');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const DB_PATH = join(DATA_DIR, 'memories.db');

const DEFAULTS = {
  maxRestoreTokens: 4000,
  maxMemoriesPerRestore: 20,
  maxPromptRecallResults: 5,
  decayFactor: 0.95,
  decayIntervalDays: 1,
  pruneThreshold: 0.05,
  scoreFloor: 0.01,
  maxMemoriesPerProject: 5000,
  dbPath: DB_PATH,
  dataDir: DATA_DIR,
  categoryWeights: {
    architecture: 1.0,
    decision: 0.9,
    error: 0.8,
    finding: 0.7,
    file_change: 0.5,
    note: 0.4,
  },
  stopwords: new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'this', 'that', 'these',
    'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
    'not', 'no', 'nor', 'and', 'or', 'but', 'if', 'then', 'else',
    'for', 'to', 'from', 'by', 'on', 'at', 'in', 'of', 'with', 'about',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further',
    'just', 'also', 'very', 'really', 'quite', 'so', 'too', 'only',
    'let', 'use', 'using', 'used', 'like', 'need', 'want', 'get',
  ]),
  extractionMode: 'rules',
  llmModel: 'claude-opus-4-6',
  llmMaxTranscriptChars: 12000,
  projects: {},
  debug: false,
};

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  let userConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (Array.isArray(raw.stopwords)) {
        raw.stopwords = new Set(raw.stopwords);
      }
      userConfig = raw;
    } catch {}
  }

  _config = { ...DEFAULTS, ...userConfig };
  if (userConfig.categoryWeights) {
    _config.categoryWeights = { ...DEFAULTS.categoryWeights, ...userConfig.categoryWeights };
  }
  if (!(userConfig.stopwords instanceof Set)) {
    _config.stopwords = DEFAULTS.stopwords;
  }

  const numericFields = ['maxRestoreTokens', 'maxMemoriesPerRestore', 'maxPromptRecallResults',
    'decayIntervalDays', 'maxMemoriesPerProject', 'llmMaxTranscriptChars'];
  for (const key of numericFields) {
    if (typeof _config[key] !== 'number' || !Number.isFinite(_config[key]) || _config[key] < 1) {
      _config[key] = DEFAULTS[key];
    }
  }
  const fractionFields = ['decayFactor', 'pruneThreshold', 'scoreFloor'];
  for (const key of fractionFields) {
    if (typeof _config[key] !== 'number' || !Number.isFinite(_config[key]) || _config[key] < 0 || _config[key] > 1) {
      _config[key] = DEFAULTS[key];
    }
  }

  const validModes = ['rules', 'llm', 'hybrid'];
  if (!validModes.includes(_config.extractionMode)) {
    _config.extractionMode = DEFAULTS.extractionMode;
  }
  if (typeof _config.llmModel !== 'string' || !_config.llmModel) {
    _config.llmModel = DEFAULTS.llmModel;
  }
  if (typeof _config.projects !== 'object' || Array.isArray(_config.projects) || !_config.projects) {
    _config.projects = {};
  }

  return _config;
}

export function resetConfig() {
  _config = null;
}

export function saveConfig(updates) {
  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  const merged = { ...existing, ...updates };
  if (updates.categoryWeights) {
    merged.categoryWeights = { ...(existing.categoryWeights || {}), ...updates.categoryWeights };
  }
  // Remove non-serializable / internal fields
  delete merged.stopwords;
  delete merged.dbPath;
  delete merged.dataDir;
  delete merged.debug;

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, CONFIG_PATH);
  resetConfig();
  return loadConfig();
}

export function getProjectConfig(projectPath) {
  const cfg = loadConfig();
  if (!projectPath || !cfg.projects || typeof cfg.projects !== 'object') return cfg;
  const overrides = cfg.projects[projectPath];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return cfg;
  const merged = { ...cfg, ...overrides };
  if (overrides.categoryWeights) {
    merged.categoryWeights = { ...cfg.categoryWeights, ...overrides.categoryWeights };
  }
  return merged;
}

export { DATA_DIR, CONFIG_PATH, DB_PATH, DEFAULTS };
