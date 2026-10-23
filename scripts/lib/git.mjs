import { spawnSync } from 'node:child_process';

export function zeroCommit(value) {
  return typeof value === 'string' && /^0{40,64}$/.test(value);
}

export function runGit(cwd, args, { allowFailure = false, env } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw new Error(`Unable to run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function gitOrNull(cwd, args, options = {}) {
  const result = runGit(cwd, args, { ...options, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveCommit(cwd, revision) {
  const value = gitOrNull(cwd, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (!value) throw new Error(`Unknown git revision: ${revision}`);
  return value;
}

export function mergeBase(cwd, base, head) {
  return gitOrNull(cwd, ['merge-base', base, head]);
}

function parseNameStatus(output) {
  const tokens = output.split('\0');
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[index++];
      const to = tokens[index++];
      if (!to) throw new Error('Invalid git diff output');
      changes.push({ status, path: from }, { status, path: to });
    } else {
      const file = tokens[index++];
      if (!file) throw new Error('Invalid git diff output');
      changes.push({ status, path: file });
    }
  }
  return changes;
}

export function changedPluginFiles(cwd, base, head) {
  const ranges = [`${base}...${head}`, `${base}..${head}`];
  let lastError;
  for (const range of ranges) {
    const result = runGit(cwd, ['diff', '--name-status', '-z', '--find-renames', range, '--', 'plugins'], { allowFailure: true });
    if (result.status === 0) return parseNameStatus(result.stdout).filter(change => change.path === 'plugins' || change.path.startsWith('plugins/'));
    lastError = result.stderr?.trim() || lastError;
  }
  throw new Error(`Unable to diff ${base}..${head}${lastError ? `: ${lastError}` : ''}`);
}

export function listTags(cwd, id) {
  const output = gitOrNull(cwd, ['tag', '--list', `${id}-v*`]);
  if (!output) return [];
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

export function tagVersion(id, tag) {
  const prefix = `${id}-v`;
  if (!tag.startsWith(prefix)) throw new Error(`Tag does not belong to ${id}: ${tag}`);
  return tag.slice(prefix.length);
}

export function showFile(cwd, revision, file) {
  const result = runGit(cwd, ['show', `${revision}:${file}`], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

export function addWorktree(cwd, directory, revision) {
  runGit(cwd, ['worktree', 'add', '--detach', directory, revision]);
}

export function removeWorktree(cwd, directory) {
  runGit(cwd, ['worktree', 'remove', '--force', directory], { allowFailure: true });
  runGit(cwd, ['worktree', 'prune'], { allowFailure: true });
}

export function branchRevision(cwd, branch, remote = 'origin') {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]) {
    const value = gitOrNull(cwd, ['show-ref', '--verify', '--hash', ref]);
    if (value) return value;
  }
  return null;
}

export function commitAll(cwd, message, identity) {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, [
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    'commit', '-m', message,
  ]);
}

export function pushBranch(cwd, branch, remote = 'origin') {
  runGit(cwd, ['push', remote, `HEAD:refs/heads/${branch}`]);
}
