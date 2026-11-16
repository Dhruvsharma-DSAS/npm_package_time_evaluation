# API Latency Brief

A Node.js library that learns how long your API calls usually take and exports a JSON report you can share with another developer or an AI assistant.

## The problem

Imagine your checkout usually calls the payment API in under a second. Today the spinner is still running after four seconds. A network tab can tell you that the current call is pending. You also want to know how long comparable calls usually took, whether this call has already passed that range, and whether the delay is before headers or after the response starts.

API keys authenticate calls. Use a safe, descriptive alias such as `payments.create` to group them. If you want separate histories for two accounts or environments, choose aliases such as `payments.create.prod` and `payments.create.sandbox`.

## Start here

Use Node.js 22 or newer. Open a terminal in this repository and run:

```sh
npm ci
npm test
npm run demo:audit
node cli.js audit examples/wait-runs.json --candidate-ms 12000 > wait-audit-report.json
```

The demo generates synthetic invoice exports. The last command compares the message shown in the data with a 12-second candidate and saves an AI-readable report. Open `wait-audit-report.json` and look for `observed.decision` and `candidate.decision`.

- `package.json` defines the npm package name, version, public imports, and commands.
- `wait-audit.js` scores the duration shown to the user against the recorded outcome.
- `capture.js` records when a wait message appears and when the result becomes ready.
- `cli.js` runs the audit from the terminal. `index.js` also measures Node Fetch requests.

## Try it as an npm dependency

Run `npm pack` here. In a separate app folder, run `npm install /absolute/path/to/api-latency-brief-0.3.0.tgz`. Then use the imports below, or run `npx api-latency-brief --help` in that app.

For Git updates, edit the files, run `npm test`, then use `git add <changed-files>`, `git commit -m "Describe the change"`, and `git push`. The GitHub repository and npm registry are separate. To release on npm, choose a license, check the archive with `npm pack --dry-run`, sign in with `npm login`, and publish from this folder with `npm publish --access public`. npm may prompt for two-factor authentication. See [npm publishing docs](https://docs.npmjs.com/commands/npm-publish/) and [npm's 2FA requirements](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

## Measure a Fetch call

Run `npm run demo` to generate a snapshot while a synthetic call is pending and another after it finishes.

```js
import { createLatencyBrief } from 'api-latency-brief';

const brief = await createLatencyBrief({ historyFile: './api-history.jsonl' });
const request = brief.startJson('payments.create.prod', 'https://api.example.com/payments', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.PAYMENT_API_KEY}` }
});

console.log(request.estimate); // Same group's historical p50, p90, and sample count.
const { response, data } = await request.result;
if (response.ok) console.log(data);
await brief.writeReport('./api-report.json');
```

`start()` resolves to the original Fetch Response when headers are available. `startJson()` resolves to an object containing `response` and parsed `data` for successful responses, with `data` undefined for non-success HTTP responses. Fetch and decode errors still reject the returned promise. For failed calls, use `try/finally` if you want to write a report before your script exits.

## Estimation

1. Group by developer-defined alias, HTTP method, and measurement mode. Use different aliases for operations with clearly different workloads, such as small and large reports.
2. Keep the latest 200 completed observations per group in memory. Read the last seven days of that retained window when calculating each estimate. Use successful requests of the same measurement mode as the latency sample. Count failures, rate-limiting responses, cancellations, and timeouts in outcomes.
3. Sort the sample and choose the observation at position `ceil(p × n)` using one-based indexing. With 50 samples, p50 is the 25th observation and p90 is the 45th. If these are 420 ms and 1,100 ms, half the historical sample finished within about 420 ms and at least 90% finished within 1,100 ms. The values describe the historical sample. Future calls can fall outside it.
4. Return null for percentiles with fewer than 20 comparable successes. For a call already in progress, use only prior successful durations that exceeded its current elapsed time. Subtract elapsed time from those durations and compute the same percentiles if at least 20 samples remain. Otherwise show elapsed time and whether it passed the initial p90.
5. To evaluate the estimator on real traffic, compare each successful call against the p90 it received at start. Track coverage, which is the percentage of those calls completing within that p90, alongside absolute error of the p50. A sustained change in coverage can indicate that the recent history is a poor match for current traffic.

## Report format

| Field | How to read it |
| --- | --- |
| `schemaVersion`, `generatedAt`, `timeUnit` | Report compatibility, snapshot time, and unit for durations. |
| `estimation` | Quantile method, sample requirement, and history window. |
| `groups[].estimate`, `groups[].outcomes` | Historical percentiles and observed outcome counts for a comparable group. |
| `groups[].recentRequests` | Up to ten records per group, including request ID, HTTP status, timings, result, estimate at start, and an observation when available. |
| `inFlight[]` | Request IDs, current client phase, elapsed time, initial estimate, and conditional estimate when enough past calls were still pending at the same point. |
| `persistenceErrors` | Count of malformed or unreadable records skipped during line parsing and failed append operations. An initial file-open error other than file-not-found rejects creation. |

Match the same ID between a live report and a completed report. A 429 supports a rate-limiting observation. A long wait before headers supports a timing observation only. The client cannot distinguish server queueing, network delay, DNS, or connection setup from the wrapper's timer alone. With server tracing or response timing metadata, a later version could attach stronger evidence. In JSON mode, the duration after headers includes reading and decoding the body.

The generated history and report include aliases, timings, status codes, and outcome categories. The wrapper passes credentials to Fetch and does not serialize headers, raw request URLs, request bodies, response bodies, or exception messages. Use aliases free of API keys, tokens, and user identifiers. Store each optional JSONL history file locally, using one writer instance per file. The file is append-only, so rotate it separately for long-running use. `await brief.flush()` waits for pending history writes.

## Audit a wait message

The fetch wrapper measures requests. The audit tests a user-facing claim such as “Usually ready within 5 seconds” against the time when the export was actually available. Instrument the UI when it displays the estimate and when the download or result becomes usable. Use timestamps from the same clock and one exposure per independent run. Pass one comparable workload and message policy per audit.

```js
import { auditWaitMessages } from 'api-latency-brief';

const shownAtMs = Date.UTC(2026, 10, 16, 9, 30);
const runs = [
  { id: 'run-1', shownAtMs, promisedMs: 5000, outcome: 'ready',
    endedAtMs: shownAtMs + 9000 },
  { id: 'run-2', shownAtMs, promisedMs: 5000, outcome: 'pending',
    observedThroughMs: shownAtMs + 6000 }
];

const report = auditWaitMessages(runs, {
  targetRate: 0.90,
  minSamples: 30,
  evaluationStartMs: shownAtMs,
  candidateMs: 12000
});
console.log(JSON.stringify(report, null, 2));
```

The deadline is measured from `shownAtMs`. Readiness at the deadline counts as on time. Terminal failures, timeouts, and cancellations count as missed promises for this user-facing metric. A pending run observed through its deadline counts as a miss; a pending run whose observation ended earlier is unresolved. Reported case rows contain timestamps, durations, result categories, and opaque run IDs. Use random run IDs and keep the export free of customer identifiers.

### Capture app events

Use the browser-compatible entry point. Call `show` at the point where the message is displayed and `finish('ready')` when the result can be used. For a failed, timed-out, or user-cancelled run, pass `'failed'`, `'timeout'`, or `'cancelled'` to `finish`.

```js
import { createWaitCapture } from 'api-latency-brief/capture';

const capture = createWaitCapture();
const exportRun = capture.show(5000); // Call when “Usually ready within 5 seconds” appears.
// On the event that makes the result available:
exportRun.finish('ready');
const runs = capture.takeCompleted();
```

Save or transmit the completed records through your own application storage. Collect outstanding runs with `snapshotPending()` if an evaluation needs incomplete observations. Include one record per ID, preferring a completed record when one is available. The helper keeps records in memory until you collect them.

To use the audit in CI, pass `--gate observed` or `--gate candidate` with `--candidate-ms`. Exit code 0 means the target passed, 1 means below target, 2 means inconclusive, and 64 means invalid input or a CLI error. JSON still prints for all three audit decisions.

### Evaluation protocol

1. Define readiness, the workload, the reliability target, and the candidate ETA before reviewing the evaluation data. Use earlier runs for tuning and choose `evaluationStartMs` to evaluate on later runs. Changing a candidate after looking at the evaluation results calls for another holdout.
2. Record every exposed run in the evaluation window. Use `observedOnTimeRate` as the descriptive rate among resolved runs and inspect the unresolved count alongside it. The report uses a 95% [Wilson score interval](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm). With incomplete observations, its lower bound treats unresolved runs as misses and its upper bound treats them as hits.
3. After at least `minSamples` resolved outcomes, the decision is `passes_target` if the lower bound reaches the target, `below_target` if the upper bound falls below it, and `inconclusive` otherwise. The interval assumes independent runs from a comparable population. Correlated retry bursts and repeated users can make the interval too narrow. Evaluate distinct workloads independently.
4. The candidate replay uses the same runs and message display times. Its transition counts show how individual outcomes would be classified under a different deadline, without rerunning the API. Actual user behaviour can change when the message changes. In particular, an offline replay cannot tell whether a user who cancelled would have waited longer.

Run `npm run demo:audit` to generate `examples/wait-audit-report.json`. The synthetic demo evaluates 200 invoice exports, including six timeouts. The 5-second message meets the promise in 122 runs. The 12-second replay meets it in 194, clearing the 90% target at the interval's lower bound.

## Existing tools

- [@reqmind/core](https://www.npmjs.com/package/@reqmind/core) tracks endpoint timing, outcomes, and active counts, and can adapt application timeouts. Its published README includes intelligence snapshots. This prototype focuses on a small Fetch wrapper and a shareable diagnostic file with a conditional wait estimate for a specific request.
- [OpenTelemetry HTTP metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/) standardize HTTP duration measurements. [Its HTTP span conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) cover retries and redirects. This prototype measures the caller's Fetch operation and does not break out individual redirects or retry attempts inside a supplied Fetch client. A later adapter could derive phase evidence from trace data.
