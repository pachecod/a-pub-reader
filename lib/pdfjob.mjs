// Converting a PDF in its own short-lived process (pdfworker.mjs).
//
// A hosted server has little memory (512 MB on Render's smaller plans) and a
// picture-heavy PDF can briefly need most of it. Converting in a child process
// returns all of that memory as soon as the job ends, keeps one heavy PDF from
// taking the whole server down, and turns "out of memory" into a message the
// person can act on. Jobs run one at a time, so two uploads never add up.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./pdfworker.mjs', import.meta.url));
const TIMEOUT_MS = 3 * 60 * 1000;
// V8's own heap is small for this work; most memory is native (images,
// canvases). The cap only stops a runaway heap early.
const MAX_HEAP_MB = 384;

let queue = Promise.resolve();

/** Buffers cross the process boundary as plain Uint8Arrays; make them Buffers again. */
function revive(value) {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) value[key] = revive(value[key]);
  }
  return value;
}

function runNow(job) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], {
      serialization: 'advanced',
      execArgv: ['--expose-gc', `--max-old-space-size=${MAX_HEAP_MB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('The PDF took too long to convert. Try a smaller file, or split it into parts.'));
    }, TIMEOUT_MS);

    child.once('message', (reply) => {
      if (reply?.ok) return settle(resolve, revive(reply.result));
      const err = new Error(reply?.message || 'The PDF could not be converted.');
      if (reply?.code) err.code = reply.code;
      if (reply?.detail) err.detail = reply.detail;
      settle(reject, err);
    });
    child.once('error', (err) => settle(reject, err));
    child.once('exit', (code, signal) => {
      // Killed by the system (out of memory) or aborted by V8 (heap limit).
      const memory = signal === 'SIGKILL' || signal === 'SIGABRT' || code === 134 || code === 137;
      settle(
        reject,
        new Error(
          memory
            ? 'This PDF needed more memory than the server has. Try it with pictures switched off, or split it into smaller files.'
            : `The PDF converter stopped unexpectedly (${signal || `exit ${code}`}).`
        )
      );
    });
    child.send(job);
  });
}

/**
 * Convert a PDF in a child process, after any job already running.
 * @param {{kind: 'text', data: Buffer, name?: string, includeImages?: boolean}
 *       | {kind: 'pages', data: Buffer, options: object}} job
 *   'text' is extractPdf (chapters, pictures); 'pages' is renderPdfPages.
 */
export function runPdfJob(job) {
  const run = queue.then(() => runNow(job));
  queue = run.catch(() => {});
  return run;
}
