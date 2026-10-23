import fs from 'node:fs';
import path from 'node:path';

export function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function checkRelativePath(relative, label = 'Path') {
  if (typeof relative !== 'string' || !relative) throw new Error(`${label} must be a non-empty string`);
  if (relative.includes('\0')) throw new Error(`${label} must not contain NUL`);
  if (relative.includes('\\')) throw new Error(`${label} must use forward slashes`);
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new Error(`${label} must be package-relative`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} must stay inside the package`);
  return parts.join('/');
}

export function resolvePath(root, relative, label = 'Path', { allowDirectory = false } = {}) {
  const safe = checkRelativePath(relative, label);
  const base = fs.realpathSync(root);
  const target = path.join(base, safe);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${safe}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${safe}`);
  if (allowDirectory) {
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`${label} must be a regular file or directory: ${safe}`);
  } else if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${safe}`);
  }
  const real = fs.realpathSync(target);
  if (!contained(base, real)) throw new Error(`${label} escapes its package: ${safe}`);
  return real;
}

export function resolveResource(root, relative, label = 'Resource') {
  return resolvePath(root, relative, label, { allowDirectory: false });
}

export function readJson(file, { max = 256 * 1024 } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Expected a regular JSON file: ${file}`);
  if (stat.size > max) throw new Error(`JSON file exceeds ${max} bytes: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

function unsafeName(name) {
  return name.includes('\0') || name.includes('\\');
}

export function walkFiles(root, { skip = () => false } = {}) {
  const base = fs.realpathSync(root);
  const entries = [];
  function walk(relative) {
    const directory = relative ? path.join(base, relative) : base;
    const names = fs.readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (unsafeName(name)) throw new Error(`Unsafe file name: ${JSON.stringify(name)}`);
      const child = relative ? `${relative}/${name}` : name;
      const absolute = path.join(base, child);
      const stat = fs.lstatSync(absolute);
      if (skip(child, stat, name)) continue;
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${child}`);
      if (stat.isDirectory()) {
        walk(child);
      } else if (stat.isFile()) {
        entries.push({ path: child, absolute, size: stat.size, mode: stat.mode });
      } else {
        throw new Error(`Special files are not allowed: ${child}`);
      }
    }
  }
  walk('');
  return entries;
}

export function validateSourceTree(root, { maxFiles = 10000, maxFileSize = 25 * 1024 * 1024, maxTotalSize = 100 * 1024 * 1024 } = {}) {
  const base = fs.realpathSync(root);
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`Plugin path is not a directory: ${root}`);
  const entries = walkFiles(base, {
    skip: (relative, stat, name) => {
      if (name === '.git') throw new Error(`.git is not allowed in a plugin package: ${relative}`);
      return false;
    },
  });
  if (entries.length > maxFiles) throw new Error(`Plugin has more than ${maxFiles} files`);
  let total = 0;
  for (const entry of entries) {
    if (entry.size > maxFileSize) throw new Error(`File exceeds 25 MiB: ${entry.path}`);
    total += entry.size;
  }
  if (total > maxTotalSize) throw new Error('Plugin contents exceed 100 MiB');
  return entries;
}

export function copyTree(source, target, { skip = () => false } = {}) {
  const base = fs.realpathSync(source);
  fs.mkdirSync(target);
  function copy(relative) {
    const from = relative ? path.join(base, relative) : base;
    const to = relative ? path.join(target, relative) : target;
    const names = fs.readdirSync(from).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (unsafeName(name)) throw new Error(`Unsafe file name: ${JSON.stringify(name)}`);
      const child = relative ? `${relative}/${name}` : name;
      const input = path.join(base, child);
      const output = path.join(target, child);
      const stat = fs.lstatSync(input);
      if (skip(child, stat, name)) continue;
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${child}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(output);
        copy(child);
      } else if (stat.isFile()) {
        fs.copyFileSync(input, output);
        fs.chmodSync(output, stat.mode & 0o777);
      } else {
        throw new Error(`Special files are not allowed: ${child}`);
      }
    }
  }
  copy('');
}

export function ensureEmptyDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw new Error(`Directory is not empty: ${directory}`);
}

export function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}
