import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLatencyBrief } from './index.js';

test('uses prior successful samples, exposes live state, and keeps request data out of files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'latency-brief-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyFile = join(directory, 'history.jsonl');
  const report = join(directory, 'report.json');
  const oldRecords = Array.from({ length: 20 }, (_, i) => ({
    schemaVersion: 1,
    id: String(i), label: 'payments.create', method: 'POST', mode: 'json',
    status: 200, outcome: 'ok', finishedAtMs: Date.now(),
    headersMs: 1, durationMs: 100 + 10 * i,
    estimateAtStart: { sampleCount: 0, p50Ms: null, p90Ms: null }
  }));
  await writeFile(historyFile, oldRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  let resolveFetch;
  const fakeFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const brief = await createLatencyBrief({ historyFile, fetchImpl: () => fakeFetch });
  const request = brief.startJson('payments.create', 'https://example.test/pay?token=url-secret', {
    method: 'POST', headers: { Authorization: 'Bearer header-secret' }, body: 'body-secret'
  });
  assert.deepEqual(request.estimate, { sampleCount: 20, p50Ms: 190, p90Ms: 270 });
  assert.equal(brief.snapshot().inFlight[0].phase, 'awaiting_headers');
  assert.equal(brief.snapshot().inFlight[0].id, request.id);
  resolveFetch(Response.json({ result: 'response-secret' }));
  assert.equal((await request.result).data.result, 'response-secret');
  await brief.writeReport(report);
  for (const path of [historyFile, report]) assert.doesNotMatch(await readFile(path, 'utf8'), /secret/);
  const restarted = await createLatencyBrief({ historyFile });
  assert.equal(restarted.snapshot().groups[0].estimate.sampleCount, 21);
  assert.deepEqual(brief.snapshot().inFlight, []);
});

test('reports HTTP and JSON errors without feeding them into the latency estimate', async () => {
  const brief = await createLatencyBrief({
    fetchImpl: async (input) => input === 'throttled'
      ? new Response(null, { status: 429 })
      : new Response('bad JSON')
  });
  const throttled = await brief.startJson('orders.list', 'throttled').result;
  assert.equal(throttled.response.status, 429);
  await assert.rejects(brief.startJson('orders.list', 'bad').result, SyntaxError);
  const group = brief.snapshot().groups[0];
  assert.deepEqual(group.outcomes, { rate_limited: 1, invalid_json: 1 });
  assert.deepEqual(group.estimate, { sampleCount: 0, p50Ms: null, p90Ms: null });
  assert.match(group.recentRequests[0].observation, /429/);
});
