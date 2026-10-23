import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, canonicalize, keyId, sign, signatureFile, verify } from '../lib/sign.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'generate-signing-key.mjs');

test('canonical JSON sorts object keys recursively and preserves arrays', () => {
  const value = { b: 1, a: { d: 2, c: [{ z: 1, a: 2 }, 3] } };
  assert.deepEqual(canonicalize(value), { a: { c: [{ a: 2, z: 1 }, 3], d: 2 }, b: 1 });
  assert.equal(canonicalJson(value), '{"a":{"c":[{"a":2,"z":1},3],"d":2},"b":1}');
});

test('Ed25519 signatures verify canonical bytes and reject tampering', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, plugins: [{ id: 'a' }] }));
  const signature = sign(bytes, privateKey);
  assert.equal(verify(bytes, signature, publicKey), true);
  assert.equal(verify(Buffer.from('tampered'), signature, publicKey), false);
  assert.match(keyId(publicKey), /^[0-9a-f]{64}$/);
  assert.equal(keyId(privateKey), keyId(publicKey));
  assert.equal(signatureFile(signature), `${signature}\n`);
});

test('signing key generation writes PEM files once and prints only the key id', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-key-'));
  try {
    const privateFile = path.join(directory, 'private.pem');
    const publicFile = path.join(directory, 'public.pem');
    const first = spawnSync(process.execPath, [SCRIPT, '--private', privateFile, '--public', publicFile], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^keyId=[0-9a-f]{64}\n$/);
    const privatePem = fs.readFileSync(privateFile, 'utf8');
    const publicPem = fs.readFileSync(publicFile, 'utf8');
    assert.match(privatePem, /BEGIN PRIVATE KEY/);
    assert.match(publicPem, /BEGIN PUBLIC KEY/);
    assert.equal(`keyId=${keyId(publicPem)}\n`, first.stdout);
    const second = spawnSync(process.execPath, [SCRIPT, '--private', privateFile, '--public', publicFile], { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /Refusing to overwrite/);
    assert.equal(fs.readFileSync(privateFile, 'utf8'), privatePem);
    assert.equal(fs.readFileSync(publicFile, 'utf8'), publicPem);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
