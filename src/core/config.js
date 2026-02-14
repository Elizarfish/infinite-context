import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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
    'decayIntervalDays', 'maxMemoriesPerProject'];
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

  return _config;
}

export function resetConfig() {
  _config = null;
}

export { DATA_DIR, CONFIG_PATH, DB_PATH, DEFAULTS };
