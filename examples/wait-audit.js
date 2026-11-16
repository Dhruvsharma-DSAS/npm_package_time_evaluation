import { writeFile } from 'node:fs/promises';
import { auditWaitMessages } from '../index.js';

const evaluationStartMs = Date.UTC(2026, 10, 16);
const runs = Array.from({ length: 200 }, (_, index) => {
  const shownAtMs = evaluationStartMs + index * 1000;
  if (index < 194) {
    return {
      id: 'example-' + index, shownAtMs, promisedMs: 5000, outcome: 'ready',
      endedAtMs: shownAtMs + (index < 122 ? 4000 : 9000)
    };
  }
  return {
    id: 'example-' + index, shownAtMs, promisedMs: 5000, outcome: 'timeout',
    endedAtMs: shownAtMs + 15000
  };
});

await writeFile(new URL('./wait-runs.json', import.meta.url), JSON.stringify(runs, null, 2) + '\n');
const report = auditWaitMessages(runs, {
  evaluationStartMs, targetRate: 0.90, candidateMs: 12000
});
await writeFile(new URL('./wait-audit-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
for (const [label, result] of [['5-second message', report.observed], ['12-second replay', report.candidate]]) {
  console.log(label, result.counts.on_time + '/' + result.total, result.decision);
}
