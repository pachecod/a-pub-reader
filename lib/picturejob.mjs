// Shrinking feed pictures in short-lived child processes (pictureworker.mjs),
// one picture per process and one process at a time, so a refresh full of
// large photos never builds up memory in the main server or in any helper.
// Measured on a Mac (seven feeds, 82 pictures): one process doing them all
// grew by about 330 MB; five per process peaked at 319 MB, two at 183 MB, one
// at 81 MB, with the refresh taking the same 7-9 s either way.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./pictureworker.mjs', import.meta.url));
const PER_PROCESS = 1;
const TIMEOUT_MS = 60 * 1000;
let queue = Promise.resolve();

function runBatch(pictures) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(pictures.map(() => null));
    }, TIMEOUT_MS);
    child.once('message', (reply) =>
      finish((reply?.pictures || []).map((p) => (p instanceof Uint8Array && p.length ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : null)))
    );
    child.once('error', () => finish(pictures.map(() => null)));
    child.once('exit', () => finish(pictures.map(() => null)));
    child.send({ pictures });
  });
}

/**
 * Shrink pictures to JPEGs of at most 960 px. Returns one result per picture,
 * in order: the smaller JPEG, or null where it could not be made.
 */
export function shrinkPictures(pictures) {
  const run = queue.then(async () => {
    const out = [];
    for (let i = 0; i < pictures.length; i += PER_PROCESS) out.push(...(await runBatch(pictures.slice(i, i + PER_PROCESS))));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}
