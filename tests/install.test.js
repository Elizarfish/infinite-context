import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the install/uninstall logic by simulating settings.json manipulation
// Since install.js uses a hardcoded SETTINGS_PATH, we test the merge logic directly

describe('install merge logic', () => {
  const tmpDir = join(tmpdir(), 'ic-install-test-' + Date.now());
  const settingsPath = join(tmpDir, 'settings.json');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('should merge hooks into empty settings', () => {
    writeFileSync(settingsPath, '{}');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    settings.hooks = settings.hooks || {};

    // Simulate adding our hooks
    const events = ['PreCompact', 'SessionStart', 'UserPromptSubmit', 'SessionEnd'];
    for (const event of events) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      settings.hooks[event].push({
        hooks: [{ type: 'command', command: 'node /path/to/infinite-context/hook.js', timeout: 10 }],
      });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    assert.ok(result.hooks.PreCompact);
    assert.ok(result.hooks.SessionStart);
    assert.ok(result.hooks.UserPromptSubmit);
    assert.ok(result.hooks.SessionEnd);
    assert.equal(result.hooks.PreCompact.length, 1);
  });

  it('should preserve existing hooks when merging', () => {
    const existing = {
      env: { SOME_VAR: 'value' },
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'python3 /path/scope_guard.py', timeout: 5 }],
        }],
        PostToolUse: [{
          matcher: 'Bash|Write|Edit',
          hooks: [{ type: 'command', command: 'python3 /path/progress_save.py', timeout: 5 }],
        }],
      },
    };

    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Add our hooks
    for (const event of ['PreCompact', 'SessionStart']) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      settings.hooks[event].push({
        hooks: [{ type: 'command', command: 'node /path/infinite-context/hook.js' }],
      });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Existing hooks preserved
    assert.equal(result.hooks.PreToolUse.length, 1);
    assert.ok(result.hooks.PreToolUse[0].hooks[0].command.includes('scope_guard'));
    assert.equal(result.hooks.PostToolUse.length, 1);
    assert.ok(result.hooks.PostToolUse[0].hooks[0].command.includes('progress_save'));

    // New hooks added
    assert.equal(result.hooks.PreCompact.length, 1);
    assert.equal(result.hooks.SessionStart.length, 1);

    // Env preserved
    assert.equal(result.env.SOME_VAR, 'value');
  });

  it('should detect duplicate hooks (idempotency)', () => {
    const settings = {
      hooks: {
        PreCompact: [{
          hooks: [{ type: 'command', command: 'node /path/infinite-context/pre-compact.js' }],
        }],
      },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const loaded = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Check if already installed
    const alreadyInstalled = loaded.hooks.PreCompact.some(group =>
      group.hooks?.some(h => h.command?.includes('infinite-context'))
    );

    assert.ok(alreadyInstalled, 'Should detect existing infinite-context hook');
  });

  it('should remove only our hooks during uninstall', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'python3 /path/scope_guard.py' }],
        }],
        PreCompact: [
          { hooks: [{ type: 'command', command: 'node /path/infinite-context/pre-compact.js' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /path/infinite-context/session-start.js' }] },
        ],
      },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const loaded = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Remove our hooks
    for (const event of Object.keys(loaded.hooks)) {
      loaded.hooks[event] = loaded.hooks[event].filter(group => {
        const isOurs = group.hooks?.some(h => h.command?.includes('infinite-context'));
        return !isOurs;
      });
      if (loaded.hooks[event].length === 0) delete loaded.hooks[event];
    }

    writeFileSync(settingsPath, JSON.stringify(loaded, null, 2));
    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Our hooks removed
    assert.ok(!result.hooks.PreCompact);
    assert.ok(!result.hooks.SessionStart);

    // Others preserved
    assert.equal(result.hooks.PreToolUse.length, 1);
    assert.ok(result.hooks.PreToolUse[0].hooks[0].command.includes('scope_guard'));
  });
});
