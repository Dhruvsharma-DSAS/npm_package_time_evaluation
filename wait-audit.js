const outcomes = new Set(['ready', 'failed', 'timeout', 'cancelled', 'pending']);
const z95 = 1.959963984540054;

function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function wilson(hits, total) {
  const rate = hits / total;
  const zSquared = z95 ** 2;
  const denominator = 1 + zSquared / total;
  const center = (rate + zSquared / (2 * total)) / denominator;
  const margin = z95 * Math.sqrt((rate * (1 - rate) + zSquared / (4 * total)) / total)
    / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function classify(run, deadlineMs) {
  if (run.outcome === 'ready') return run.endedAtMs <= deadlineMs ? 'on_time' : 'late';
  if (run.outcome !== 'pending') return run.outcome;
  return run.observedThroughMs >= deadlineMs ? 'not_ready_by_deadline' : 'unresolved';
}

function measure(cases, total, targetRate, minSamples) {
  const counts = {
    on_time: 0, late: 0, failed: 0, timeout: 0, cancelled: 0,
    not_ready_by_deadline: 0, unresolved: 0
  };
  for (const row of cases) counts[row.result]++;
  const resolved = total - counts.unresolved;
  const lower = total ? wilson(counts.on_time, total)[0] : null;
  const upper = total ? wilson(counts.on_time + counts.unresolved, total)[1] : null;
  let decision = 'inconclusive';
  if (resolved >= minSamples) {
    if (lower >= targetRate) decision = 'passes_target';
    else if (upper < targetRate) decision = 'below_target';
  }
  return {
    total, resolved, counts,
    observedOnTimeRate: resolved ? counts.on_time / resolved : null,
    // Bracket the estimate by scoring unresolved runs first as misses, then as hits.
    wilson95: { lower, upper },
    decision,
    cases
  };
}

function evaluate(run, promisedMs) {
  const deadlineMs = run.shownAtMs + promisedMs;
  if (!Number.isSafeInteger(deadlineMs)) throw new RangeError('Message deadline is out of range.');
  const result = classify(run, deadlineMs);
  return {
    runId: run.id,
    shownAtMs: run.shownAtMs,
    promisedMs,
    deadlineMs,
    result,
    readyAfterMs: run.outcome === 'ready' ? run.endedAtMs - run.shownAtMs : null
  };
}

export function auditWaitMessages(runs, {
  targetRate = 0.90, minSamples = 30, evaluationStartMs = 0, candidateMs
} = {}) {
  if (!Array.isArray(runs)) throw new TypeError('Expected an array of wait-message exposures.');
  if (!(Number.isFinite(targetRate) && targetRate > 0 && targetRate < 1) ||
      !Number.isSafeInteger(minSamples) || minSamples < 1 ||
      !nonNegative(evaluationStartMs) ||
      (candidateMs !== undefined && !nonNegative(candidateMs))) {
    throw new RangeError('Invalid target, minimum sample count, evaluation start, or candidate duration.');
  }

  const ids = new Set();
  const observed = [];
  const candidate = [];
  const transitions = {};
  let excludedBeforeEvaluation = 0;
  for (const run of runs) {
    if (!run || typeof run.id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(run.id) ||
        !outcomes.has(run.outcome) || !nonNegative(run.shownAtMs) || !nonNegative(run.promisedMs)) {
      throw new TypeError('Each run needs an opaque ID, a message timestamp, a duration, and a known outcome.');
    }
    const lastObserved = run.outcome === 'pending' ? run.observedThroughMs : run.endedAtMs;
    if (!nonNegative(lastObserved) || lastObserved < run.shownAtMs || ids.has(run.id)) {
      throw new TypeError('Each run needs a unique ID and observation at or after the message timestamp.');
    }
    ids.add(run.id);
    if (run.shownAtMs < evaluationStartMs) {
      excludedBeforeEvaluation++;
      continue;
    }
    const actual = evaluate(run, run.promisedMs);
    observed.push(actual);
    if (candidateMs !== undefined) {
      const replay = evaluate(run, candidateMs);
      candidate.push(replay);
      const transition = actual.result + ' -> ' + replay.result;
      transitions[transition] = (transitions[transition] ?? 0) + 1;
    }
  }
  return {
    schemaVersion: 1,
    reportType: 'wait_message_audit',
    timeUnit: 'ms',
    targetRate,
    minSamples,
    evaluationStartMs,
    excludedBeforeEvaluation,
    observed: measure(observed, observed.length, targetRate, minSamples),
    candidate: candidateMs === undefined ? null : {
      promisedMs: candidateMs,
      transitions,
      ...measure(candidate, candidate.length, targetRate, minSamples)
    }
  };
}
