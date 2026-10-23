import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, parse, satisfies, validRange } from '../lib/semver.mjs';

test('strict version parsing', () => {
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.throws(() => parse('v1.2.3'), /Invalid version/);
  assert.throws(() => parse('1.2'), /Invalid version/);
  assert.throws(() => parse('01.2.3'), /Invalid version/);
  assert.throws(() => parse('1.2.3-beta'), /Invalid version/);
  assert.throws(() => parse('1.2.3+build'), /Invalid version/);
});

test('version comparison', () => {
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.equal(compare('1.2.4', '1.2.3'), 1);
  assert.equal(compare('1.3.0', '2.0.0'), -1);
  assert.equal(compare('10.0.0', '9.9.9'), 1);
});

test('caret, tilde, partial, comparator and OR ranges', () => {
  assert.equal(satisfies('1.9.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.9.9', '1'), true);
  assert.equal(satisfies('2.0.0', '1'), false);
  assert.equal(satisfies('1.2.9', '1.2'), true);
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('1.5.0', '>=1.2.3 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.3 <2.0.0'), false);
  assert.equal(satisfies('1.2.9', '>1.2'), false);
  assert.equal(satisfies('1.3.0', '>1.2'), true);
  assert.equal(satisfies('1.2.9', '<=1.2'), true);
  assert.equal(satisfies('1.3.0', '<=1.2'), false);
  assert.equal(satisfies('1.5.0', '1.2 || >=2.0.0'), false);
  assert.equal(satisfies('2.1.0', '1.2 || >=2.0.0'), true);
});

test('wildcards, hyphen ranges and whitespace', () => {
  assert.equal(satisfies('0.0.1', '*'), true);
  assert.equal(satisfies('5.6.7', '1.x'), false);
  assert.equal(satisfies('1.9.9', '1.x'), true);
  assert.equal(satisfies('1.2.9', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.2.3', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false);
  assert.equal(satisfies('2.3.9', '1.2 - 2.3'), true);
  assert.equal(satisfies('2.4.0', '1.2 - 2.3'), false);
  assert.equal(satisfies('1.5.0', '>= 1.2.3 < 2.0.0'), true);
});

test('invalid ranges are rejected', () => {
  for (const range of ['', '>=', '1.2.3 -', '>=1.0.0 ||', 'banana', '1.2.3.4', '1.x.3', '^']) {
    assert.equal(validRange(range), false, range);
    assert.throws(() => satisfies('1.0.0', range));
  }
  assert.equal(validRange('>=0.4.0 <1.0.0'), true);
});
