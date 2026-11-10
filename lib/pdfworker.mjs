// A child process that converts one PDF and exits (see pdfjob.mjs).
//
// PDF work is the memory-hungry part of the app: pdf.js decodes every picture
// and draws pages through native canvases, whose memory the main process
// would otherwise keep long after the job. Here it all goes back to the
// system when this process ends, and if a PDF needs more memory than there is,
// only this process stops, not the server.

import { normalizeForDevice } from './assets.mjs';
import { extractPdf } from './pdf.mjs';
import { renderPdfPages } from './render.mjs';

process.once('message', async (job) => {
  let reply;
  try {
    const data = Buffer.from(job.data);
    const result =
      job.kind === 'pages'
        ? await renderPdfPages({ ...job.options, data })
        : await extractPdf({
            data,
            name: job.name,
            includeImages: job.includeImages,
            normalizeImage: normalizeForDevice,
          });
    reply = { ok: true, result };
  } catch (err) {
    reply = { ok: false, message: err.message, code: err.code, detail: err.detail };
  }
  process.send(reply, () => process.exit(0));
});
