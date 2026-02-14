import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { DATA_DIR } from './core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOKS_DIR = resolve(__dirname, 'hooks');

const HOOK_MARKER = 'infinite-context';

function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, filePath);
}

function getHookCommand(hookFile) {
  const fullPath = join(HOOKS_DIR, hookFile);
  return fullPath.includes(' ') ? `node "${fullPath}"` : `node ${fullPath}`;
}

function buildHookConfig() {
  return {
    PreCompact: [{
      matcher: 'auto|manual',
      hooks: [{
        type: 'command',
        command: getHookCommand('pre-compact.js'),
        timeout: 30,
      }],
    }],
    SessionStart: [{
      matcher: 'startup|resume|compact|clear',
      hooks: [{
        type: 'command',
        command: getHookCommand('session-start.js'),
        timeout: 10,
      }],
    }],
    UserPromptSubmit: [{
      hooks: [{
        type: 'command',
        command: getHookCommand('user-prompt-submit.js'),
        timeout: 5,
      }],
    }],
    SubagentStart: [{
      hooks: [{
        type: 'command',
        command: getHookCommand('subagent-start.js'),
        timeout: 5,
      }],
    }],
    SubagentStop: [{
      hooks: [{
        type: 'command',
        command: getHookCommand('subagent-stop.js'),
        timeout: 15,
      }],
    }],
    SessionEnd: [{
      hooks: [{
        type: 'command',
        command: getHookCommand('session-end.js'),
        timeout: 15,
      }],
    }],
  };
}

export function install() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const settingsDir = dirname(SETTINGS_PATH);
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch (err) {
      console.error(`Error reading ${SETTINGS_PATH}: ${err.message}`);
      process.exit(1);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const hookConfig = buildHookConfig();
  let added = 0;
  let skipped = 0;

  for (const [event, entries] of Object.entries(hookConfig)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    const alreadyInstalled = settings.hooks[event].some(group =>
      group.hooks?.some(h => h.command?.includes(HOOK_MARKER))
    );

    if (alreadyInstalled) {
      skipped++;
      continue;
    }

    settings.hooks[event].push(...entries);
    added++;
  }

  atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  console.log(`\nInfinite Context installed.`);
  console.log(`  Hooks added: ${added}`);
  console.log(`  Already present: ${skipped}`);
  console.log(`  Settings: ${SETTINGS_PATH}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`\nRestart Claude Code for hooks to take effect.`);
}

export function uninstall({ deleteData = false } = {}) {
  if (!existsSync(SETTINGS_PATH)) {
    console.log('No settings.json found. Nothing to uninstall.');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error reading ${SETTINGS_PATH}: ${err.message}`);
    process.exit(1);
  }

  if (!settings.hooks) {
    console.log('No hooks configured. Nothing to uninstall.');
    return;
  }

  let removed = 0;

  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;

    settings.hooks[event] = settings.hooks[event].filter(group => {
      const isOurs = group.hooks?.some(h => h.command?.includes(HOOK_MARKER));
      return !isOurs;
    });

    const after = settings.hooks[event].length;
    removed += before - after;

    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  console.log(`\nInfinite Context uninstalled.`);
  console.log(`  Hook entries removed: ${removed}`);
  console.log(`  Data preserved at: ${DATA_DIR}`);
  if (deleteData) {
    console.log(`  (Use rm -rf "${DATA_DIR}" to delete stored memories)`);
  }
  console.log(`\nRestart Claude Code for changes to take effect.`);
}

export { SETTINGS_PATH, HOOK_MARKER };
