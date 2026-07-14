import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getMimeType, uploadLocalFile } from '../src/upload-file.mjs';

test('uploads a local file through Linear signed storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linear-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'evidence.png');
  await writeFile(path, Buffer.from('image bytes'));

  const calls = [];
  const client = {
    async fileUpload(contentType, filename, size, variables) {
      calls.push({ contentType, filename, size, variables });
      return {
        success: true,
        uploadFile: {
          assetUrl: 'https://uploads.linear.app/asset.png',
          uploadUrl: 'https://storage.example/upload',
          headers: [{ key: 'x-upload-token', value: 'signed' }],
        },
      };
    },
  };
  let put;
  const result = await uploadLocalFile(client, path, {
    fetch: async (url, init) => {
      put = { url, init };
      return { ok: true };
    },
  });

  assert.deepEqual(calls, [{
    contentType: 'image/png',
    filename: 'evidence.png',
    size: 11,
    variables: { makePublic: false },
  }]);
  assert.equal(put.url, 'https://storage.example/upload');
  assert.equal(put.init.method, 'PUT');
  assert.equal(put.init.headers['content-type'], 'image/png');
  assert.equal(put.init.headers['x-upload-token'], 'signed');
  assert.deepEqual(result, {
    assetUrl: 'https://uploads.linear.app/asset.png',
    filename: 'evidence.png',
    size: 11,
    contentType: 'image/png',
    public: false,
  });
});

test('allows public raster images but rejects other public files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linear-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.pdf');
  await writeFile(path, 'report');

  await assert.rejects(
    uploadLocalFile({ fileUpload() { throw new Error('should not run'); } }, path, { makePublic: true }),
    /Public uploads are limited/,
  );
});

test('uses a binary fallback for unknown extensions', () => {
  assert.equal(getMimeType('artifact.unknown'), 'application/octet-stream');
});
