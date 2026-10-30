// Cases of hono's router regexps for the engine diff: regexps built from random route tables the way
// hono's RegExpRouter builds them (a trie of the routes' tokens: a literal character per static token,
// `([^/]+)` or a custom pattern for a parameter, `(?:|/.*)` for a tail wildcard, `.*` for a final `*`;
// each node's children ordered literals, custom patterns, labels, wildcards; `$()` where a route ends;
// `.*$` removed), and paths drawn from the routes with random parameter values and mutations. The
// engine diff compares every match's captures with V8's. Hand-written regexps of the older shape
// (a static child beside a parameter at one node: backtracking between them) are added.

const LABEL = "[^/]+", ONLY_WILD = ".*", TAIL_WILD = "(?:|/.*)";
const META = new Set(".\\+*[^]$()");
class PathError extends Error {}

function compareKey(a, b) {
  if (a.length === 1) return b.length === 1 ? (a < b ? -1 : 1) : -1;
  if (b.length === 1) return 1;
  if (a === ONLY_WILD || a === TAIL_WILD) return b === TAIL_WILD ? -1 : 1;
  if (b === ONLY_WILD || b === TAIL_WILD) return -1;
  if (a === LABEL) return 1;
  if (b === LABEL) return -1;
  return a.length === b.length ? (a < b ? -1 : 1) : b.length - a.length;
}
class Node {
  index = undefined; varIndex = undefined; children = Object.create(null);
  insert(tokens, index, ctx, isStatic) {
    let node = this;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const pattern = token.length === 1
        ? (token === "*" ? (i === tokens.length - 1 ? ["", "", ONLY_WILD] : ["", "", LABEL]) : null)
        : token === "/*" ? ["", "", TAIL_WILD] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let next;
      if (pattern) {
        const name = pattern[1];
        let re = pattern[2] || LABEL;
        if (name && pattern[2]) {
          if (re === ".*") throw new PathError();
          re = re.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(re)) throw new PathError();
          if (re.length === 1 && META.has(re)) throw new PathError();
        }
        next = node.children[re];
        if (!next) {
          if (re !== ONLY_WILD && re !== TAIL_WILD)
            for (const k in node.children)
              if ((re.length > 1 || k.length > 1) && k !== ONLY_WILD && k !== TAIL_WILD) throw new PathError();
          next = node.children[re] = new Node();
        }
        if (name !== "") next.varIndex ??= ctx.varIndex++;
      } else {
        next = node.children[token];
        if (!next) {
          for (const k in node.children) if (k.length > 1 && k !== ONLY_WILD && k !== TAIL_WILD) throw new PathError();
          next = node.children[token] = new Node();
        }
      }
      node = next;
    }
    if (node.index !== undefined) throw new PathError();
    node.index = isStatic ? -1 : index;
  }
  str() {
    const parts = Object.keys(this.children).sort(compareKey).map((k) => {
      const c = this.children[k], cs = c.str();
      return cs === "" ? "" : (typeof c.varIndex === "number" ? `(${k})@${c.varIndex}` : META.has(k) ? `\\${k}` : k) + cs;
    }).filter(Boolean);
    if (typeof this.index === "number" && this.index !== -1) parts.unshift(`#${this.index}`);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return "(?:" + parts.join("|") + ")";
  }
}
function tokenize(path) {
  const groups = [];
  let marked = path;
  for (let i = 0; ;) {
    let replaced = false;
    marked = marked.replace(/\{[^}]+\}/g, (m) => { const mark = `@\\${i}`; groups[i] = [mark, m]; i++; replaced = true; return mark; });
    if (!replaced) break;
  }
  const tokens = marked.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) { tokens[j] = tokens[j].replace(mark, groups[i][1]); break; }
  }
  return tokens;
}
/** The regexp source hono builds for the routes, or undefined (a path error: SmartRouter's case). */
export function honoRegExpSource(paths) {
  const root = new Node(), ctx = { varIndex: 0 };
  let index = 0;
  try {
    for (const p of paths) {
      const isStatic = !/\*|\/:/.test(p);
      if (isStatic) root.insert(p.split(""), 0, ctx, true);
      else root.insert(tokenize(p), index++, ctx, false);
    }
  } catch (e) { if (e instanceof PathError) return undefined; throw e; }
  let re = root.str();
  if (re === "") return undefined;
  re = re.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, h, pi) => h !== undefined ? "$()" : "");
  return "^" + re;
}

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** The route cases: [pattern, flags, input, start]. */
export function routeCases(seed = 7, nTables = 400) {
  const R = rng(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const statics = ["a", "ab", "abc", "b", "user", "users", "u", "posts", "post", "p", "x.y", "a-b", "été", "help"];
  const params = [":id", ":name", ":n{[0-9]+}", ":w{[a-z]+}", ":v{[a-z0-9.]+}"];
  const values = ["1", "42", "abc", "a.b", "x-y", "%20", "é", "Z", "a1", "123456789012345", "user", "posts", ""];
  const cases = [];
  for (let t = 0; t < nTables; t++) {
    const routes = [];
    const n = 1 + Math.floor(R() * 10);
    for (let r = 0; r < n; r++) {
      const segs = 1 + Math.floor(R() * 4);
      let p = "";
      for (let s = 0; s < segs; s++) p += "/" + (R() < 0.4 ? pick(params) : pick(statics));
      const w = R();
      if (w < 0.12) p += "/*"; else if (w < 0.17) p += "*";
      if (R() < 0.05) p = "/" + pick(statics) + "/" + pick(statics);   // a static route
      routes.push(p);
    }
    const src = honoRegExpSource(routes);
    if (!src) continue;
    const inputs = new Set(["", "/", "//", "/a/", "/zzz"]);
    for (const p of routes) {
      for (let k = 0; k < 3; k++) {
        let path = p.replace(/:[^/]+?(\{[^}]+\})?(?=\/|$|\*)/g, () => pick(values)).replace(/\/\*$/, R() < 0.5 ? "" : "/" + pick(values) + (R() < 0.3 ? "/" + pick(values) : "")).replace(/\*$/, pick(values));
        const m = R();
        if (m < 0.1) path += "/";
        else if (m < 0.2) path = path.slice(0, Math.max(0, path.length - 1 - Math.floor(R() * 3)));
        else if (m < 0.25) path += "x";
        else if (m < 0.28) path += "\n";
        inputs.add(path);
      }
    }
    for (const i of inputs) cases.push([src, "", i, 0]);
  }
  // the older shape: a static child beside a parameter at one node
  const old = "^/(?:help$()|([^/]+)/(?:followe(?:es$()|rs$())|posts(?:/([^/]+)(?:/likes$()|$())|$())))";
  for (const i of ["/help", "/help/followees", "/helpx/followers", "/u/posts", "/u/posts/9", "/u/posts/9/likes", "/u/posts/9/likes/", "/u/followe", "/", "/help/posts/1"]) cases.push([old, "", i, 0]);
  // the benchmark's GET regexp and flags that leave the tier (s keeps it)
  const bench = "^\\/(?:event\\/([^/]+)(?:$()|\\/comments$())|map\\/([^/]+)\\/events$()|static(?:|\\/.*)$()|user\\/lookup\\/(?:email\\/([^/]+)$()|username\\/([^/]+)$()))";
  for (const f of ["", "s", "g", "d", "i", "m", "u", "y"])
    for (const i of ["/user/lookup/username/hey", "/event/abcd1234/comments", "/static/index.html", "/static", "/static/a\nb", "/map/tokyo/events", "/nowhere/at/all", "/event/abcd1234", "/EVENT/x"]) cases.push([bench, f, i, 0]);
  return cases;
}
