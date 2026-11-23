// A faster drop-in for makefun-site 1.0.0, make.fun's own static site generator: run(input) returns exactly
// makefun-site's answer for every input — the output tree of the case's site as a JSON object of path -> text,
// byte for byte — in a fraction of its CPU time.
//
// Where makefun-site's build walks a pipeline of plugins over shared state, lexes Markdown with a regex per line
// and renders templates and inline markup by slicing substrings for every nested span, this module runs the same
// rules as a few tight passes written for the shapes the build actually meets:
//   - front matter is read by scanning the source's first lines in place, never by splitting the whole text;
//   - a body's lines are classified by their first characters, not by a battery of anchored regexes;
//   - inline markup is rendered by one scanner over the whole string with an explicit stack for strong, emphasis
//     and link text, so nested spans cost no substring copies and no repeated closer searches;
//   - slugs are memoised (a site reuses the same titles, tags and headings many times over);
//   - template rendering walks the parsed tree once, appending to one parts array per page.
// Every rule — the front-matter grammar and its refusal reasons, the slug rule, the Markdown subset, the template
// dialect, the link resolution, the report's lines and their order — is makefun-site 1.0.0's own, reproduced
// exactly; nothing is cached from one case to the next.

/** Code-unit order (never the locale's). */
const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
};

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE_HTML = /[&<>"']/;

/** `text` with & < > " and ' escaped, makefun-site's table and nothing else. */
function escapeHtml(text) {
  if (!ESCAPABLE_HTML.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const MARKS = /\p{M}/gu;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9
 * one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let k = 0; k < plain.length; k++) {
    const c = plain[k];
    let keep = null;
    if (c >= 'A' && c <= 'Z') keep = c.toLowerCase();
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) keep = c;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 16384) slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const i1 = date.indexOf('-');
  const i2 = date.indexOf('-', i1 + 1);
  return `${Number(date.slice(i2 + 1))} ${MONTHS[Number(date.slice(i1 + 1, i2)) - 1]} ${date.slice(0, i1)}`;
}

/** The words of a body: its runs of characters other than whitespace (the set JavaScript's \s names). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    // The whitespace a body actually holds is ASCII; the rest of \s lives at 160 and above, checked there.
    let ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    if (!ws && c >= 160) {
      ws =
        c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
        c === 8287 || c === 12288 || c === 65279;
    }
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Whether `line` is blank: spaces and tabs only. */
function isBlankST(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const end = raw.length - 1;
    let out = '';
    let last = 1;
    let i = 1;
    while (i < end) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(last, i) + n;
        i += 2;
        last = i;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else i++;
    }
    return { value: out + raw.slice(last, end) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let k = 0; k < 10; k++) {
          if (k === 4 || k === 7) continue;
          const c = raw.charCodeAt(k);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
          const digit = c - 48;
          if (k < 4) y = y * 10 + digit;
          else if (k < 7) mo = mo * 10 + digit;
          else d = d * 10 + digit;
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let k = 0; k < parts.length; k++) {
        const t = parts[k].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters
      let ok = raw.length > 0 && raw.length <= 64;
      let seg = 0;
      for (let k = 0; ok && k < raw.length; k++) {
        const c = raw[k];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) seg++;
        else if (c === '-' && seg > 0) seg = 0;
        else ok = false;
      }
      if (ok && seg === 0) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Only the lines up to the closing "---" are ever sliced out; the body is one slice of the rest.
 */
function parseFrontMatter(text) {
  const firstEnd = text.indexOf('\n');
  if ((firstEnd === -1 ? text : text.slice(0, firstEnd)) !== '---') return { error: 'no front matter' };
  if (firstEnd === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = firstEnd + 1;
  let closePos = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text.startsWith('---', pos)) {
      closePos = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(text.slice(pos, lineEnd));
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li];
    if (isBlankST(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw = null;
    if (k > 0 && line[k] === ':') {
      if (k === line.length - 1) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    }
    if (raw === null) return { error: `line ${li + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closePos) };
}

// ---------------------------------------------------------------- markdown

/** A fence's opening line: three backticks, an optional language, then spaces or tabs only; its language or null. */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32 || c === 9) k++;
    else return null;
  }
  return lang;
}

/** A fence's closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= line.length) return null;
  const after = line.charCodeAt(k);
  if (after !== 32 && after !== 9) return null;
  let s = k;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: k, text: line.slice(s, e) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item line's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item line's number and text after "N. ", or null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c >= 48 && c <= 57) k++;
    else break;
  }
  if (k === 0 || k > 9) return null;
  if (line[k] !== '.' || line[k + 1] !== ' ') return null;
  return { num: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return c !== 32 && c !== 9 && c !== 10 && c !== 11 && c !== 12 && c !== 13;
}

/** A line as blocks read it: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. Each of those opens
 * on its own first character, so one look at it settles which checks can apply at all.
 */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpenOf(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return isBlankST(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_WS = /\s/;

/** The characters that can open an inline span (backslash, backtick, star, bracket), by char code. */
const INLINE_SPECIAL = new Uint8Array(128);
INLINE_SPECIAL[92] = 1;
INLINE_SPECIAL[96] = 1;
INLINE_SPECIAL[42] = 1;
INLINE_SPECIAL[91] = 1;

/**
 * `s` rendered inline; `link(target)` is a link's href. One scan over the whole string: strong, emphasis and
 * link text are frames on an explicit stack (kind 1, 2, 3), each scanning its own span of the same string, so a
 * nested span costs no substring copy; positions at a span's end read as the end of the string, exactly as a
 * recursive render of the span alone would read them.
 */
function renderInline(s, link) {
  const stack = [{ i: 0, end: s.length, kind: 0, parts: [] }];
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    const end = f.end;
    const parts = f.parts;
    let i = f.i;
    let pushed = false;
    while (i < end) {
      const c = s[i];
      if (c !== '\\' && c !== '`' && c !== '*' && c !== '[') {
        // A plain run: scan to the next character that can open anything, one table read per character.
        let j = i + 1;
        while (j < end) {
          const cc = s.charCodeAt(j);
          if (cc < 128 && INLINE_SPECIAL[cc]) break;
          j++;
        }
        parts.push(escapeHtml(s.slice(i, j)));
        i = j;
        continue;
      }
      if (c === '\\' && i + 1 < end && ESCAPABLE.has(s[i + 1])) {
        parts.push(escapeHtml(s[i + 1]));
        i += 2;
        continue;
      }
      if (c === '`') {
        const j = s.indexOf('`', i + 1);
        if (j !== -1 && j < end && j > i + 1) {
          parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
          i = j + 1;
        } else {
          parts.push('`');
          i++;
        }
        continue;
      }
      if (c === '*') {
        if (i + 1 < end && s[i + 1] === '*') {
          const j = findUnescaped(s, '**', i + 2, end);
          if (j > i + 2) {
            f.i = j + 2;
            stack.push({ i: i + 2, end: j, kind: 1, parts: [] });
            pushed = true;
          } else {
            parts.push('**');
            i += 2;
          }
        } else {
          const j = findSingleStar(s, i + 1, end);
          if (j > i + 1) {
            f.i = j + 1;
            stack.push({ i: i + 1, end: j, kind: 2, parts: [] });
            pushed = true;
          } else {
            parts.push('*');
            i++;
          }
        }
        if (pushed) break;
        continue;
      }
      if (c === '[') {
        const k = findUnescaped(s, ']', i + 1, end);
        const m = k !== -1 && k + 1 < end && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
        const target = m === -1 || m >= end ? '' : s.slice(k + 2, m);
        if (target !== '' && !HAS_WS.test(target)) {
          parts.push('<a href="', escapeHtml(link(target)), '">');
          f.i = m + 1;
          stack.push({ i: i + 1, end: k, kind: 3, parts: [] });
          pushed = true;
          break;
        }
        parts.push('[');
        i++;
        continue;
      }
      // A backslash that escapes nothing is itself, and the run after it is plain.
      parts.push('\\');
      i++;
    }
    if (pushed) continue;
    f.i = i;
    stack.pop();
    const inner = parts.join('');
    if (stack.length === 0) return inner;
    const parent = stack[stack.length - 1];
    if (f.kind === 1) parent.parts.push('<strong>', inner, '</strong>');
    else if (f.kind === 2) parent.parts.push('<em>', inner, '</em>');
    else parent.parts.push(inner, '</a>');
  }
  return '';
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are classified and rendered in one pass over the body's lines.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  // One list, from its first item at lines[i]: its items rendered, and the line count it took.
  const consumeList = (ordered, start) => {
    const items = [];
    while (i < n) {
      const m = ordered ? orderedOf(lines[i]) : bulletOf(lines[i]);
      if (m !== null) {
        items.push([trimLine(ordered ? m.text : m)]);
        i++;
      } else if (isContinued(lines[i])) {
        items[items.length - 1].push(trimLine(lines[i]));
        i++;
      } else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    let out = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
    out += '\n';
    for (const item of items) out += `<li>${renderInline(item.join('\n'), link)}</li>\n`;
    out += `</${tag}>`;
    blocks.push(out);
  };
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    // Every block kind opens on its own first character; one look settles which checks can apply at all.
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpenOf(line);
      if (lang !== null) {
        i++;
        const parts = [];
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = renderInline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const q = lines[i];
        const t = trimLine(q.startsWith('> ') ? q.slice(2) : q.slice(1));
        if (t !== '') body.push(t);
        i++;
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${renderInline(body.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (bulletOf(line) !== null) {
        consumeList(false, 1);
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedOf(line);
      if (first !== null) {
        consumeList(true, first.num);
        continue;
      }
    }
    if (isBlankST(line)) {
      i++;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = renderInline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template error, marked so the build can tell it from a bug: its message is the report line. */
function templateError(name, why) {
  const err = new Error(`template "${name}": ${why}`);
  err.isTemplateError = true;
  return err;
}

/** The path `text` names, split at its dots, or a template error. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw templateError(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a..b) is spaces and tabs only. */
function allST(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a {% %} tag alone on its line takes the whole line with it.
 * Text is sliced lazily, one slice per token boundary, where the reference tokenizer appends it hop by hop.
 * Node shapes: text [0, text], var/raw [1, path, raw], for [2, name, path, body], if [3, not, path, then, else],
 * include [4, name].
 */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let textStart = 0;
  let i = 0;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) break;
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      i = open + 1;
      continue;
    }
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw templateError(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (open > textStart) tokens.push({ t: 'text', text: src.slice(textStart, open) });
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      textStart = i;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = allST(src, lineStart, open) && allST(src, end, lineEnd);
    const segEnd = standalone ? lineStart : open;
    if (segEnd > textStart) tokens.push({ t: 'text', text: src.slice(textStart, segEnd) });
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
    textStart = i;
  }
  if (textStart < n) tokens.push({ t: 'text', text: src.slice(textStart) });
  return tokens;
}

/** `src` parsed into its tree of nodes (a template error when it does not parse). */
function parseTemplate(name, src) {
  const rootBody = [];
  const stack = [{ kind: 'root', body: rootBody, node: null }];
  let body = rootBody;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var') body.push([1, tok.path, 0]);
    else if (tok.t === 'raw') body.push([1, tok.path, 1]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [2, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', body: node[3], node });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', body: node[3], node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw templateError(name, 'an else outside an if');
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== tag.slice(3)) throw templateError(name, `an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.node[3] : parent.node[4] ?? parent.node[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([4, m[1]]);
      else throw templateError(name, `{% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw templateError(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return rootBody;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  if (path.length === 1) return v;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appending to `out`; `templates` maps names to parsed nodes. */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    const kind = node[0];
    if (kind === 0) out.push(node[1]);
    else if (kind === 1) {
      const v = lookup(scope, node[1]);
      if (node[2] === 1) out.push(textOf(v));
      else if (typeof v === 'string') {
        // A var node's value is so often the same string page after page (the site's title, a recent post's
        // title in every page's nav) that the node keeps the last string it escaped and its escaping.
        if (node[3] === v) out.push(node[4]);
        else {
          const escaped = escapeHtml(v);
          node[3] = v;
          node[4] = escaped;
          out.push(escaped);
        }
      } else out.push(escapeHtml(textOf(v)));
    } else if (kind === 3) {
      const branch = truthy(lookup(scope, node[2])) !== node[1] ? node[3] : node[4];
      if (branch !== null) renderNodes(branch, scope, templates, depth, out);
    } else if (kind === 2) {
      const xs = lookup(scope, node[2]);
      if (Array.isArray(xs)) {
        const bodyNodes = node[3];
        const name = node[1];
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(bodyNodes, { vars, parent: scope }, templates, depth, out);
        }
      }
    } else {
      const t = templates.get(node[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- the build

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let k = 1; k < target.length; k++) {
    const c = target.charCodeAt(k);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A source's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it, over its (once-computed) card. */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's build of the same input. */
export function run(input) {
  // Every template is parsed, in code-unit order of its name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err === null || err.isTemplateError !== true) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  let bEnd = base.length;
  while (bEnd > 0 && base.charCodeAt(bEnd - 1) === 47) bEnd--;
  if (bEnd !== base.length) base = base.slice(0, bEnd);

  // The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft; the checks run in this order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
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

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  // A target's fate depends only on its source's directory and the target itself, and a site's sources draw
  // their targets from a small shared pool: resolve each (directory, target) pair once per build.
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const key = `${dir}\n${target}`;
      let href = linkCache.get(key);
      if (href === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        href =
          path !== null && bySource.has(path)
            ? `${bySource.get(path).url}${frag}`
            : path !== null && staticPaths.has(path)
              ? `${base}/${path}${frag}`
              : null;
        linkCache.set(key, href);
      }
      if (href === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return href;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: grouped by slug, each named as first met walking the posts in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()];
  tagList.sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // Every page through its layout, the index pages and the tag pages through theirs, then the static files.
  // A source's card is a pure function of the source, so each is computed once and shared by its page, the
  // index and tag lists and `recent`.
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...extra }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards.get(s)) });
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
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported and each broken link, sorted, then the counts.
  const lines = report.concat([...broken]);
  lines.sort(byCU);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
