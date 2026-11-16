#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { auditWaitMessages } from './wait-audit.js';

const usage = `Usage: api-latency-brief audit <runs.json> [options]

Options:
  --target <rate>         Reliability target from 0 to 1 (default: 0.90)
  --min-samples <count>   Minimum resolved observations (default: 30)
  --evaluation-start <ms> Earliest message display time as Unix milliseconds
  --candidate-ms <ms>     Replay the same runs with this wait estimate
  --gate <policy>        Return CI status for "observed" or "candidate"
  --help                 Show this help

JSON is written to stdout. With --gate, exit 0 means passes_target,
1 means below_target, and 2 means inconclusive. Invalid input exits 64.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      'min-samples': { type: 'string' },
      'evaluation-start': { type: 'string' },
      'candidate-ms': { type: 'string' },
      gate: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help || positionals.length === 0 && process.argv.length === 2) {
    console.log(usage);
    return;
  }
  if (positionals[0] !== 'audit' || positionals.length !== 2) {
    throw new Error('Expected the audit command and one JSON input file. See --help.');
  }
  if (values.gate !== undefined && !['observed', 'candidate'].includes(values.gate)) {
    throw new Error('--gate must be observed or candidate.');
  }
  if (values.gate === 'candidate' && values['candidate-ms'] === undefined) {
    throw new Error('--gate candidate requires --candidate-ms.');
  }
  const number = (name) => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (!value.trim()) throw new Error('--' + name + ' requires a number.');
    return Number(value);
  };
  const runs = JSON.parse(await readFile(positionals[1], 'utf8'));
  const report = auditWaitMessages(runs, {
    targetRate: number('target'),
    minSamples: number('min-samples'),
    evaluationStartMs: number('evaluation-start'),
    candidateMs: number('candidate-ms')
  });
  console.log(JSON.stringify(report, null, 2));
  if (values.gate) {
    const exitCodes = { passes_target: 0, below_target: 1, inconclusive: 2 };
    process.exitCode = exitCodes[report[values.gate].decision];
  }
}

try {
  await main();
} catch (error) {
  console.error('api-latency-brief: ' + error.message);
  process.exitCode = 64;
}
