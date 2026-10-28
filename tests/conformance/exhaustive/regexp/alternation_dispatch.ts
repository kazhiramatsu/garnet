// The alternation's first-character dispatch (rx_compile.c RX_OP_ALT_FIRST): an alternative is
// entered only when the next unit is in its first set, and disjoint first sets need no choice
// point. The cases: disjoint alternatives (hono's route regexp), overlapping ones (an ipv4
// octet), alternatives that can be empty, case-insensitive and Unicode alternatives over Latin-1
// and UTF-16 input, alternations inside quantifiers, lookarounds and lookbehinds, back references,
// the end of the input, global and sticky iteration, split and replace.
function show(label: string, v: unknown): void { console.log(label, JSON.stringify(v)); }
function main(): void {
  const route = /^\/(?:event\/([^/]+)(?:$()|\/comments$())|map\/([^/]+)\/events$()|static(?:|\/.*)$()|user\/lookup\/(?:email\/([^/]+)$()|username\/([^/]+)$()))/;
  for (const p of ["/event/abcd1234", "/event/abcd1234/comments", "/map/tokyo/events", "/static", "/static/index.html", "/user/lookup/email/a@b.c", "/user/lookup/username/hey", "/user", "/events", "/mapx", "", "/"]) {
    const m = p.match(route); show("route " + p, m ? [m.indexOf("", 1), m[1], m[3], m[5], m[6]] : null);
  }
  const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  for (const s of ["192.168.0.1", "255.255.255.255", "256.1.1.1", "01.1.1.1", "1.1.1", "0.0.0.0", "199.200.249.25"]) show("ipv4 " + s, ipv4.test(s));
  // alternatives that can be empty, and an empty alternative
  show("empty alt", ["ab", "b", "", "xb"].map((s) => JSON.stringify(/^(?:a|)b/.exec(s))));
  show("optional first", ["ab", "b", "cb"].map((s) => JSON.stringify(/^(?:a?|c)b/.exec(s))));
  show("anchor first", ["ab", "cb", "xab"].map((s) => JSON.stringify(/(?:^a|c)b/.exec(s))));
  show("wordb first", ["a b", "ab", "a-c"].map((s) => JSON.stringify(/(?:\ba|-c)\b/.exec(s))));
  show("lookahead first", ["ab", "b", "cb"].map((s) => JSON.stringify(/(?:(?=a)ab|b)/.exec(s))));
  show("backref alt", ["aa", "b", "ab"].map((s) => JSON.stringify(/^(?:(a)\1|b)$/.exec(s))));
  // case-insensitive alternatives: the equivalents of the first letters, Latin-1 and beyond
  show("icase", ["Kilo", "kilo", "Kilo", "Mega", "mega", "giga"].map((s) => JSON.stringify(/^(?:kilo|mega|GIGA)/i.exec(s))));
  show("icase mu", ["µs", "μs", "Ms", "ns"].map((s) => JSON.stringify(/^(?:μs|ns)/i.exec(s))));
  show("icase sharp s", ["ſtop", "stop", "Stop", "atop"].map((s) => JSON.stringify(/(?:stop|atop)/i.exec(s))));
  // Unicode alternatives (code point mode), surrogate pairs and lone surrogates, wide input
  show("u emoji", ["\u{1F600}x", "\u{1F602}y", "ay", "\u{1F600}y", "\uD83Dy"].map((s) => JSON.stringify(/^(?:\u{1F600}x|\u{1F602}y|ay)/u.exec(s))));
  show("no-u emoji", ["\u{1F600}x", "\u{1F602}y", "\uD83Dx"].map((s) => JSON.stringify(/^(?:😀x|😂y|\uD83Dx)/.exec(s))));
  show("wide first", ["あい", "うえ", "aい", "あ"].map((s) => JSON.stringify(/^(?:あい|うえ|aい)/.exec(s))));
  show("wide vs narrow", ["été", "ete", "éte", "x"].map((s) => JSON.stringify(/(?:ét|et|x)/.exec(s))));
  show("lone surrogate alt", ["\uDE00a", "😀a", "b"].map((s) => JSON.stringify(/^(?:\uDE00a|b)/u.exec(s))));
  // classes, negated classes and dots as first characters
  show("class first", ["1a", "xb", "zb", "9b"].map((s) => JSON.stringify(/^(?:[0-9]a|[^0-9]b)/.exec(s))));
  show("dot first", ["xa", "\nb", "\nc", "b"].map((s) => JSON.stringify(/^(?:.a|\nb|c)/.exec(s))));
  show("dotall first", ["\na", "\nb"].map((s) => JSON.stringify(/^(?:.a|\nb)/s.exec(s))));
  // alternation inside quantifiers, nested alternations, more than eight alternatives
  show("quant alt", ["abcdab", "cdcdcd", "abx", "x"].map((s) => JSON.stringify(/^(?:ab|cd)+/.exec(s))));
  show("nested", ["ax", "by", "cz", "bz", "d"].map((s) => JSON.stringify(/^(?:(?:a|b)x|(?:b|c)y|cz)/.exec(s))));
  const many = /^(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu)$/;
  show("many", ["alpha", "eta", "epsilon", "mu", "nu", "zet", ""].map((s) => many.test(s)));
  show("shared prefix", ["interface", "in", "int", "integer", "i"].map((s) => JSON.stringify(/^(?:interface|int|in|integer)$/.exec(s))));
  // lookbehind alternations (matched backward) and lookahead alternations
  show("lookbehind", ["ad", "bcd", "xd", "d"].map((s) => JSON.stringify(/(?<=a|bc)d/.exec(s))));
  show("neg lookbehind", ["ad", "bcd", "xd"].map((s) => JSON.stringify(/(?<!a|bc)d/.exec(s))));
  show("lookahead", ["ab", "ac", "ad"].map((s) => JSON.stringify(/a(?=b|c)/.exec(s))));
  // the end of the input, global and sticky iteration, split and replace
  show("end", ["", "a", "ab"].map((s) => JSON.stringify(/(?:ab|a|b)$/.exec(s))));
  show("global", "a1b2c3".match(/(?:[a-z]|\d\d|\d)/g));
  const sticky = /(?:foo|bar|baz)/y; const found: string[] = []; let r: RegExpExecArray | null;
  while ((r = sticky.exec("foobarbazqux")) !== null) found.push(r[0] + "@" + r.index);
  show("sticky", [found, sticky.lastIndex]);
  show("split", "one, two;three ,four".split(/(?:, |;| ,)/));
  show("replace", "cat bat rat".replace(/(?:cat|rat)/g, "$&s"));
  // a dynamic pattern (the interpreter) and the literal (the native tier) agree
  const dyn = new RegExp("^(?:event\\/([^/]+)|map\\/([^/]+)\\/events|user\\/(?:email|username)\\/([^/]+))$");
  show("dyn", ["/event/x", "/map/t/events", "/user/email/e", "/user/name/x", "/x"].map((s) => JSON.stringify(dyn.exec(s.slice(1)))));
}
main();
