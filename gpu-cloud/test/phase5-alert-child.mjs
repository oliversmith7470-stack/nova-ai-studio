// phase5-alert-child.mjs — helper for the two-process concurrency test.
// Dispatches ONE event with a file-recording transport (appends one line per
// send to the record file) and prints the dispatch result as JSON.
// NOT a test file.
import fs from 'node:fs';
import { dispatchAlert } from '../src/api-server/alert-dispatcher.js';

const [event, windowStart, requestId, recordFile] = process.argv.slice(2);
const transport = async ({ to, subject }) => {
  fs.appendFileSync(recordFile, `${process.pid} ${event} ${subject}\n`);
  return { ok: true };
};
const result = await dispatchAlert(
  { event, windowStart, requestId, ts: new Date().toISOString(), detail: 'two-process-test' },
  transport,
);
console.log(JSON.stringify(result));
