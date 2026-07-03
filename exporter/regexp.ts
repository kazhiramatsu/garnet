export type RegExpLiteralPrefixPlan = {
  raw: string;
  source: string;
  flags: string;
  prefix: string;
  anchoredStart: boolean;
  sticky: boolean;
  global: boolean;
  ignoreCase: boolean;
  unicodeMode: boolean;
  stoppedAt: string;
};

function isHex(s: string): boolean {
  return /^[0-9A-Fa-f]+$/.test(s);
}

function fromCodePointUnit(cp: number): string | undefined {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return undefined;
  return String.fromCodePoint(cp);
}

function decodeEscape(body: string, i: number, unicodeMode: boolean): { value?: string; next: number; stop?: string } {
  if (i + 1 >= body.length) return { next: i + 1, stop: "trailing escape" };
  const c = body[i + 1];
  switch (c) {
    case "n": return { value: "\n", next: i + 2 };
    case "r": return { value: "\r", next: i + 2 };
    case "t": return { value: "\t", next: i + 2 };
    case "f": return { value: "\f", next: i + 2 };
    case "v": return { value: "\v", next: i + 2 };
    case "\\":
    case "/":
    case ".":
    case "*":
    case "+":
    case "?":
    case "^":
    case "$":
    case "(":
    case ")":
    case "[":
    case "]":
    case "{":
    case "}":
    case "|":
      return { value: c, next: i + 2 };
    case "x": {
      const h = body.slice(i + 2, i + 4);
      if (h.length !== 2 || !isHex(h)) return { next: i + 2, stop: "invalid hex escape" };
      return { value: String.fromCharCode(parseInt(h, 16)), next: i + 4 };
    }
    case "u": {
      if (unicodeMode && body[i + 2] === "{") {
        const end = body.indexOf("}", i + 3);
        if (end < 0) return { next: i + 2, stop: "unterminated unicode escape" };
        const h = body.slice(i + 3, end);
        if (h.length === 0 || !isHex(h)) return { next: end + 1, stop: "invalid unicode escape" };
        const v = fromCodePointUnit(parseInt(h, 16));
        return v === undefined ? { next: end + 1, stop: "invalid unicode code point" } : { value: v, next: end + 1 };
      }
      const h = body.slice(i + 2, i + 6);
      if (h.length !== 4 || !isHex(h)) return { next: i + 2, stop: "invalid unicode escape" };
      return { value: String.fromCharCode(parseInt(h, 16)), next: i + 6 };
    }
    default:
      return { next: i + 2, stop: `non-literal escape \\${c}` };
  }
}

export function splitRegExpLiteral(raw: string): { source: string; flags: string } | undefined {
  if (raw.length < 2 || raw[0] !== "/") return undefined;
  const slash = raw.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return { source: raw.slice(1, slash), flags: raw.slice(slash + 1) };
}

export function classifyRegExpLiteral(raw: string): RegExpLiteralPrefixPlan {
  const split = splitRegExpLiteral(raw);
  const source = split?.source ?? "";
  const flags = split?.flags ?? "";
  const unicodeMode = flags.includes("u") || flags.includes("v");
  let i = 0;
  let anchoredStart = false;
  if (source[i] === "^" && !flags.includes("m")) {
    anchoredStart = true;
    i++;
  }
  let prefix = "";
  let stoppedAt = i >= source.length ? "end" : "";
  const meta = new Set(["^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      const decoded = decodeEscape(source, i, unicodeMode);
      if (decoded.value === undefined) {
        stoppedAt = decoded.stop ?? "escape";
        break;
      }
      prefix += decoded.value;
      i = decoded.next;
      stoppedAt = i >= source.length ? "end" : "";
      continue;
    }
    if (meta.has(c)) {
      stoppedAt = c;
      break;
    }
    prefix += c;
    i++;
    stoppedAt = i >= source.length ? "end" : "";
  }
  return {
    raw,
    source,
    flags,
    prefix,
    anchoredStart,
    sticky: flags.includes("y"),
    global: flags.includes("g"),
    ignoreCase: flags.includes("i"),
    unicodeMode,
    stoppedAt: stoppedAt || "end",
  };
}
