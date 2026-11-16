const terminalOutcomes = new Set(['ready', 'failed', 'timeout', 'cancelled']);

export function createWaitCapture({
  now = Date.now,
  makeId = () => globalThis.crypto.randomUUID()
} = {}) {
  const pending = new Map();
  let completed = [];

  function show(promisedMs) {
    if (!Number.isSafeInteger(promisedMs) || promisedMs < 0) {
      throw new RangeError('Expected a non-negative integer duration in milliseconds.');
    }
    const id = makeId();
    const record = { id, shownAtMs: now(), promisedMs };
    pending.set(id, record);
    return {
      id,
      finish(outcome) {
        if (!terminalOutcomes.has(outcome)) throw new TypeError('Unknown terminal outcome.');
        if (pending.get(id) !== record) return false;
        pending.delete(id);
        completed.push({ ...record, outcome, endedAtMs: now() });
        return true;
      }
    };
  }

  return {
    show,
    snapshotPending() {
      const observedThroughMs = now();
      return Array.from(pending.values(), (record) => ({
        ...record, outcome: 'pending', observedThroughMs
      }));
    },
    takeCompleted() {
      const records = completed;
      completed = [];
      return records;
    }
  };
}
