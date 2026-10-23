import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RENDERER_PATH = path.join(ROOT, 'plugins', 'nextprob.export-engine', 'renderer.js');
const NOTE_PATH = '/workspace/notes/demo/index.html';

const KNOWN_LABELS = {
  pdf: 'PDF',
  markdown: 'Markdown (.md)',
  plaintext: 'Plain Text (.txt)',
  html: 'HTML (copy)',
};

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(text) {
  const attributes = [];
  const pattern = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    attributes.push({ name: match[1], value: decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') });
  }
  return attributes;
}

function toKebabCase(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function makeEvent(type, props = {}) {
  return {
    type,
    bubbles: true,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    _stopPropagation: false,
    _stopImmediatePropagation: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopPropagation = true; },
    stopImmediatePropagation() {
      this._stopPropagation = true;
      this._stopImmediatePropagation = true;
    },
    ...props,
  };
}

function matchCompound(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  const tokenPattern = /([a-zA-Z][\w:-]*|\*|#[-\w]+|\.[-\w]+|\[[^\]]+\])/g;
  let token;
  while ((token = tokenPattern.exec(compound))) {
    const part = token[0];
    if (part === '*') continue;
    if (part.startsWith('#')) {
      if (node.getAttribute('id') !== part.slice(1)) return false;
      continue;
    }
    if (part.startsWith('.')) {
      const classes = node.className.split(/\s+/).filter(Boolean);
      if (!classes.includes(part.slice(1))) return false;
      continue;
    }
    if (part.startsWith('[')) {
      const inner = part.slice(1, -1).trim();
      const equals = inner.indexOf('=');
      if (equals === -1) {
        if (!node.hasAttribute(inner)) return false;
        continue;
      }
      const name = inner.slice(0, equals).trim();
      let expected = inner.slice(equals + 1).trim();
      if ((expected.startsWith('"') && expected.endsWith('"'))
        || (expected.startsWith("'") && expected.endsWith("'"))) {
        expected = expected.slice(1, -1);
      }
      if (node.getAttribute(name) !== expected) return false;
      continue;
    }
    if (node.tagName !== part.toUpperCase()) return false;
  }
  return true;
}

function matchChain(node, selector) {
  const parts = selector.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let index = parts.length - 2;
  let current = node.parentNode;
  while (current && index >= 0) {
    if (current.nodeType === 1 && matchCompound(current, parts[index])) index -= 1;
    current = current.parentNode;
  }
  return index < 0;
}

function collectMatches(root, selector) {
  const results = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (matchChain(child, selector)) results.push(child);
      visit(child);
    }
  };
  visit(root);
  return results;
}

function addListener(target, type, handler) {
  if (!handler) return;
  const listeners = target._listeners.get(type) || [];
  if (!listeners.some((entry) => entry.handler === handler)) listeners.push({ handler });
  target._listeners.set(type, listeners);
}

function removeListener(target, type, handler) {
  const listeners = target._listeners.get(type);
  if (!listeners) return;
  target._listeners.set(type, listeners.filter((entry) => entry.handler !== handler));
}

function dispatchEventPath(eventPath, event) {
  if (event.target == null) event.target = eventPath[0];
  for (const target of eventPath) {
    if (event._stopPropagation) break;
    event.currentTarget = target;
    const listeners = target._listeners.get(event.type);
    if (!listeners) continue;
    for (const entry of listeners.slice()) {
      if (typeof entry.handler === 'function') entry.handler.call(target, event);
      else if (entry.handler && typeof entry.handler.handleEvent === 'function') entry.handler.handleEvent(event);
      if (event._stopImmediatePropagation) break;
    }
  }
  event.currentTarget = null;
  return !event.defaultPrevented;
}

class FakeTextNode {
  constructor(nodeValue, ownerDocument) {
    this.nodeType = 3;
    this.nodeValue = String(nodeValue);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(value) {
    this.nodeValue = String(value);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    return node === this;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._attributes = new Map();
    this._listeners = new Map();
    this.dataset = new Proxy({}, {
      get: (_, property) => {
        if (typeof property !== 'string') return undefined;
        return this._attributes.get(`data-${toKebabCase(property)}`);
      },
      set: (_, property, value) => {
        this.setAttribute(`data-${toKebabCase(property)}`, value);
        return true;
      },
      has: (_, property) => typeof property === 'string'
        && this._attributes.has(`data-${toKebabCase(property)}`),
      deleteProperty: (_, property) => {
        if (typeof property === 'string') this._attributes.delete(`data-${toKebabCase(property)}`);
        return true;
      },
      ownKeys: () => [...this._attributes.keys()]
        .filter((name) => name.startsWith('data-'))
        .map((name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())),
      getOwnPropertyDescriptor: (_, property) => {
        if (typeof property !== 'string') return undefined;
        const value = this._attributes.get(`data-${toKebabCase(property)}`);
        if (value === undefined) return undefined;
        return { value, writable: true, enumerable: true, configurable: true };
      },
    });
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get classList() {
    const element = this;
    const read = () => element.className.split(/\s+/).filter(Boolean);
    const write = (classes) => {
      element.className = classes.join(' ');
    };
    return {
      add(...names) {
        const classes = read();
        for (const name of names) {
          if (!classes.includes(name)) classes.push(name);
        }
        write(classes);
      },
      remove(...names) {
        write(read().filter((name) => !names.includes(name)));
      },
      contains(name) {
        return read().includes(name);
      },
      toggle(name, force) {
        const classes = read();
        const has = classes.includes(name);
        const shouldAdd = force === undefined ? !has : Boolean(force);
        if (shouldAdd && !has) classes.push(name);
        else if (!shouldAdd && has) classes.splice(classes.indexOf(name), 1);
        write(classes);
        return shouldAdd;
      },
      item(index) {
        return read()[index] ?? null;
      },
      get length() {
        return read().length;
      },
      toString() {
        return element.className;
      },
      [Symbol.iterator]() {
        return read()[Symbol.iterator]();
      },
    };
  }

  get textContent() {
    return this.childNodes
      .map((child) => (child.nodeType === 3 ? child.nodeValue : child.textContent))
      .join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = value == null ? '' : String(value);
    if (!text) return;
    const node = new FakeTextNode(text, this.ownerDocument);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  set innerHTML(html) {
    this.textContent = '';
    const source = html == null ? '' : String(html);
    const stack = [this];
    let index = 0;
    let text = '';
    const flushText = () => {
      if (!text) return;
      const value = decodeEntities(text);
      text = '';
      if (value) stack[stack.length - 1].appendChild(this.ownerDocument.createTextNode(value));
    };
    while (index < source.length) {
      const open = source.indexOf('<', index);
      if (open === -1) {
        text += source.slice(index);
        break;
      }
      text += source.slice(index, open);
      const close = source.indexOf('>', open);
      if (close === -1) {
        text += source.slice(open);
        break;
      }
      flushText();
      const raw = source.slice(open + 1, close).trim();
      index = close + 1;
      if (!raw || raw.startsWith('!') || raw.startsWith('?')) continue;
      if (raw.startsWith('/')) {
        const tag = raw.slice(1).trim().toLowerCase();
        for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
          if (stack[depth].tagName.toLowerCase() === tag) {
            stack.length = depth;
            break;
          }
        }
        continue;
      }
      const selfClosing = raw.endsWith('/');
      const content = selfClosing ? raw.slice(0, -1).trim() : raw;
      const tagMatch = /^([a-zA-Z][\w:-]*)/.exec(content);
      if (!tagMatch) continue;
      const tag = tagMatch[1].toLowerCase();
      const element = this.ownerDocument.createElement(tag);
      for (const { name, value } of parseAttributes(content.slice(tagMatch[1].length))) {
        element.setAttribute(name, value);
      }
      stack[stack.length - 1].appendChild(element);
      if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
    }
    flushText();
  }

  setAttribute(name, value) {
    this._attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    const key = String(name);
    return this._attributes.has(key) ? this._attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this._attributes.has(String(name));
  }

  removeAttribute(name) {
    this._attributes.delete(String(name));
  }

  appendChild(node) {
    if (!node) return node;
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, referenceNode) {
    if (!referenceNode) return this.appendChild(node);
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.insertBefore(child, referenceNode);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) throw new Error('Reference node is not a child');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.appendChild(this.ownerDocument.createTextNode(node));
      else this.appendChild(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) return node;
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  matches(selector) {
    return matchChain(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current && current.nodeType === 1) {
      if (matchChain(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return collectMatches(this, selector);
  }

  addEventListener(type, handler) {
    addListener(this, type, handler);
  }

  removeEventListener(type, handler) {
    removeListener(this, type, handler);
  }

  dispatchEvent(event) {
    const resolved = typeof event === 'string' ? makeEvent(event) : event;
    if (!resolved.target) resolved.target = this;
    const eventPath = [];
    let current = this;
    while (current) {
      eventPath.push(current);
      current = current.parentNode;
    }
    return dispatchEventPath(eventPath, resolved);
  }

  dispatch(type, props) {
    const event = typeof type === 'string' ? makeEvent(type, props) : type;
    return this.dispatchEvent(event);
  }

  click() {
    return this.dispatch('click');
  }
}

class FakeDocumentFragment {
  constructor(ownerDocument) {
    this.nodeType = 11;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get textContent() {
    return this.childNodes
      .map((child) => (child.nodeType === 3 ? child.nodeValue : child.textContent))
      .join('');
  }

  appendChild(node) {
    if (!node) return node;
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, referenceNode) {
    if (!referenceNode) return this.appendChild(node);
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.insertBefore(child, referenceNode);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) throw new Error('Reference node is not a child');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.appendChild(this.ownerDocument.createTextNode(node));
      else this.appendChild(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) return node;
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return collectMatches(this, selector);
  }
}

class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.ownerDocument = null;
    this._listeners = new Map();
    this.documentElement = new FakeElement('html', this);
    this.documentElement.parentNode = this;
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(value) {
    return new FakeTextNode(value, this);
  }

  createDocumentFragment() {
    return new FakeDocumentFragment(this);
  }

  getElementById(id) {
    return this._elements().find((element) => element.getAttribute('id') === id) || null;
  }

  _elements() {
    const elements = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        elements.push(child);
        visit(child);
      }
    };
    visit(this.documentElement);
    return elements;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type, handler) {
    addListener(this, type, handler);
  }

  removeEventListener(type, handler) {
    removeListener(this, type, handler);
  }

  dispatchEvent(event) {
    return dispatchEventPath([this], event);
  }
}

function makeTabState({ noteOpen = true } = {}) {
  if (!noteOpen) {
    return {
      getFocusedPanel: () => null,
      getState: () => ({ panels: [] }),
      getActiveTab: () => null,
    };
  }
  const panel = { id: 'panel-1', activeTabId: 'tab-1' };
  const tab = { id: 'tab-1', type: 'note', filePath: NOTE_PATH, title: 'demo' };
  return {
    getFocusedPanel: () => panel,
    getState: () => ({ panels: [panel] }),
    getActiveTab: (panelId) => (panelId === panel.id ? tab : null),
  };
}

function createHarness({ noteOpen = true } = {}) {
  const document = new FakeDocument();
  const toasts = [];
  const disposers = [];
  const services = new Map();
  const keybindings = [];
  const captured = { packageId: null, activate: null };
  const TabState = makeTabState({ noteOpen });

  const setTimeoutStub = (callback) => {
    if (typeof callback === 'function') callback();
    return 0;
  };

  const windowObject = {
    ExtensionPackages: {
      register(packageId, activate) {
        captured.packageId = packageId;
        captured.activate = activate;
      },
    },
    document,
    setTimeout: setTimeoutStub,
  };

  const sandbox = {
    window: windowObject,
    document,
    setTimeout: setTimeoutStub,
    clearTimeout() {},
    console,
  };

  const api = {
    showToast(message) {
      toasts.push(String(message));
    },
    TabState,
    ICONS: {},
    onDispose(dispose) {
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    registerKeybinding(handler) {
      keybindings.push(handler);
      return () => {
        const index = keybindings.indexOf(handler);
        if (index >= 0) keybindings.splice(index, 1);
      };
    },
    registerService(name, service) {
      services.set(name, service);
      return () => {
        if (services.get(name) === service) services.delete(name);
      };
    },
    getService(name) {
      return services.get(name);
    },
    transport: {
      invoke: async () => ({}),
      send() {},
      subscribe: () => () => {},
    },
  };

  const source = fs.readFileSync(RENDERER_PATH, 'utf8');
  vm.runInNewContext(source, sandbox, { filename: RENDERER_PATH });
  assert.equal(captured.packageId, 'nextprob.export-engine');
  assert.equal(typeof captured.activate, 'function');
  captured.activate(api);

  function getPicker() {
    return document.getElementById('export-format-picker');
  }

  function actions() {
    const picker = getPicker();
    return picker ? picker.querySelectorAll('button[data-fmt]') : [];
  }

  function actionFormats() {
    return actions().map((button) => button.dataset.fmt);
  }

  function labels() {
    return actions().map((button) => button.textContent);
  }

  function triggerKeybinding(props = {}) {
    assert.ok(keybindings.length > 0, 'renderer registered a keybinding');
    const event = makeEvent('keydown', {
      key: 'E',
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      ...props,
    });
    return { handled: keybindings[0](event), event };
  }

  function openPicker(props) {
    return triggerKeybinding(props);
  }

  function disposeAll() {
    while (disposers.length) {
      const dispose = disposers.pop();
      try {
        dispose();
      } catch {}
    }
  }

  function cleanup() {
    disposeAll();
    keybindings.length = 0;
    services.clear();
  }

  return {
    document,
    toasts,
    services,
    keybindings,
    api,
    get formats() {
      return services.get('nextprob.export-formats');
    },
    getPicker,
    actions,
    actionFormats,
    labels,
    triggerKeybinding,
    openPicker,
    disposeAll,
    cleanup,
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buttonFor(harness, format) {
  return harness.actions().find((button) => button.dataset.fmt === format) || null;
}

test('Markdown-only provider set offers only Markdown and exports the active note', async () => {
  const harness = createHarness();
  try {
    let receivedPath = null;
    harness.formats.registerFormat('markdown', (filePath) => {
      receivedPath = filePath;
      return { success: true, filePath: '/out/demo.md' };
    });

    const opened = harness.openPicker();
    assert.equal(opened.handled, true);

    const picker = harness.getPicker();
    assert.ok(picker);
    assert.equal(picker.id, 'export-format-picker');
    assert.ok(picker.className.split(/\s+/).includes('export-format-picker'));
    assert.ok(picker.textContent.includes('Export Note as'));

    assert.deepEqual(harness.actionFormats(), ['markdown']);
    assert.deepEqual(harness.labels(), ['Markdown (.md)']);
    assert.equal(buttonFor(harness, 'pdf'), null);
    assert.equal(buttonFor(harness, 'plaintext'), null);
    assert.equal(buttonFor(harness, 'html'), null);

    buttonFor(harness, 'markdown').click();
    await flush();

    assert.equal(receivedPath, NOTE_PATH);
    assert.equal(harness.getPicker(), null);
  } finally {
    harness.cleanup();
  }
});

test('all four built-in providers render in canonical order and export the active note', async () => {
  const harness = createHarness();
  try {
    const calls = [];
    for (const format of ['html', 'plaintext', 'markdown', 'pdf']) {
      harness.formats.registerFormat(format, (filePath) => {
        calls.push([format, filePath]);
        return { success: true, filePath: `/out/demo.${format}` };
      });
    }

    const expectedOrder = ['pdf', 'markdown', 'plaintext', 'html'];
    const expectedLabels = expectedOrder.map((format) => KNOWN_LABELS[format]);

    for (const format of expectedOrder) {
      harness.openPicker();
      assert.deepEqual(harness.actionFormats(), expectedOrder);
      assert.deepEqual(harness.labels(), expectedLabels);

      buttonFor(harness, format).click();
      await flush();
      assert.equal(harness.getPicker(), null);
    }

    assert.deepEqual(calls, expectedOrder.map((format) => [format, NOTE_PATH]));
  } finally {
    harness.cleanup();
  }
});

test('empty provider set shows actionable guidance and still supports dismissal', () => {
  const harness = createHarness();
  try {
    harness.openPicker();
    assert.deepEqual(harness.actionFormats(), []);

    const picker = harness.getPicker();
    assert.ok(picker);
    assert.match(picker.textContent, /install|enable|settings|plugins/i);

    harness.document.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
    assert.equal(harness.getPicker(), null);

    harness.openPicker();
    harness.document.body.dispatchEvent(makeEvent('mousedown'));
    assert.equal(harness.getPicker(), null);

    harness.openPicker();
    harness.getPicker().dispatchEvent(makeEvent('mousedown'));
    assert.ok(harness.getPicker(), 'mousedown inside the picker does not dismiss it');
  } finally {
    harness.cleanup();
  }
});

test('Cancel closes a populated picker without invoking a provider', async () => {
  const harness = createHarness();
  try {
    let calls = 0;
    harness.formats.registerFormat('markdown', () => {
      calls += 1;
      return { success: true };
    });

    harness.openPicker();
    assert.deepEqual(harness.actionFormats(), ['markdown']);

    const cancel = harness.getPicker().querySelector('.export-format-picker-cancel');
    assert.ok(cancel, 'cancel button exists');
    assert.equal(cancel.textContent.trim(), 'Cancel');
    cancel.click();
    await flush();

    assert.equal(harness.getPicker(), null);
    assert.equal(calls, 0);
  } finally {
    harness.cleanup();
  }
});

test('unregistering a provider removes it from later pickers', async () => {
  const harness = createHarness();
  try {
    const calls = [];
    const disposeMarkdown = harness.formats.registerFormat('markdown', (filePath) => {
      calls.push(['markdown', filePath]);
      return { success: true };
    });
    harness.formats.registerFormat('pdf', (filePath) => {
      calls.push(['pdf', filePath]);
      return { success: true };
    });

    harness.openPicker();
    assert.deepEqual(harness.actionFormats(), ['pdf', 'markdown']);
    harness.document.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
    assert.equal(harness.getPicker(), null);

    disposeMarkdown();
    harness.openPicker();
    assert.deepEqual(harness.actionFormats(), ['pdf']);
    assert.deepEqual(harness.labels(), ['PDF']);

    buttonFor(harness, 'pdf').click();
    await flush();
    assert.deepEqual(calls, [['pdf', NOTE_PATH]]);
    assert.equal(harness.getPicker(), null);
  } finally {
    harness.cleanup();
  }
});

test('future and markup format ids are offered literally and can export', async () => {
  const harness = createHarness();
  try {
    const calls = [];
    const markupId = '<b>evil</b><img src=x onerror="window.__xss=1">';

    harness.formats.registerFormat('docx', (filePath) => {
      calls.push(['docx', filePath]);
      return { success: true, filePath: '/out/demo.docx' };
    });
    for (const format of ['html', 'plaintext', 'markdown', 'pdf']) {
      harness.formats.registerFormat(format, (filePath) => {
        calls.push([format, filePath]);
        return { success: true, filePath: `/out/demo.${format}` };
      });
    }
    harness.formats.registerFormat(markupId, (filePath) => {
      calls.push(['markup', filePath]);
      return { success: true, filePath: '/out/demo.bin' };
    });

    harness.openPicker();
    const formats = harness.actionFormats();
    assert.ok(formats.includes('docx'));
    assert.ok(formats.includes('pdf'));
    assert.ok(formats.includes(markupId));
    assert.deepEqual(
      formats.filter((format) => Object.hasOwn(KNOWN_LABELS, format)),
      ['pdf', 'markdown', 'plaintext', 'html'],
    );
    assert.equal(buttonFor(harness, 'docx').textContent, 'docx');
    assert.equal(buttonFor(harness, 'pdf').textContent, 'PDF');
    assert.equal(buttonFor(harness, 'markdown').textContent, 'Markdown (.md)');
    assert.equal(buttonFor(harness, 'plaintext').textContent, 'Plain Text (.txt)');
    assert.equal(buttonFor(harness, 'html').textContent, 'HTML (copy)');

    const markupButton = buttonFor(harness, markupId);
    assert.ok(markupButton);
    assert.ok(markupButton.textContent.includes(markupId));
    assert.equal(markupButton.querySelector('b'), null);
    assert.equal(markupButton.querySelector('img'), null);

    buttonFor(harness, 'docx').click();
    await flush();
    assert.deepEqual(calls, [['docx', NOTE_PATH]]);

    harness.openPicker();
    buttonFor(harness, markupId).click();
    await flush();
    assert.deepEqual(calls, [['docx', NOTE_PATH], ['markup', NOTE_PATH]]);
    assert.equal(harness.getPicker(), null);
  } finally {
    harness.cleanup();
  }
});

test('exportNoteAs preserves error, success, cancellation and thrown-error toasts', async () => {
  const harness = createHarness();
  try {
    harness.formats.registerFormat('error', () => ({ error: 'boom' }));
    harness.formats.registerFormat('success', () => ({ success: true, filePath: '/out/demo.pdf' }));
    harness.formats.registerFormat('cancelled', () => ({ cancelled: true }));
    harness.formats.registerFormat('falsy', () => null);
    harness.formats.registerFormat('throws', () => { throw new Error('kaboom'); });

    await harness.formats.exportNoteAs(NOTE_PATH, 'error');
    assert.deepEqual(harness.toasts, ['Export failed: boom']);

    harness.toasts.length = 0;
    await harness.formats.exportNoteAs(NOTE_PATH, 'success');
    assert.deepEqual(harness.toasts, ['Exported to /out/demo.pdf']);

    harness.toasts.length = 0;
    await harness.formats.exportNoteAs(NOTE_PATH, 'cancelled');
    await harness.formats.exportNoteAs(NOTE_PATH, 'falsy');
    assert.deepEqual(harness.toasts, []);

    harness.toasts.length = 0;
    await harness.formats.exportNoteAs(NOTE_PATH, 'throws');
    assert.deepEqual(harness.toasts, ['Export failed: kaboom']);
  } finally {
    harness.cleanup();
  }
});

test('Ctrl/Cmd+Shift+E keybinding opens the picker for the active note', () => {
  const harness = createHarness();
  try {
    harness.formats.registerFormat('markdown', () => ({ success: true }));

    const ignored = harness.triggerKeybinding({ metaKey: false, ctrlKey: false, shiftKey: true });
    assert.equal(ignored.handled, false);
    assert.equal(harness.getPicker(), null);

    const meta = harness.triggerKeybinding({ metaKey: true, ctrlKey: false });
    assert.equal(meta.handled, true);
    assert.equal(meta.event.defaultPrevented, true);
    assert.ok(harness.getPicker());
    assert.deepEqual(harness.actionFormats(), ['markdown']);

    harness.document.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
    assert.equal(harness.getPicker(), null);

    const control = harness.triggerKeybinding({ metaKey: false, ctrlKey: true });
    assert.equal(control.handled, true);
    assert.ok(harness.getPicker());
    assert.deepEqual(harness.actionFormats(), ['markdown']);
  } finally {
    harness.cleanup();
  }
});

test('no open note reports a toast and does not create a picker', () => {
  const harness = createHarness({ noteOpen: false });
  try {
    const result = harness.triggerKeybinding();
    assert.equal(result.handled, true);
    assert.equal(harness.getPicker(), null);
    assert.deepEqual(harness.toasts, ['No note open to export']);
  } finally {
    harness.cleanup();
  }
});

test('disposing the package removes an open picker', () => {
  const harness = createHarness();
  try {
    harness.formats.registerFormat('markdown', () => ({ success: true }));
    harness.openPicker();
    assert.ok(harness.getPicker());

    harness.disposeAll();
    assert.equal(harness.getPicker(), null);
  } finally {
    harness.cleanup();
  }
});
