window.ExtensionPackages.register('nextprob.publishing', (api) => {
const { showToast, TabState, ICONS } = api;
function listen(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  api.onDispose(() => target.removeEventListener(event, handler, options));
}
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const markup = `  <div id="publish-modal" class="hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box publish-modal-box glass">
      <h2 id="publish-modal-title">Share to web</h2>
      <p class="publish-note-name" id="publish-note-name"></p>
      <div id="publish-modal-body"></div>
      <div class="modal-actions" id="publish-modal-actions"></div>
    </div>
  </div>

  <div id="repo-confirm-modal" class="hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box repo-confirm-box glass">
      <h2>Create new repo?</h2>
      <p class="repo-confirm-availability">
        <code id="repo-confirm-name"></code>
        <span>is available on your account.</span>
      </p>

      <fieldset class="repo-confirm-options">
        <label class="repo-confirm-option">
          <input type="radio" name="repo-confirm-mode" value="provision-now" checked />
          <div class="repo-confirm-option-text">
            <div class="repo-confirm-option-name">Create it now</div>
            <div class="repo-confirm-option-desc">We'll create the repo and enable Pages now (one-time, ~30 seconds).</div>
          </div>
        </label>
        <label class="repo-confirm-option">
          <input type="radio" name="repo-confirm-mode" value="save-only" />
          <div class="repo-confirm-option-text">
            <div class="repo-confirm-option-name">Save the name for later</div>
            <div class="repo-confirm-option-desc">Just remember the name. Your next publish will create the repo automatically.</div>
          </div>
        </label>
      </fieldset>

      <div class="modal-actions">
        <button class="sharing-tab-link-btn" data-repo-confirm-action="pick-different">Pick a different name</button>
        <div style="flex:1"></div>
        <button class="btn-secondary" data-repo-confirm-action="pick-different">Cancel</button>
        <button class="btn-primary" data-repo-confirm-action="confirm">Continue</button>
      </div>
    </div>
  </div>

`;
const view = document.createElement("div"); view.innerHTML = markup; document.body.appendChild(view);
api.onDispose(() => view.remove());
async function copyShareLink(notePath) {
  const info = api.getResourceMetadata('publishing', notePath);
  const url = info && info.shareUrl;
  if (!url) {
    showToast('No share link found');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Share link copied');
  } catch (err) {
    showToast(`Copy failed: ${err.message || err}`);
  }
}
function buildPublishIndicator(notePath) {
  const span = document.createElement('span');
  span.className = 'tree-publish-indicator';
  span.title = 'Published — click to copy link';
  span.innerHTML = ICONS.link45;
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    copyShareLink(notePath);
  });
  return span;
}


// Single shared subscription to github:stateChanged so each consumer (the
// publish popover, the settings Sharing tab, …) doesn't accumulate IPC
// listeners across open/close cycles. Defined here so all later consumers
// (SecuritySettings, PublishModal) see the binding.
const _githubStateBroadcaster = (() => {
  const listeners = new Set();
  let attached = false;
  return {
    add(cb) {
      if (!attached) {
        attached = true;
        const unsubscribe = api.transport.subscribe('github:stateChanged', (state) => {
          listeners.forEach((fn) => { try { fn(state); } catch {} });
        });
        if (typeof unsubscribe === "function") api.onDispose(unsubscribe);
        api.onDispose(() => listeners.clear());
      }
      listeners.add(cb);
    },
    remove(cb) { listeners.delete(cb); },
  };
})();


const PublishModal = {
  _resolve: null,
  _state: null,
  _path: null,
  _onClick: null,
  _onKey: null,
  _onGithubState: null,

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  async open(notePath, noteDisplayName) {
    if (this._resolve !== null) return null;
    this._path = notePath;

    const modal = document.getElementById('publish-modal');
    document.getElementById('publish-note-name').textContent = noteDisplayName || notePath || '';
    modal.classList.remove('hidden');

    this._onClick = (e) => this._handleClick(e);
    modal.addEventListener('click', this._onClick);

    this._onKey = (e) => {
      if (e.key === 'Escape' && this._state !== 'working' && this._state !== 'connecting') {
        e.preventDefault(); this.close(null);
      }
    };
    listen(document, 'keydown', this._onKey, true);

    this._onGithubState = (s) => this._handleGithubState(s);
    _githubStateBroadcaster.add(this._onGithubState);

    const state = await api.transport.invoke('github:getState');
    this._renderFromState(state);

    return new Promise((resolve) => { this._resolve = resolve; });
  },

  close(result) {
    if (this._resolve === null) return;
    const modal = document.getElementById('publish-modal');
    modal.classList.add('hidden');
    if (this._onClick) { modal.removeEventListener('click', this._onClick); this._onClick = null; }
    if (this._onKey)   { document.removeEventListener('keydown', this._onKey, true); this._onKey = null; }
    if (this._onGithubState) { _githubStateBroadcaster.remove(this._onGithubState); this._onGithubState = null; }
    this._state = null;
    this._path = null;
    const r = this._resolve;
    this._resolve = null;
    r(result);
  },

  _renderFromState(state) {
    if (!state || state.status === 'disconnected') return this._setState('connect');
    if (state.status === 'connecting') return this._setState('connecting', state);
    if (state.status === 'connected' && !state.repoName) return this._setState('repo', { user: state.user });
    if (state.status === 'connected') return this._setState('ready', { user: state.user, repoName: state.repoName });
  },

  _handleGithubState(state) {
    // Only react while we're in a state that's waiting on auth
    if (this._state !== 'connect' && this._state !== 'connecting') return;
    this._renderFromState(state);
  },

  _setState(name, ctx = {}) {
    this._state = name;
    const body = document.getElementById('publish-modal-body');
    const actions = document.getElementById('publish-modal-actions');

    if (name === 'connect') {
      body.innerHTML = `
        <p>Sharing notes uses your own GitHub account. Notes are stored as gists and rendered via GitHub Pages — no nextprob servers in the path.</p>`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="cancel">Cancel</button>
        <button class="btn-primary" data-pm-action="connect">Connect GitHub</button>`;
      return;
    }
    if (name === 'connecting') {
      body.innerHTML = `
        <p>Confirm this code in the GitHub page that just opened:</p>
        <p><span class="publish-device-code">${this._esc(ctx.userCode || '')}</span></p>
        <p class="publish-dim">Waiting for authorization…</p>`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="cancel-connect">Cancel</button>`;
      return;
    }
    if (name === 'repo') {
      const u = ctx.user || {};
      body.innerHTML = `
        <div class="publish-user-line">
          ${u.avatarUrl ? `<img class="publish-user-avatar" src="${this._esc(u.avatarUrl)}" alt="">` : ''}
          <span>Connected as <strong>${this._esc(u.login || '')}</strong></span>
        </div>
        <p>Pick a name for the GitHub repo that will host your share site. We'll create it on your account and add a small renderer page.</p>
        <label class="field-label" for="publish-repo-name">Repo name</label>
        <input type="text" id="publish-repo-name" value="my-shared-notes" autocomplete="off" spellcheck="false" />
        <p id="publish-repo-validation" class="publish-validation hidden"></p>`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="cancel">Cancel</button>
        <button class="btn-primary" data-pm-action="continue">Continue</button>`;
      const input = document.getElementById('publish-repo-name');
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._doSetRepo(); }
      });
      return;
    }
    if (name === 'ready') {
      const u = ctx.user || {};
      body.innerHTML = `
        <div class="publish-user-line">
          ${u.avatarUrl ? `<img class="publish-user-avatar" src="${this._esc(u.avatarUrl)}" alt="">` : ''}
          <span>Connected as <strong>${this._esc(u.login || '')}</strong> — using <code>${this._esc(ctx.repoName || '')}</code></span>
        </div>
        <fieldset class="publish-visibility">
          <legend>Who can see it?</legend>
          <label class="publish-visibility-option">
            <input type="radio" name="publish-visibility" value="secret" checked>
            <div class="publish-visibility-text">
              <span class="publish-visibility-name">Anyone with the link</span>
              <span class="publish-visibility-desc">Stored as a secret gist. Not on your GitHub profile, not crawled by search engines.</span>
            </div>
          </label>
          <label class="publish-visibility-option">
            <input type="radio" name="publish-visibility" value="public">
            <div class="publish-visibility-text">
              <span class="publish-visibility-name">Public on the web</span>
              <span class="publish-visibility-desc">Stored as a public gist. Findable by Google and listed on your GitHub profile.</span>
            </div>
          </label>
        </fieldset>`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="cancel">Cancel</button>
        <button class="btn-primary" data-pm-action="publish">Publish</button>`;
      return;
    }
    if (name === 'working') {
      const msg = ctx.firstProvision
        ? 'Setting up your share site (one-time, ~30 seconds)…'
        : 'Publishing…';
      body.innerHTML = `
        <div class="publish-working">
          <div class="publish-spinner"></div>
          <span>${this._esc(msg)}</span>
        </div>`;
      actions.innerHTML = '';
      return;
    }
    if (name === 'success') {
      const url = ctx.shareUrl || '';
      body.innerHTML = `
        <p>Link copied to clipboard.</p>
        <input type="text" class="publish-success-url" id="publish-success-url" readonly value="${this._esc(url)}">
        ${ctx.usesBackendAPIs ? `<p class="publish-dim">Note: backend APIs won't work in browser.</p>` : ''}
        ${ctx.sizeWarning ? `<p class="publish-dim">${this._esc(ctx.sizeWarning)}</p>` : ''}`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="open">Open</button>
        <button class="btn-secondary" data-pm-action="copy">Copy</button>
        <button class="btn-primary" data-pm-action="done">Done</button>`;
      navigator.clipboard.writeText(url).catch(() => {});
      return;
    }
    if (name === 'error') {
      body.innerHTML = `<p class="publish-error">${this._esc(ctx.message || 'Publish failed.')}</p>`;
      actions.innerHTML = `
        <button class="btn-secondary" data-pm-action="cancel">Close</button>
        <button class="btn-primary" data-pm-action="retry">Retry</button>`;
    }
  },

  async _handleClick(e) {
    if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
      if (this._state !== 'working' && this._state !== 'connecting') this.close(null);
      return;
    }
    const btn = e.target.closest('[data-pm-action]');
    if (!btn) return;
    const action = btn.dataset.pmAction;
    if (action === 'cancel') return this.close(null);
    if (action === 'connect') return this._doConnect();
    if (action === 'cancel-connect') {
      try { await api.transport.invoke('github:cancelConnect'); } catch {}
      return this._setState('connect');
    }
    if (action === 'continue') return this._doSetRepo();
    if (action === 'publish')  return this._doPublish();
    if (action === 'retry') {
      const s = await api.transport.invoke('github:getState');
      return this._renderFromState(s);
    }
    if (action === 'open') {
      const url = document.getElementById('publish-success-url')?.value;
      if (url) window.open(url, '_blank');
      return;
    }
    if (action === 'copy') {
      const url = document.getElementById('publish-success-url')?.value;
      if (url) navigator.clipboard.writeText(url).catch(() => {});
      return;
    }
    if (action === 'done') return this.close({ success: true });
  },

  async _doConnect() {
    try {
      const res = await api.transport.invoke('github:connect');
      if (res?.ok && res.data) {
        this._setState('connecting', { userCode: res.data.userCode });
      } else {
        this._setState('error', { message: (res && res.error) || 'Could not start GitHub authentication.' });
      }
    } catch (err) {
      this._setState('error', { message: err.message || String(err) });
    }
  },

  async _doSetRepo() {
    const input = document.getElementById('publish-repo-name');
    const validation = document.getElementById('publish-repo-validation');
    const setError = (msg) => {
      validation.textContent = msg;
      validation.classList.remove('hidden', 'publish-validation--info');
    };
    const setInfo = (msg) => {
      validation.textContent = msg;
      validation.classList.remove('hidden');
      validation.classList.add('publish-validation--info');
    };

    const name = (input && input.value || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') {
      return setError('Use letters, numbers, dots, hyphens, underscores. Max 100 chars.');
    }
    if (input) input.disabled = true;
    setInfo('Checking…');
    const check = await api.transport.invoke('github:checkRepoName', name);
    if (input) input.disabled = false;
    if (!check || !check.ok) {
      setError((check && check.message) || 'Repo name not available.');
      input?.focus();
      return;
    }
    const res = await api.transport.invoke('github:setRepoName', name);
    if (!res || !res.ok) {
      return setError((res && res.error) || 'Could not save repo name.');
    }
    const s = await api.transport.invoke('github:getState');
    this._setState('ready', { user: s.user, repoName: s.repoName });
    if (check.status === 'reusable') {
      showToast(`Repo set to "${name}" — reusing your existing renderer repo.`);
    } else {
      showToast(`Repo set to "${name}" — will be created on your next publish.`);
    }
  },

  async _doPublish() {
    let visibility = 'secret';
    document.querySelectorAll('input[name="publish-visibility"]').forEach((r) => {
      if (r.checked) visibility = r.value;
    });

    // Heuristic: a slow first-time provisioning is likely if the active user
    // hasn't yet published from this app. We don't actually know — the backend
    // returns `firstProvision: true` when applicable — so the copy nudges the
    // user that one publish may take longer. Better than a blank spinner.
    this._setState('working', { firstProvision: true });

    try {
      const result = await api.transport.invoke('export:publish', this._path, { visibility });
      if (result && result.error) {
        if (result.error === 'github-not-connected') return this._setState('connect');
        if (result.error === 'github-no-repo-name') {
          const s = await api.transport.invoke('github:getState');
          return this._setState('repo', { user: s.user });
        }
        return this._setState('error', { message: result.message || result.error });
      }
      if (result && result.success) {
        return this._setState('success', {
          shareUrl: result.shareUrl,
          usesBackendAPIs: result.usesBackendAPIs,
          sizeWarning: result.sizeWarning,
        });
      }
      this._setState('error', { message: 'Unexpected publish response.' });
    } catch (err) {
      this._setState('error', { message: err.message || String(err) });
    }
  },
};


const _modal = document.getElementById("security-settings-modal");
  let _repoEditing = false;
  let _repoConfirmAvailable = null; // pending name string while user picks Create now / later / different
  let _repoWorking = false;
  let _repoSuccessFor = null; // repo name to display a "ready" check for, briefly after provisioning

  function _resetSharingState() {
    _repoEditing = false;
    _repoConfirmAvailable = null;
    _repoWorking = false;
    _repoSuccessFor = null;
  }

  async function _renderSharingPane(presetState) {
    const body = document.getElementById('sharing-settings-body');
    const state = presetState || await api.transport.invoke('github:getState');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    if (!state || state.status === 'disconnected') {
      _resetSharingState();
      body.innerHTML = `
        <p class="sharing-tab-desc">
          Sharing publishes individual notes to your own GitHub account as gists, rendered through GitHub Pages.
           No nextprob servers in the path.
        </p>
        <div class="sharing-tab-actions">
          <button class="btn-primary" data-sharing-action="connect">Connect GitHub</button>
        </div>`;
      return;
    }

    if (state.status === 'connecting') {
      _resetSharingState();
      body.innerHTML = `
        <p class="sharing-tab-desc">Confirm this code in the GitHub page that just opened:</p>
        <p><span class="publish-device-code">${esc(state.userCode || '')}</span></p>
        <p class="sharing-tab-desc">Waiting for authorization…</p>
        <div class="sharing-tab-actions">
          <button class="btn-secondary" data-sharing-action="cancel-connect">Cancel</button>
        </div>`;
      return;
    }

    // connected
    const u = state.user || {};
    const statusHtml = `
      <div class="sharing-tab-status">
        <span class="sharing-tab-dot sharing-tab-dot--connected"></span>
        <span>Connected as <strong>@${esc(u.login || '')}</strong></span>
      </div>`;
    const disconnectHtml = `
      <div class="sharing-tab-actions">
        <button class="btn-secondary" data-sharing-action="disconnect">Disconnect GitHub</button>
      </div>`;

    if (_repoWorking) {
      body.innerHTML = `
        ${statusHtml}
        <div class="sharing-repo-block">
          <div class="publish-working">
            <div class="publish-spinner"></div>
            <span>Creating repo and enabling Pages…</span>
            <span class="publish-working-timer" id="repo-working-timer">0:00 / ~30s</span>
          </div>
        </div>
        ${disconnectHtml}`;
      return;
    }

    if (_repoSuccessFor) {
      body.innerHTML = `
        ${statusHtml}
        <div class="sharing-repo-block">
          <div class="publish-success">
            <span class="publish-checkmark" aria-hidden="true">&check;</span>
            <span>Repo <code>${esc(_repoSuccessFor)}</code> is ready.</span>
          </div>
        </div>
        ${disconnectHtml}`;
      return;
    }

    let repoValueHtml;
    if (_repoEditing) {
      const current = state.repoName || 'my-shared-notes';
      repoValueHtml = `
        <input type="text" id="sharing-repo-input" value="${esc(current)}" autocomplete="off" spellcheck="false" />
        <button class="sharing-tab-link-btn" data-sharing-action="save-repo">Save</button>
        <button class="sharing-tab-link-btn" data-sharing-action="cancel-repo">Cancel</button>`;
    } else if (state.repoName) {
      repoValueHtml = `<code>${esc(state.repoName)}</code> <button class="sharing-tab-link-btn" data-sharing-action="change-repo">Change…</button>`;
    } else {
      repoValueHtml = `<em>Not picked yet</em> <button class="sharing-tab-link-btn" data-sharing-action="change-repo">Pick…</button>`;
    }

    body.innerHTML = `
      ${statusHtml}
      <div class="sharing-tab-row">
        <span class="sharing-tab-row-label">Renderer repo</span>
        <span class="sharing-tab-row-value">${repoValueHtml}</span>
      </div>
      <p id="sharing-repo-validation" class="publish-validation hidden"></p>
      ${disconnectHtml}`;

    if (_repoEditing) {
      const input = document.getElementById('sharing-repo-input');
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _saveRepoEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); _repoEditing = false; _renderSharingPane(); }
      });
    }
  }

  async function _saveRepoEdit() {
    const input = document.getElementById('sharing-repo-input');
    const validation = document.getElementById('sharing-repo-validation');
    const setError = (msg) => {
      validation.textContent = msg;
      validation.classList.remove('hidden', 'publish-validation--info');
    };
    const setInfo = (msg) => {
      validation.textContent = msg;
      validation.classList.remove('hidden');
      validation.classList.add('publish-validation--info');
    };

    const next = (input?.value || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(next) || next === '.' || next === '..') {
      return setError('Use letters, numbers, dots, hyphens, underscores. Max 100 chars.');
    }
    if (input) input.disabled = true;
    setInfo('Checking…');
    const check = await api.transport.invoke('github:checkRepoName', next);
    if (input) input.disabled = false;
    if (!check || !check.ok) {
      setError((check && check.message) || 'Repo name not available.');
      input?.focus();
      return;
    }

    if (check.status === 'reusable') {
      // Existing my-shared-notes repo of theirs — save and proceed silently.
      const res = await api.transport.invoke('github:setRepoName', next);
      if (!res || !res.ok) {
        return setError((res && res.error) || 'Could not update repo name.');
      }
      _repoEditing = false;
      _renderSharingPane();
      showToast(`Repo set to "${next}" — reusing your existing renderer repo.`);
      return;
    }

    // status === 'available' — name is free. Open the confirmation modal
    // layered on top so the user can choose between create-now, defer, or rename.
    // Leave _repoEditing = true so the input remains visible underneath; if the
    // user dismisses the modal they land back in edit mode with their name typed.
    _repoConfirmAvailable = next;
    if (validation) {
      validation.textContent = '';
      validation.classList.add('hidden');
    }
    _showRepoConfirmModal(next);
  }

  async function _saveAvailableDeferred() {
    const name = _repoConfirmAvailable;
    if (!name) return;
    const res = await api.transport.invoke('github:setRepoName', name);
    _repoConfirmAvailable = null;
    if (!res || !res.ok) {
      _renderSharingPane();
      showToast(`Could not save repo name: ${(res && res.error) || 'unknown error'}`);
      return;
    }
    _renderSharingPane();
    showToast(`Repo set to "${name}" — will be created on your next publish.`);
  }

  async function _provisionRepoNow() {
    const name = _repoConfirmAvailable;
    if (!name) return;
    const setRes = await api.transport.invoke('github:setRepoName', name);
    if (!setRes || !setRes.ok) {
      _repoConfirmAvailable = null;
      _renderSharingPane();
      showToast(`Could not save repo name: ${(setRes && setRes.error) || 'unknown error'}`);
      return;
    }
    _repoConfirmAvailable = null;
    _repoWorking = true;
    _renderSharingPane();

    const startedAt = Date.now();
    const timerInterval = setInterval(() => {
      const el = document.getElementById('repo-working-timer');
      if (!el) return;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      el.textContent = `${m}:${String(s).padStart(2, '0')} / ~30s`;
    }, 1000);

    const result = await api.transport.invoke('github:provisionRepo');
    clearInterval(timerInterval);
    _repoWorking = false;
    if (result && result.ok) {
      _repoSuccessFor = name;
      _renderSharingPane();
      setTimeout(() => {
        if (_repoSuccessFor === name) {
          _repoSuccessFor = null;
          _renderSharingPane();
        }
      }, 2500);
    } else {
      _renderSharingPane();
      showToast(`Could not create repo: ${(result && result.error) || 'unknown error'}`);
    }
  }

  async function _handleSharingClick(e) {
    const btn = e.target.closest('[data-sharing-action]');
    if (!btn) return;
    const action = btn.dataset.sharingAction;
    if (action === 'connect') {
      try { await api.transport.invoke('github:connect'); } catch {}
    } else if (action === 'cancel-connect') {
      try { await api.transport.invoke('github:cancelConnect'); } catch {}
      _renderSharingPane();
    } else if (action === 'disconnect') {
      const ok = confirm(
        'Disconnect GitHub? Existing share links will keep working. Re-connecting will let you share new notes.'
      );
      if (!ok) return;
      try { await api.transport.invoke('github:disconnect'); } catch {}
      _renderSharingPane();
    } else if (action === 'change-repo') {
      _repoConfirmAvailable = null;
      _repoEditing = true;
      _renderSharingPane();
    } else if (action === 'save-repo') {
      _saveRepoEdit();
    } else if (action === 'cancel-repo') {
      _repoEditing = false;
      _renderSharingPane();
    }
  }

  function _showRepoConfirmModal(name) {
    const modal = document.getElementById('repo-confirm-modal');
    if (!modal) return;
    document.getElementById('repo-confirm-name').textContent = name;
    const defaultRadio = modal.querySelector('input[name="repo-confirm-mode"][value="provision-now"]');
    if (defaultRadio) defaultRadio.checked = true;
    modal.classList.remove('hidden');
    modal.querySelector('[data-repo-confirm-action="confirm"]')?.focus();
  }

  function _hideRepoConfirmModal() {
    const modal = document.getElementById('repo-confirm-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function _pickDifferentName() {
    const lastTyped = _repoConfirmAvailable;
    _hideRepoConfirmModal();
    _repoConfirmAvailable = null;
    _repoEditing = true;
    await _renderSharingPane();
    const input = document.getElementById('sharing-repo-input');
    if (input && lastTyped) {
      input.value = lastTyped;
      input.focus();
      input.select();
    }
  }

  function _handleRepoConfirmClick(e) {
    const btn = e.target.closest('[data-repo-confirm-action]');
    if (!btn) return;
    const action = btn.dataset.repoConfirmAction;
    if (action === 'confirm') {
      const modal = document.getElementById('repo-confirm-modal');
      const choice = modal.querySelector('input[name="repo-confirm-mode"]:checked')?.value;
      _hideRepoConfirmModal();
      if (choice === 'save-only') _saveAvailableDeferred();
      else _provisionRepoNow();
    } else if (action === 'pick-different') {
      _pickDifferentName();
    }
  }


api.contributeSettings({ id: "sharing", label: "Sharing", before: "project", html: '<div id="sharing-settings-body"></div>', onShow: _renderSharingPane, onHide() { _hideRepoConfirmModal(); _resetSharingState(); } });
    // Live-update the Sharing pane when GitHub state changes from anywhere
    // (popover, devtools, etc.)
    _githubStateBroadcaster.add((state) => {
      if (_modal.classList.contains('hidden')) return;
      const activePane = _modal.querySelector('.app-settings-pane:not(.hidden)');
      if (activePane && activePane.dataset.appPane === 'sharing') {
        _renderSharingPane(state);
      }
    });

    // Wire delegated clicks inside the sharing pane
    const sharingBody = document.getElementById('sharing-settings-body');
    sharingBody.addEventListener('click', _handleSharingClick);

    // Wire the repo-confirm modal (layered over Settings → Sharing)
    const confirmModal = document.getElementById('repo-confirm-modal');
    if (confirmModal) {
      confirmModal.addEventListener('click', _handleRepoConfirmClick);
      confirmModal.querySelector('.modal-backdrop')?.addEventListener('click', _pickDifferentName);
      confirmModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); _pickDifferentName(); }
      });
    }
api.contributeIndicator(path => api.getResourceMetadata('publishing', path) ? buildPublishIndicator(path) : null);
api.contributeMenu('resource.actions', target => target.type !== 'note' ? [] : api.getResourceMetadata('publishing', target.path) ? [
 {label:'Republish',action:'sidebar-republish-note'}, {label:'Copy Link',action:'sidebar-copy-share-link'}, {label:'Unpublish',action:'sidebar-unpublish-note'}
] : [{label:'Publish as Link', action:'sidebar-publish-note'}], 60);
api.registerCommand('sidebar-publish-note', target => handleAction('sidebar-publish-note', target));
api.registerCommand('sidebar-republish-note', target => handleAction('sidebar-republish-note', target));
api.registerCommand('sidebar-copy-share-link', target => handleAction('sidebar-copy-share-link', target));
api.registerCommand('sidebar-unpublish-note', target => handleAction('sidebar-unpublish-note', target));
async function handleAction(action,target) { switch(action) {
    case 'sidebar-publish-note': {
      const displayName = (target.path || '').split('/').pop() || target.path;
      await PublishModal.open(target.path, displayName);
      await api.refreshMetadata();
      api.renderTree();
      break;
    }
    case 'sidebar-republish-note': {
      // Silent re-upload: skip the modal, reuse stored visibility.
      const info = api.getResourceMetadata('publishing', target.path);
      const visibility = (info && info.visibility) || 'secret';
      showToast('Republishing note\u2026');
      try {
        const result = await api.transport.invoke('export:publish', target.path, { visibility });
        if (result && result.error) {
          // GitHub disconnected, repo gone, etc. \u2192 fall back to the modal so
          // the user can reconnect / pick a repo without losing the action.
          if (result.error === 'github-not-connected' || result.error === 'github-no-repo-name') {
            const displayName = (target.path || '').split('/').pop() || target.path;
            await PublishModal.open(target.path, displayName);
            await api.refreshMetadata();
            api.renderTree();
          } else {
            showToast(`Republish failed: ${result.error}`);
          }
        } else if (result && result.success) {
          showToast('Note republished');
          await api.refreshMetadata();
          api.renderTree();
        }
      } catch (err) {
        showToast(`Republish failed: ${err.message || err}`);
      }
      break;
    }
    case 'sidebar-copy-share-link': {
      await copyShareLink(target.path);
      break;
    }
    case 'sidebar-unpublish-note': {
      showToast('Unpublishing note\u2026');
      try {
        const result = await api.transport.invoke('export:unpublish', target.path);
        if (result.error) {
          showToast(`Unpublish failed: ${result.error}`);
        } else if (result.success) {
          showToast('Note unpublished');
          await api.refreshMetadata();
          api.renderTree();
        }
      } catch (err) {
        showToast(`Unpublish failed: ${err.message}`);
      }
      break;
    }

} }

});
