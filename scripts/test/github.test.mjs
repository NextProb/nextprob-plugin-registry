import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../lib/github.mjs';

test('GitHub client retries server errors and honors Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const client = new GitHubClient({
    token: 'secret',
    baseDelay: 10,
    random: () => 0,
    sleep: async ms => delays.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 500 });
      if (calls === 2) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.request('GET', '/repos/owner/repo');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.equal(delays[0], 10);
  assert.equal(delays[1], 2000);
});

test('GitHub client uploads binary assets with authentication', async () => {
  let captured;
  const client = new GitHubClient({
    token: 'secret',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ id: 7, name: 'plugin.zip' }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const bytes = Buffer.from('archive');
  const asset = await client.uploadReleaseAsset('owner/repo', 42, 'plugin-1.0.0.zip', bytes);
  assert.equal(asset.id, 7);
  assert.equal(captured.url, 'https://uploads.github.com/repos/owner/repo/releases/42/assets?name=plugin-1.0.0.zip');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer secret');
  assert.equal(captured.options.headers['content-type'], 'application/octet-stream');
  assert.ok(captured.options.body.equals(bytes));
});
