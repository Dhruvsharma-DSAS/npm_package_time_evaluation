import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditWaitMessages } from './index.js';

const exposure = (id, fields) => ({ id, shownAtMs: 3000, promisedMs: 5000, ...fields });

test('uses exposure time, counts terminal outcomes, and distinguishes incomplete observations', () => {
  const runs = [
    exposure('boundary', { outcome: 'ready', endedAtMs: 8000 }),
    exposure('late', { outcome: 'ready', endedAtMs: 8001 }),
    exposure('timeout', { outcome: 'timeout', endedAtMs: 9000 }),
    exposure('failed', { outcome: 'failed', endedAtMs: 4000 }),
    exposure('cancelled', { outcome: 'cancelled', endedAtMs: 4100 }),
    exposure('unresolved', { outcome: 'pending', observedThroughMs: 7999 }),
    exposure('missed', { outcome: 'pending', observedThroughMs: 8000 })
  ];
  const report = auditWaitMessages(runs, { candidateMs: 5001 });
  assert.deepEqual(Object.values(report.observed.counts), [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(report.observed.observedOnTimeRate, 1 / 6);
  assert.equal(report.candidate.transitions['late -> on_time'], 1);
  assert.equal(report.candidate.transitions['not_ready_by_deadline -> unresolved'], 1);
  assert.equal(report.observed.decision, 'inconclusive');
});

test('uses a chronological cutoff and distinguishes evidence from a high point estimate', () => {
  const ready = (i) => exposure(String(i), { outcome: 'ready', endedAtMs: 7000 });
  const late = (i) => exposure(String(i), { outcome: 'ready', endedAtMs: 10000 });
  const passes = auditWaitMessages(Array.from({ length: 100 }, (_, i) => ready(i)));
  const fallsShort = auditWaitMessages(Array.from({ length: 100 }, (_, i) => late(i)));
  const uncertain = auditWaitMessages(Array.from({ length: 30 }, (_, i) => ready(i)));
  assert.equal(passes.observed.decision, 'passes_target');
  assert.equal(fallsShort.observed.decision, 'below_target');
  assert.equal(uncertain.observed.decision, 'inconclusive');
  const holdout = auditWaitMessages([
    { ...ready(1), shownAtMs: 2999 },
    ready(2)
  ], { evaluationStartMs: 3000 });
  assert.equal(holdout.excludedBeforeEvaluation, 1);
  assert.equal(holdout.observed.total, 1);
  assert.throws(() => auditWaitMessages([ready(1), ready(1)]), /unique ID/);
});

test('withholds a decision when an unknown outcome could change it', () => {
  const runs = Array.from({ length: 100 }, (_, i) => i < 70
    ? exposure(String(i), { outcome: 'ready', endedAtMs: 7000 })
    : exposure(String(i), { outcome: 'pending', observedThroughMs: 6500 }));
  const { observed } = auditWaitMessages(runs);
  assert.equal(observed.observedOnTimeRate, 1);
  assert.equal(observed.decision, 'inconclusive');
  assert.ok(observed.wilson95.lower < 0.90 && observed.wilson95.upper > 0.90);
});
