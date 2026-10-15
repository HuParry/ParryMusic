import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreviewServer } from '../scripts/preview.mjs';

test('preview serves exact byte ranges, suffixes, HEAD and invalid-range responses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parry-range-'));
  const server = createPreviewServer(root);
  try {
    await writeFile(path.join(root, '音频.wav'), '0123456789');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/' + encodeURIComponent('音频.wav');
    for (const [range, expected, contentRange] of [['bytes=3-6', '3456', 'bytes 3-6/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-2', '89', 'bytes 8-9/10']]) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(await response.text(), expected);
    }
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(await head.text(), '');
    const invalid = await fetch(url, { headers: { Range: 'bytes=20-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
