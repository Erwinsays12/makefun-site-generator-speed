// Fast drop-in for makefun-site 1.0.0: returns exactly what makefun-site's build
// returns for every input, but faster. Single-file, dependency-free ES module.
//
// Where the speed comes from:
//  - Markdown inline rendering escapes whole plain runs at once instead of one
//    character at a time, and the block lexer renders in a single pass with no
//    token objects and no per-line regular expressions.
//  - Front matter is parsed by a small hand scanner instead of regexes.
//  - slugify results are cached per case (titles and tag names repeat a lot).
//  - Templates are compiled to JavaScript functions (via new Function) with
//    lexical scope resolution done at compile time, includes expanded inline,
//    and page-independent partials (nav, header, ...) rendered once per case
//    and cached. A faithful interpreter is kept as a fallback.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);
export const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site computes it (cache: per-case Map). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  cache.set(text, out);
  return out;
}

function slugifySlow(text) {
  if (!/[^\x00-\x7F]/.test(text)) {
    // ASCII: NFKD is the identity and there are no combining marks.
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Extra (non-ASCII) whitespace code points of JS \s, for an exact wordsOf. */
const WS_EXTRA = new Set([160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]);

/** The words of a body: its runs of characters other than whitespace (JS \s). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || (c > 127 && WS_EXTRA.has(c));
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEYS_SET = new Set(KEYS);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const KEY_RE = /^[a-z_]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeEnd = -1;
  const fmLines = [];
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const no = k + 2; // line number, counted from 1 at the opening ---
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c === -1) return { error: `line ${no} is not "key: value"` };
    const key = line.slice(0, c);
    if (!KEY_RE.test(key)) return { error: `line ${no} is not "key: value"` };
    let raw;
    if (c === line.length - 1) raw = '';
    else if (line.charCodeAt(c + 1) === 32) raw = line.slice(c + 2);
    else return { error: `line ${no} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!KEYS_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** Whether code point `c` is JS whitespace (for the list continuation rule). */
function isWSCode(c) {
  return c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || (c > 127 && WS_EXTRA.has(c));
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Fence open: the language, or null. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(n));
  if (text === '') return null;
  return { depth: n, text };
}

function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** Bullet list item text, or null. */
function bulletItem(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return trimLine(line.slice(2));
  return null;
}

/** Ordered list item: { num, text }, or null. */
function orderedItem(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: trimLine(line.slice(i + 2)) };
}

/** A list continuation line: two or more spaces then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  return i < line.length && !isWSCode(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline special character: backslash, backtick, star or open bracket. */
const INLINE_SPECIAL = /[\\`*[]/g;

/** `s` rendered inline, appended to `out` (an array of string chunks). */
function inlineInto(s, env, out) {
  const n = s.length;
  let i = 0;
  let plainStart = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > plainStart) out.push(escapeHtml(s.slice(plainStart, j)));
    plainStart = j;
    if (m === null) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash: escapes one of the escapable characters
      if (j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
        out.push(s[j + 1]);
        i = j + 2;
        plainStart = i;
      } else i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plainStart = i;
      } else i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
          plainStart = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</em>');
        i = k + 1;
        plainStart = i;
      } else i = j + 1;
      continue;
    }
    // '[': a link, or itself.
    const k = findUnescaped(s, ']', j + 1);
    const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = t === -1 ? '' : s.slice(k + 2, t);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s.slice(j + 1, k), env, out);
      out.push('</a>');
      i = t + 1;
      plainStart = i;
      continue;
    }
    i = j + 1;
  }
  if (n > plainStart) out.push(escapeHtml(s.slice(plainStart, n)));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML, table of contents and excerpt, exactly as
 * makefun-site's lexer + parser produce them.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(body.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletItem(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.num : 1;
      const items = [];
      while (i < n) {
        let m;
        if (isOrdered) {
          m = orderedItem(lines[i]);
          if (m !== null) {
            items.push([m.text]);
            i++;
            continue;
          }
        } else {
          m = bulletItem(lines[i]);
          if (m !== null) {
            items.push([m]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (const item of items) listHtml += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
      listHtml += `</${tag}>`;
      blocks.push(`${listHtml}\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (!hasExcerpt) {
      excerpt = html;
      hasExcerpt = true;
    }
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Own-property read, or undefined: the reference's lookup step for one name. */
function getProp(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

// --- faithful interpreter (fallback, and a cross-check for the compiler) ---

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// --- template compiler ---

/** The most expanded nodes one compiled template may hold before it falls back to the interpreter. */
const EXPAND_BUDGET = 50000;

/** The root variable names a template may read while still rendering the same on every page of a case. */
const CASE_CONST_VARS = new Set(['site', 'tags', 'recent']);

/**
 * The free root names of `nodes` (first path segments not bound by an enclosing
 * for), expanding includes up to `depth`. `bound` holds the caller's loop-bound
 * names (plus 'loop' when inside a for).
 */
function freeNames(nodes, templates, depth, bound, seen) {
  const free = new Set();
  const walk = (ns, d, bnd) => {
    for (const n of ns) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!bnd.has(n.path[0])) free.add(n.path[0]);
      }
      if (n.kind === 'for') {
        if (!bnd.has(n.path[0])) free.add(n.path[0]);
        const b2 = new Set(bnd);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, d, b2);
        continue;
      }
      if (n.kind === 'if') {
        walk(n.then, d, bnd);
        if (n.else !== null) walk(n.else, d, bnd);
        continue;
      }
      if (n.kind === 'include') {
        if (d >= INCLUDE_DEPTH) continue;
        const t = templates.get(n.name);
        if (t === undefined) continue;
        const key = `${n.name}@${d}@${[...bnd].sort().join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        walk(t, d + 1, bnd);
      }
    }
  };
  walk(nodes, depth, bound);
  return free;
}

/** Whether template `name` renders the same on every page of a case (only site/tags/recent read). */
function isCacheable(name, templates, memo) {
  if (memo.has(name)) return memo.get(name);
  const nodes = templates.get(name);
  if (nodes === undefined) {
    memo.set(name, false);
    return false;
  }
  const free = freeNames(nodes, templates, 0, new Set(), new Set());
  let ok = true;
  for (const f of free) if (!CASE_CONST_VARS.has(f)) { ok = false; break; }
  memo.set(name, ok);
  return ok;
}

/** Every {% include %} name a node tree names, anywhere in it. */
function includeNames(nodes, into = new Set()) {
  for (const n of nodes) {
    if (n.kind === 'include') into.add(n.name);
    else if (n.kind === 'for') includeNames(n.body, into);
    else if (n.kind === 'if') {
      includeNames(n.then, into);
      if (n.else !== null) includeNames(n.else, into);
    }
  }
  return into;
}

/**
 * Each template's include height: the longest chain of includes starting from
 * it (0 when it includes nothing), or Infinity when a cycle is reachable from
 * it. A cached render expands a template as if from depth 0, so it is only
 * the same as the caller's render at depth d when the height fits in 8 - d.
 */
function includeHeights(templates) {
  const memo = new Map();
  const height = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return Infinity;
    const nodes = templates.get(name);
    if (nodes === undefined) return 0;
    visiting.add(name);
    let h = 0;
    let cyclic = false;
    for (const inc of includeNames(nodes)) {
      const sub = height(inc, visiting);
      if (sub === Infinity) cyclic = true;
      else if (sub + 1 > h) h = sub + 1;
    }
    visiting.delete(name);
    const out = cyclic ? Infinity : h;
    memo.set(name, out);
    return out;
  };
  for (const name of templates.keys()) height(name, new Set());
  return memo;
}

/**
 * Expand `nodes` with includes spliced in (up to INCLUDE_DEPTH deep); an include
 * of a cacheable template outside any for becomes a {kind:'cached'} node.
 * Returns the expanded list, or null when the budget is exceeded.
 */
function expandNodes(nodes, templates, cacheMemo, heights, depth, inLoop, budget) {
  const out = [];
  const pushAll = (list) => {
    for (const n of list) {
      out.push(n);
      budget.count++;
      if (budget.count > EXPAND_BUDGET) return false;
    }
    return true;
  };
  for (const n of nodes) {
    if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t === undefined || depth >= INCLUDE_DEPTH) continue;
      if (!inLoop && (heights.get(n.name) ?? 0) <= INCLUDE_DEPTH - depth && isCacheable(n.name, templates, cacheMemo)) {
        out.push({ kind: 'cached', name: n.name });
        budget.count++;
        if (budget.count > EXPAND_BUDGET) return null;
        continue;
      }
      const sub = expandNodes(t, templates, cacheMemo, heights, depth + 1, inLoop, budget);
      if (sub === null) return null;
      if (!pushAll(sub)) return null;
    } else if (n.kind === 'for') {
      const body = expandNodes(n.body, templates, cacheMemo, heights, depth, true, budget);
      if (body === null) return null;
      out.push({ kind: 'for', name: n.name, path: n.path, body });
      budget.count++;
      if (budget.count > EXPAND_BUDGET) return null;
    } else if (n.kind === 'if') {
      const then = expandNodes(n.then, templates, cacheMemo, heights, depth, inLoop, budget);
      if (then === null) return null;
      const els = n.else === null ? null : expandNodes(n.else, templates, cacheMemo, heights, depth, inLoop, budget);
      if (els === null && n.else !== null) return null;
      out.push({ kind: 'if', not: n.not, path: n.path, then, else: els });
      budget.count++;
      if (budget.count > EXPAND_BUDGET) return null;
    } else {
      out.push(n);
      budget.count++;
      if (budget.count > EXPAND_BUDGET) return null;
    }
  }
  return out;
}

/** Compile expanded `nodes` to a function body; `env` is the lexical loop stack. */
function genNodes(nodes, env, lines, counter) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      lines.push(`__o.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      lines.push(`__o.push(esc(textOf(${genPath(n.path, env)})));`);
    } else if (n.kind === 'raw') {
      lines.push(`__o.push(textOf(${genPath(n.path, env)}));`);
    } else if (n.kind === 'cached') {
      lines.push(`__o.push(__cached(${JSON.stringify(n.name)},__V));`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!truthy(${genPath(n.path, env)})` : `truthy(${genPath(n.path, env)})`;
      lines.push(`if(${cond}){`);
      genNodes(n.then, env, lines, counter);
      if (n.else !== null) {
        lines.push('}else{');
        genNodes(n.else, env, lines, counter);
      }
      lines.push('}');
    } else if (n.kind === 'for') {
      const k = counter.n++;
      const arr = `__a${k}`;
      const idx = `__i${k}`;
      const el = `__x${k}`;
      const lp = `__l${k}`;
      lines.push(`{const ${arr}=${genPath(n.path, env)};if(Array.isArray(${arr})){const ${lp}={index:0,first:false,last:false,length:${arr}.length};for(let ${idx}=0;${idx}<${arr}.length;${idx}++){const ${el}=${arr}[${idx}];${lp}.index=${idx}+1;${lp}.first=${idx}===0;${lp}.last=${idx}===${arr}.length-1;`);
      env.push({ name: n.name, el, lp });
      genNodes(n.body, env, lines, counter);
      env.pop();
      lines.push('}}}');
    }
  }
}

/** A path as a JavaScript expression, resolving its first name lexically. */
function genPath(path, env) {
  const first = path[0];
  let expr;
  if (first === 'loop') {
    if (env.length === 0) expr = `(hasOwn(__V,"loop")?__V["loop"]:undefined)`;
    else expr = env[env.length - 1].lp;
  } else {
    let found = null;
    for (let k = env.length - 1; k >= 0; k--) {
      if (env[k].name === first) {
        found = env[k].el;
        break;
      }
    }
    expr = found !== null ? found : `(hasOwn(__V,${JSON.stringify(first)})?__V[${JSON.stringify(first)}]:undefined)`;
  }
  for (let k = 1; k < path.length; k++) expr = `getProp(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

/**
 * Build the per-case template renderer: compiled functions where possible,
 * the interpreter where a template does not compile. Returns
 * { render(name, vars) } with null for a missing template.
 */
function makeRenderer(templates) {
  const cacheMemo = new Map();
  const heights = includeHeights(templates);
  const compiled = new Map(); // name -> function(V) | null (interpreted) | undefined (missing)
  const interpreted = new Map(); // name -> nodes, for templates that stay interpreted
  let factory = null;
  try {
    const parts = [];
    const entries = [];
    let idx = 0;
    for (const [name, nodes] of templates) {
      const budget = { count: 0 };
      const expanded = expandNodes(nodes, templates, cacheMemo, heights, 0, false, budget);
      if (expanded === null) {
        interpreted.set(name, nodes);
        compiled.set(name, null);
        continue;
      }
      const lines = ['let __o=[];'];
      genNodes(expanded, [], lines, { n: 0 });
      lines.push('return __o.join("");');
      const fnName = `__f${idx++}`;
      parts.push(`function ${fnName}(__V){${lines.join('')}}`);
      entries.push(`[${JSON.stringify(name)},${fnName}]`);
      compiled.set(name, fnName);
    }
    const src = [
      'const esc=H.esc,textOf=H.textOf,truthy=H.truthy,getProp=H.getProp,hasOwn=H.hasOwn;',
      'const __cache=new Map();',
      ...parts,
      `const __F=new Map([${entries.join(',')}]);`,
      'function __cached(name,__V){let v=__cache.get(name);if(v===undefined){const f=__F.get(name);v=f(__V);__cache.set(name,v);}return v;}',
      'return {render(name,__V){const f=__F.get(name);return f===undefined?null:f(__V);}};',
    ].join('\n');
    factory = new Function('H', src)({ esc: escapeHtml, textOf, truthy, getProp, hasOwn: Object.hasOwn });
  } catch {
    factory = null;
  }
  const ctx = { templates, escape: escapeHtml };
  return {
    render(name, vars) {
      if (factory !== null) {
        const mark = compiled.get(name);
        if (mark === undefined) return null;
        if (mark === null) {
          const nodes = interpreted.get(name);
          return renderNodes(nodes, { vars, parent: null }, ctx, 0);
        }
        return factory.render(name, vars);
      }
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      return renderNodes(nodes, { vars, parent: null }, ctx, 0);
    },
  };
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const renderer = makeRenderer(templates);
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  const cards = new Map();
  const cardOf = (s) => {
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    return card;
  };
  for (const p of posts) cards.set(p, cardOf(p));

  const pageOf = (s) => {
    const card = cardOf(s);
    card.slug = s.slug;
    card.content = s.html;
    card.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    card.newer = linkOf(s.newer ?? null);
    card.older = linkOf(s.older ?? null);
    card.is_post = s.post;
    return card;
  };

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => renderer.render(name, { site, tags: allTags, recent, ...vars });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
