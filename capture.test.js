import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWaitCapture } from './capture.js';
import { auditWaitMessages } from './index.js';

test('captures when the message appeared and drains each completed exposure once', () => {
  let now = 3000;
  const capture = createWaitCapture({ now: () => now, makeId: () => 'export-1' });
  const exposure = capture.show(5000);
  now = 7500;
  assert.equal(auditWaitMessages(capture.snapshotPending()).observed.counts.unresolved, 1);
  now = 8000;
  assert.equal(exposure.finish('ready'), true);
  assert.equal(exposure.finish('failed'), false);
  const report = auditWaitMessages(capture.takeCompleted());
  assert.equal(report.observed.counts.on_time, 1);
  assert.deepEqual(capture.snapshotPending(), []);
  assert.deepEqual(capture.takeCompleted(), []);
});

test('CLI writes a report and distinguishes a failed, passing, and inconclusive gate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wait-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'runs.json');
  const runs = Array.from({ length: 100 }, (_, i) => ({
    id: 'run-' + i, shownAtMs: 0, promisedMs: 100, endedAtMs: 200, outcome: 'ready'
  }));
  await writeFile(input, JSON.stringify(runs));
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'audit', input, ...args], {
    encoding: 'utf8'
  });
  const observed = invoke('--gate', 'observed');
  assert.equal(observed.status, 1);
  assert.equal(JSON.parse(observed.stdout).observed.counts.late, 100);
  assert.equal(invoke('--gate', 'candidate', '--candidate-ms', '200').status, 0);
  assert.equal(invoke('--gate', 'observed', '--min-samples', '101').status, 2);
  assert.equal(invoke('--gate', 'candidate').status, 64);
});
