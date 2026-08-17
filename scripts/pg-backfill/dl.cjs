// Download SRC_URL to OUT, fully draining the fetch socket (no backpressure pause).
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
(async () => {
  const r = await fetch(process.env.SRC_URL);
  if (!r.ok) throw new Error('http ' + r.status);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(process.env.OUT));
  console.log('downloaded', process.env.OUT, fs.statSync(process.env.OUT).size, 'bytes');
})().catch((e) => { console.error('DL_FAIL', e.message); process.exit(1); });
