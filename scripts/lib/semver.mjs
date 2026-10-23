const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(input) {
  if (typeof input !== 'string') throw new Error('Version must be a string');
  const match = VERSION_RE.exec(input);
  if (!match) throw new Error(`Invalid version: ${input}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Version is too large: ${input}`);
  return { major, minor, patch };
}

function toVersion(value) {
  return typeof value === 'string' ? parseVersion(value) : value;
}

export function parse(input) {
  return parseVersion(input);
}

export function tryParse(input) {
  try {
    return parseVersion(input);
  } catch {
    return null;
  }
}

export function format(version) {
  const value = toVersion(version);
  return `${value.major}.${value.minor}.${value.patch}`;
}

export function compare(left, right) {
  const a = toVersion(left);
  const b = toVersion(right);
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function parsePartial(text) {
  if (typeof text !== 'string' || !text) throw new Error('Expected a version range');
  if (text === '*' || text.toLowerCase() === 'x') return { major: 0, minor: 0, patch: 0, missing: 3 };
  const parts = text.split('.');
  if (parts.length > 3) throw new Error(`Invalid version range: ${text}`);
  const values = [];
  let wildcard = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '*' || part.toLowerCase() === 'x') {
      wildcard = true;
      values.push(null);
      continue;
    }
    if (wildcard) throw new Error(`Invalid version range: ${text}`);
    if (!/^(0|[1-9]\d*)$/.test(part)) throw new Error(`Invalid version range: ${text}`);
    const value = Number(part);
    if (!Number.isSafeInteger(value)) throw new Error(`Version range is too large: ${text}`);
    values.push(value);
  }
  const specified = values.filter(value => value !== null).length;
  const missing = 3 - specified;
  return {
    major: values[0] ?? 0,
    minor: values[1] ?? 0,
    patch: values[2] ?? 0,
    missing,
  };
}

function upperVersion(partial) {
  if (partial.missing === 2) return { major: partial.major + 1, minor: 0, patch: 0 };
  if (partial.missing === 1) return { major: partial.major, minor: partial.minor + 1, patch: 0 };
  throw new Error('A complete version has no exclusive upper bound');
}

function expandRaw(partial) {
  if (partial.missing === 3) return [];
  if (partial.missing === 0) return [{ op: '=', major: partial.major, minor: partial.minor, patch: partial.patch }];
  return [
    { op: '>=', major: partial.major, minor: partial.minor, patch: partial.patch },
    { op: '<', ...upperVersion(partial) },
  ];
}

function expandComparator(op, partial) {
  if (op === '') op = '=';
  if (op === '=') return expandRaw(partial);
  if (partial.missing === 3) throw new Error('Wildcard cannot use a comparator');
  if (op === '>=') return [{ op, major: partial.major, minor: partial.minor, patch: partial.patch }];
  if (op === '<') return [{ op, major: partial.major, minor: partial.minor, patch: partial.patch }];
  if (partial.missing === 0) return [{ op, major: partial.major, minor: partial.minor, patch: partial.patch }];
  if (op === '>') return [{ op: '>=', ...upperVersion(partial) }];
  if (op === '<=') return [{ op: '<', ...upperVersion(partial) }];
  throw new Error(`Invalid comparator: ${op}`);
}

function expandCaret(partial) {
  if (partial.missing === 3) throw new Error('Caret range requires a version');
  const lower = { op: '>=', major: partial.major, minor: partial.minor, patch: partial.patch };
  let upper;
  if (partial.missing === 2) {
    upper = { op: '<', major: partial.major + 1, minor: 0, patch: 0 };
  } else if (partial.missing === 1) {
    upper = partial.major > 0
      ? { op: '<', major: partial.major + 1, minor: 0, patch: 0 }
      : { op: '<', major: 0, minor: partial.minor + 1, patch: 0 };
  } else if (partial.major > 0) {
    upper = { op: '<', major: partial.major + 1, minor: 0, patch: 0 };
  } else if (partial.minor > 0) {
    upper = { op: '<', major: 0, minor: partial.minor + 1, patch: 0 };
  } else {
    upper = { op: '<', major: 0, minor: 0, patch: partial.patch + 1 };
  }
  return [lower, upper];
}

function expandTilde(partial) {
  if (partial.missing === 3) throw new Error('Tilde range requires a version');
  const lower = { op: '>=', major: partial.major, minor: partial.minor, patch: partial.patch };
  const upper = partial.missing >= 2
    ? { op: '<', major: partial.major + 1, minor: 0, patch: 0 }
    : { op: '<', major: partial.major, minor: partial.minor + 1, patch: 0 };
  return [lower, upper];
}

function expandHyphen(from, to) {
  const lowerPartial = parsePartial(from);
  const upperPartial = parsePartial(to);
  if (lowerPartial.missing === 3 || upperPartial.missing === 3) throw new Error(`Invalid hyphen range: ${from} - ${to}`);
  const parts = [{ op: '>=', major: lowerPartial.major, minor: lowerPartial.minor, patch: lowerPartial.patch }];
  if (upperPartial.missing === 0) {
    parts.push({ op: '<=', major: upperPartial.major, minor: upperPartial.minor, patch: upperPartial.patch });
  } else {
    parts.push({ op: '<', ...upperVersion(upperPartial) });
  }
  return parts;
}

function parseAlternative(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty version range');
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) return expandHyphen(hyphen[1], hyphen[2]);
  const normalized = trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const comparators = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
    if (!match) throw new Error(`Invalid version range: ${text}`);
    const op = match[1] || '';
    const partial = parsePartial(match[2]);
    if (op === '^') comparators.push(...expandCaret(partial));
    else if (op === '~') comparators.push(...expandTilde(partial));
    else comparators.push(...expandComparator(op, partial));
  }
  if (!comparators.length) return [];
  return comparators;
}

export function parseRange(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Version range must be a non-empty string');
  return input.split('||').map(parseAlternative);
}

export function validRange(input) {
  try {
    parseRange(input);
    return true;
  } catch {
    return false;
  }
}

function testComparator(version, comparator) {
  const result = compare(version, comparator);
  switch (comparator.op) {
    case '=': return result === 0;
    case '>': return result > 0;
    case '>=': return result >= 0;
    case '<': return result < 0;
    case '<=': return result <= 0;
    default: throw new Error(`Unknown comparator: ${comparator.op}`);
  }
}

export function satisfies(version, range) {
  const parsed = toVersion(version);
  const alternatives = parseRange(range);
  return alternatives.some(comparators => comparators.every(comparator => testComparator(parsed, comparator)));
}

export function sortDescending(versions) {
  return [...versions].sort((a, b) => compare(b, a));
}
