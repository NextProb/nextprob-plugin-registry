import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createZip, crc32, readZip } from '../lib/zip.mjs';

test('ZIP round-trip is sorted, compressed and deterministic', () => {
  const entries = [
    { path: 'b.txt', data: 'bravo' },
    { path: 'a.txt', data: 'alpha' },
    { path: 'dir/c.bin', data: Buffer.from([0, 1, 2, 255]) },
    { path: 'run.sh', data: '#!/bin/sh\n', executable: true },
  ];
  const first = createZip(entries);
  const second = createZip([...entries].reverse());
  assert.ok(first.equals(second));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt16LE(10), 0);
  assert.equal(first.readUInt16LE(12), 0x0021);
  const read = readZip(first);
  assert.deepEqual(read.map(entry => entry.path), ['a.txt', 'b.txt', 'dir/c.bin', 'run.sh']);
  assert.deepEqual(read[0].data.toString(), 'alpha');
  assert.deepEqual(read[2].data, Buffer.from([0, 1, 2, 255]));
  assert.equal(crc32(Buffer.from('alpha')), 0xd0e0396a);
});

test('ZIP is accepted by unzip when available', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-zip-'));
  try {
    const file = path.join(directory, 'test.zip');
    fs.writeFileSync(file, createZip([{ path: 'hello.txt', data: 'hello world' }]));
    const result = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') return;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /No errors detected/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ZIP rejects traversal, absolute paths and unsafe names', () => {
  for (const entry of ['../evil', '/absolute', 'a\\b', 'a\0b', './a', 'a/../b', '']) {
    assert.throws(() => createZip([{ path: entry, data: 'x' }]), /ZIP entry path/, entry);
  }
  assert.throws(() => createZip([{ path: 'a', data: '1' }, { path: 'a', data: '2' }]), /Duplicate ZIP entry/);
  assert.throws(() => createZip([{ path: 'README.md', data: '1' }, { path: 'readme.md', data: '2' }]), /case-insensitive/);
});
