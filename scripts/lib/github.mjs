const API_URL = 'https://api.github.com';
const UPLOADS_URL = 'https://uploads.github.com';
const API_VERSION = '2022-11-28';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(response, attempt, baseDelay, random) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const exponential = Math.min(baseDelay * 2 ** (attempt - 1), 30000);
  return exponential + Math.floor(random() * 250);
}

function snippet(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

export class GitHubClient {
  constructor({ token, apiUrl = API_URL, uploadsUrl = UPLOADS_URL, fetchImpl = globalThis.fetch, sleep = wait, random = Math.random, maxAttempts = 5, baseDelay = 500 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.uploadsUrl = uploadsUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.random = random;
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
  }

  headers(extra = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'nextprob-plugin-registry',
      ...extra,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(method, target, { body, headers = {}, raw = false, allow404 = false, absolute = false } = {}) {
    const url = absolute ? target : `${this.apiUrl}${target}`;
    let payload = body;
    const requestHeaders = this.headers(headers);
    if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
      payload = JSON.stringify(body);
      requestHeaders['content-type'] = 'application/json';
    }
    let lastNetworkError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(url, { method, headers: requestHeaders, body: payload });
      } catch (error) {
        lastNetworkError = error;
        if (attempt === this.maxAttempts) break;
        await this.sleep(retryDelay(null, attempt, this.baseDelay, this.random));
        continue;
      }
      if (response.status === 404 && allow404) return null;
      if (response.ok) {
        if (raw) return Buffer.from(await response.arrayBuffer());
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      const text = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        await this.sleep(retryDelay(response, attempt, this.baseDelay, this.random));
        continue;
      }
      throw new Error(`GitHub API ${method} ${url} failed with ${response.status}: ${snippet(text)}`);
    }
    throw new Error(`GitHub API ${method} ${url} failed after ${this.maxAttempts} attempts: ${lastNetworkError?.message || 'network error'}`);
  }

  getReleaseByTag(repo, tag) {
    return this.request('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  }

  listReleases(repo) {
    return this.request('GET', `/repos/${repo}/releases?per_page=100`);
  }

  getRelease(repo, id) {
    return this.request('GET', `/repos/${repo}/releases/${id}`);
  }

  createRelease(repo, release) {
    return this.request('POST', `/repos/${repo}/releases`, { body: release });
  }

  updateRelease(repo, id, release) {
    return this.request('PATCH', `/repos/${repo}/releases/${id}`, { body: release });
  }

  listReleaseAssets(repo, id) {
    return this.request('GET', `/repos/${repo}/releases/${id}/assets?per_page=100`);
  }

  getReleaseAsset(repo, id) {
    return this.request('GET', `/repos/${repo}/releases/assets/${id}`);
  }

  uploadReleaseAsset(repo, releaseId, filename, bytes) {
    const target = `${this.uploadsUrl}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;
    return this.request('POST', target, {
      absolute: true,
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  downloadAsset(url) {
    return this.request('GET', url, {
      absolute: true,
      raw: true,
      headers: { accept: 'application/octet-stream' },
    });
  }
}

export function releaseAssetUrl(repo, tag, filename) {
  return `https://github.com/${repo}/releases/download/${tag}/${filename}`;
}
