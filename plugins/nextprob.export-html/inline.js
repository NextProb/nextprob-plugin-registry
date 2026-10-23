'use strict';
const fs = require('fs');
const path = require('path');
const { addSharedNoteStyle } = require('./share-note-style');
const _INLINE_MIME_MAP = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function inlineNoteAsHtml(noteFolderPath, noteCss) {
  const indexPath = path.join(noteFolderPath, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  let noteTitle = path.basename(noteFolderPath);
  try {
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match) noteTitle = match[1].trim();
  } catch {}

  function resolveAsset(ref) {
    const decoded = decodeURIComponent(ref.split('?')[0].split('#')[0]);
    const abs = path.resolve(noteFolderPath, decoded);
    if (!abs.startsWith(noteFolderPath + path.sep) && abs !== noteFolderPath) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  }

  function toDataUri(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.css') return null;
    const mime = _INLINE_MIME_MAP[ext];
    if (!mime) return null;
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  function inlineCssFile(cssPath, visited) {
    if (!visited) visited = new Set();
    if (visited.has(cssPath)) return '';
    visited.add(cssPath);
    let css = fs.readFileSync(cssPath, 'utf8');
    const cssDir = path.dirname(cssPath);
    css = css.replace(/@import\s+(?:url\()?['"]?([^'");\s]+)['"]?\)?[^;]*;/g, (_m, ref) => {
      const abs = path.resolve(cssDir, decodeURIComponent(ref.split('?')[0].split('#')[0]));
      if (!abs.startsWith(noteFolderPath) || !fs.existsSync(abs)) return '';
      return inlineCssFile(abs, visited);
    });
    css = css.replace(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g, (_m, ref) => {
      const abs = path.resolve(cssDir, decodeURIComponent(ref.split('?')[0].split('#')[0]));
      if (!abs.startsWith(noteFolderPath) || !fs.existsSync(abs)) return _m;
      const ext = path.extname(abs).toLowerCase();
      const mime = _INLINE_MIME_MAP[ext];
      if (!mime) return _m;
      const b64 = fs.readFileSync(abs).toString('base64');
      return `url(data:${mime};base64,${b64})`;
    });
    return css;
  }

  function inlineCssUrls(css) {
    return css.replace(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g, (_u, ref) => {
      if (/^https?:\/\//.test(ref)) return _u;
      const abs = resolveAsset(ref);
      if (!abs) return _u;
      const ext = path.extname(abs).toLowerCase();
      const mime = _INLINE_MIME_MAP[ext];
      if (!mime) return _u;
      const b64 = fs.readFileSync(abs).toString('base64');
      return `url(data:${mime};base64,${b64})`;
    });
  }

  // Inline <link rel="stylesheet"> → <style>
  html = html.replace(/<link\s[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return tag;
    const ref = hrefMatch[1];
    if (/^https?:\/\//.test(ref)) return tag;
    const abs = resolveAsset(ref);
    if (!abs) return tag;
    return `<style>/* inlined: ${ref} */\n${inlineCssFile(abs)}\n</style>`;
  });

  // Inline <script src="..."> → <script>
  html = html.replace(/<script\s[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_tag, ref) => {
    if (/^https?:\/\//.test(ref)) return _tag;
    const abs = resolveAsset(ref);
    if (!abs) return _tag;
    return `<script>/* inlined: ${ref} */\n${fs.readFileSync(abs, 'utf8')}\n</script>`;
  });

  // Inline <img>, <source>, <audio>, <video> src
  html = html.replace(/(<(?:img|source|audio|video)\s[^>]*)(src=["'])([^"']+)(["'][^>]*>)/gi, (_m, before, attr, ref, after) => {
    if (/^(https?:\/\/|data:)/.test(ref)) return _m;
    const abs = resolveAsset(ref);
    if (!abs) return _m;
    const dataUri = toDataUri(abs);
    if (!dataUri) return _m;
    return `${before}${attr}${dataUri}${after}`;
  });

  // Inline url() in <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) => {
    return `${open}${inlineCssUrls(css)}${close}`;
  });

  // Inline url() in style="..." attributes
  html = html.replace(/style=["']([^"']*url\([^)]+\)[^"']*)["']/gi, (_m, styleVal) => {
    return `style="${inlineCssUrls(styleVal)}"`;
  });

  // Ensure UTF-8 charset is declared. Prevents mojibake when the gist is
  // loaded via a blob: iframe or viewed directly on gist.github.com.
  if (!/<meta[^>]+charset\s*=/i.test(html)) {
    const charsetMeta = '<meta charset="utf-8">';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n${charsetMeta}`);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, `<html$1>\n<head>${charsetMeta}</head>`);
    } else {
      html = `${charsetMeta}\n${html}`;
    }
  }

  html = addSharedNoteStyle(html, noteCss);

  const usesBackendAPIs = /\b(noteDB|noteFiles|noteSQL|noteScripts|noteLog)\b/.test(html);

  return { html, noteTitle, usesBackendAPIs };
}

module.exports = { inlineNoteAsHtml };
