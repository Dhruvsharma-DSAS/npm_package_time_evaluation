import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const minimumSamples = 20;
const historyLimit = 200;
const historyAgeMs = 7 * 24 * 60 * 60 * 1000;
const labelPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const observations = {
  rate_limited: 'The server returned HTTP 429.',
  server_error: 'The server returned an HTTP 5xx response.',
  http_error: 'The response had a non-success HTTP status.',
  transport_error: 'Fetch rejected before response headers were available.',
  timeout: 'Fetch or the response reader reported a timeout.',
  aborted: 'The caller cancelled the request.',
  body_read_error: 'Reading the response body failed after headers arrived.',
  invalid_json: 'The body was read, but JSON parsing failed.'
};

function groupKey(label, method, mode) {
  return JSON.stringify([label, method, mode]);
}

function summarize(durations) {
  const sorted = durations.toSorted((a, b) => a - b);
  const count = sorted.length;
  const quantile = (probability) => count < minimumSamples
    ? null
    : sorted[Math.ceil(count * probability) - 1];
  return { sampleCount: count, p50Ms: quantile(0.5), p90Ms: quantile(0.9) };
}

function outcomeOf(response) {
  if (response.ok) return 'ok';
  if (response.status === 429) return 'rate_limited';
  return response.status >= 500 ? 'server_error' : 'http_error';
}

function describe(record) {
  if (record.outcome !== 'ok') return observations[record.outcome] ?? null;
  if (record.estimateAtStart.p90Ms === null ||
      record.durationMs <= record.estimateAtStart.p90Ms) return null;
  if (record.headersMs * 2 >= record.durationMs) {
    return 'Exceeded the historical p90. Most elapsed time passed before response headers arrived.';
  }
  return 'Exceeded the historical p90. Most elapsed time passed while reading or decoding the response body.';
}

export async function createLatencyBrief({ historyFile, fetchImpl = globalThis.fetch } = {}) {
  const history = new Map();
  const active = new Map();
  let pendingWrite = Promise.resolve();
  let persistenceErrors = 0;

  function remember(record) {
    const key = groupKey(record.label, record.method, record.mode);
    const records = history.get(key) ?? [];
    records.push(record);
    history.set(key, records.slice(-historyLimit));
  }

  if (historyFile) {
    const saved = await readFile(historyFile, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const line of saved.split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.schemaVersion === 1 && labelPattern.test(record.label) &&
            methods.has(record.method) && ['headers', 'json'].includes(record.mode) &&
            Number.isFinite(record.finishedAtMs) && Number.isFinite(record.durationMs) &&
            record.estimateAtStart && (record.outcome === 'ok' ||
              Object.hasOwn(observations, record.outcome))) {
          remember(record);
        } else {
          persistenceErrors++;
        }
      } catch {
        persistenceErrors++;
      }
    }
  }

  function recent(key) {
    const cutoff = Date.now() - historyAgeMs;
    return (history.get(key) ?? []).filter((record) => record.finishedAtMs >= cutoff);
  }

  function start(mode, label, input, init) {
    if (typeof label !== 'string' || !labelPattern.test(label)) {
      throw new TypeError('Use a short endpoint alias such as payments.create.');
    }
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (!methods.has(method)) throw new TypeError('Use a supported HTTP method.');
    const key = groupKey(label, method, mode);
    const priorDurations = recent(key).filter((record) => record.outcome === 'ok')
      .map((record) => record.durationMs);
    const estimateAtStart = summarize(priorDurations);
    const id = randomUUID();
    const startedAt = performance.now();
    const request = {
      id, label, method, mode, startedAt, estimateAtStart, priorDurations,
      phase: 'awaiting_headers', headersMs: null
    };
    active.set(id, request);

    const result = (async () => {
      let status = null;
      let outcome;
      try {
        const response = await fetchImpl(input, init);
        request.headersMs = Math.round(performance.now() - startedAt);
        status = response.status;
        outcome = outcomeOf(response);
        if (mode === 'headers') return response;
        if (!response.ok) return { response, data: undefined };
        request.phase = 'reading_body';
        const body = await response.text();
        request.phase = 'decoding_json';
        const data = JSON.parse(body);
        return { response, data };
      } catch (error) {
        if (error?.name === 'TimeoutError') outcome = 'timeout';
        else if (error?.name === 'AbortError' || (init?.signal ?? input?.signal)?.aborted) outcome = 'aborted';
        else if (request.phase === 'decoding_json') outcome = 'invalid_json';
        else if (request.phase === 'reading_body') outcome = 'body_read_error';
        else outcome = 'transport_error';
        throw error;
      } finally {
        active.delete(id);
        const record = {
          schemaVersion: 1, id, label, method, mode, status, outcome,
          finishedAtMs: Date.now(),
          headersMs: request.headersMs,
          durationMs: Math.round(performance.now() - startedAt),
          estimateAtStart
        };
        remember(record);
        if (historyFile) {
          pendingWrite = pendingWrite.then(() => appendFile(historyFile, JSON.stringify(record) + '\n'))
            .catch(() => { persistenceErrors++; });
        }
      }
    })();
    return { id, estimate: { ...estimateAtStart }, result };
  }

  function snapshot() {
    const groups = [...history.entries()].flatMap(([key]) => {
      const records = recent(key);
      if (!records.length) return [];
      const [label, method, mode] = JSON.parse(key);
      const counts = {};
      for (const { outcome } of records) counts[outcome] = (counts[outcome] ?? 0) + 1;
      const durations = records.filter((record) => record.outcome === 'ok')
        .map((record) => record.durationMs);
      return [{
        label, method, mode, outcomes: counts, estimate: summarize(durations),
        recentRequests: records.slice(-10).map((record) => ({
          id: record.id,
          finishedAt: new Date(record.finishedAtMs).toISOString(),
          httpStatus: record.status,
          outcome: record.outcome,
          headersMs: record.headersMs,
          durationMs: record.durationMs,
          estimateAtStart: { ...record.estimateAtStart },
          observation: describe(record)
        }))
      }];
    });

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      timeUnit: 'ms',
      estimation: {
        method: 'nearest_rank',
        successfulRequestsOnly: true,
        minimumSamples,
        maxRecordsPerGroup: historyLimit,
        maxAgeDays: 7
      },
      persistenceErrors,
      groups,
      inFlight: [...active.values()].map((request) => {
        const elapsedMs = Math.round(performance.now() - request.startedAt);
        const remaining = request.priorDurations
          .filter((duration) => duration > elapsedMs)
          .map((duration) => duration - elapsedMs);
        const { id, label, method, mode, phase, headersMs, estimateAtStart } = request;
        return {
          id, label, method, mode, phase, headersMs, elapsedMs,
          estimateAtStart: { ...estimateAtStart },
          pastInitialP90: estimateAtStart.p90Ms === null ? null : elapsedMs > estimateAtStart.p90Ms,
          estimatedRemaining: summarize(remaining)
        };
      })
    };
  }

  return {
    start: (label, input, init) => start('headers', label, input, init),
    startJson: (label, input, init) => start('json', label, input, init),
    snapshot,
    flush: () => pendingWrite,
    async writeReport(path) {
      await pendingWrite;
      await writeFile(path, JSON.stringify(snapshot(), null, 2) + '\n');
    }
  };
}

export { auditWaitMessages } from './wait-audit.js';
