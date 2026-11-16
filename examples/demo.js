import { setTimeout as delay } from 'node:timers/promises';
import { createLatencyBrief } from '../index.js';

let call = 0;
const brief = await createLatencyBrief({
  fetchImpl: async () => {
    call++;
    if (call === 31) return new Response(null, { status: 429 });
    await delay(call === 32 ? 220 : 10 + (call % 10) * 4);
    return Response.json({ status: 'created' });
  }
});

const startPayment = () => brief.startJson('payments.create', 'https://api.example.test/payments', {
  method: 'POST',
  headers: { Authorization: 'Bearer demo-secret' }
});

for (let i = 0; i < 31; i++) await startPayment().result;
const slowRequest = startPayment();
await delay(70);
await brief.writeReport(new URL('./api-report.json', import.meta.url));
await slowRequest.result;
await brief.writeReport(new URL('./api-report-completed.json', import.meta.url));
console.log('Wrote examples/api-report.json and examples/api-report-completed.json');
