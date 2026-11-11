// A child process that shrinks feed pictures (one, as used) and exits (see
// picturejob.mjs). It loads nothing but sharp, so it starts quickly and small.
//
// sharp (libvips) decodes a JPEG straight at a reduced size, so one big photo
// costs little; but the memory it uses is not handed back between pictures,
// so a long run of them grows. Doing one per process, which then exits,
// keeps that from ever adding up, and keeps it out of the main server.

import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

process.once('message', async ({ pictures = [] }) => {
  const out = [];
  for (const picture of pictures) {
    try {
      out.push(
        await sharp(Buffer.from(picture), { limitInputPixels: 50_000_000, failOn: 'error' })
          .rotate()
          .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 78, progressive: true })
          .toBuffer()
      );
    } catch {
      out.push(null);
    }
  }
  process.send({ ok: true, pictures: out }, () => process.exit(0));
});
