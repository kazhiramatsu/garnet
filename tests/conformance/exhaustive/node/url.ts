// node:url and node:querystring: the WHATWG URL parser (special and other
// schemes, relative references, hosts, percent-encoding, setters, the live
// searchParams), URLSearchParams, file URL conversions, the legacy API.
import { URL as NodeURL, URLSearchParams as NodeParams, fileURLToPath, pathToFileURL, parse, format, resolve, domainToASCII } from "node:url";
import url from "node:url";
import qs from "node:querystring";
type Coded = Error & { code: string; input?: string };
function main(): void {
  (process as { noDeprecation?: boolean }).noDeprecation = true;   // url.parse() is deprecated in Node
  const out: string[] = [];
  const cases: [string, string | undefined][] = [
    ["http://example.com", undefined],
    ["HTTP://EXAMPLE.com:80/a/./b/../c?x=1#frag", undefined],
    ["https://user:pa ss@host:8443/p a t h?q=a b#h a", undefined],
    ["../d?y#z", "http://example.com/a/b/c"],
    ["//other.org/x", "https://example.com/a"],
    ["?only=query", "http://h/p/q?old#f"],
    ["#only", "http://h/p?q"],
    ["", "http://h/p?q#f"],
    ["http:foo", "http://a/b/c/d"],
    ["/abs", "http://a/b/c"],
    ["g;x=1/./y", "http://a/b/c/d;p?q"],
    ["../../../../g", "http://a/b/c/d"],
    ["file:///tmp/x y.txt", undefined],
    ["file://localhost/etc/hosts", undefined],
    ["mailto:a@b.c?subject=hi", undefined],
    ["data:text/plain,hello", undefined],
    ["javascript:alert(1)", undefined],
    ["http://[::1]:3000/", undefined],
    ["http://[2001:db8:0:0:1:0:0:1]/", undefined],
    ["http://[::ffff:192.168.1.1]/", undefined],
    ["http://0x7f.1/", undefined],
    ["http://192.168.0.257/", undefined],
    ["http://1.2.3.4.5/", undefined],
    ["http://Exa mple.com", undefined],
    ["http://a/%7Efoo/%2e%2E/bar", undefined],
    ["http://a/b?q=%E3%81%82&p=<>'", undefined],
    ["foo://bar/baz?x#y", undefined],
    ["foo:/x/../y", undefined],
    ["not a url", undefined],
    ["http://a.com:65536", undefined],
    ["http://a.com:0080", undefined],
    ["ws://a/b", undefined],
    ["http://a\\b\\c", undefined],
    ["http://user@host", undefined],
    ["HTTP://a/ü?ü#ü", undefined],
    ["http://a/b/", undefined],
    ["http://a/b/.", undefined],
    ["http://a/b/..", undefined],
    ["foo://host", undefined],
    ["foo:///p", undefined],
    ["blob:https://example.com/uuid", undefined],
    ["  http://trimmed.com/x  ", undefined],
    ["http://a/\tb\nc", undefined],
    ["http://a/b%zz%41", undefined],
    ["x", "mailto:opaque"],
    ["#f", "mailto:opaque?q"],
  ];
  for (const [input, base] of cases) {
    try {
      const u = base === undefined ? new NodeURL(input) : new NodeURL(input, base);
      out.push([u.href, u.origin, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash].join("|"));
    } catch (e) {
      out.push("ERR " + (e as Coded).code + " " + (e as Error).message + " " + (e as Coded).input);
    }
  }
  const u = new NodeURL("http://user:pw@example.com:8080/a/b?x=1#h");
  u.protocol = "https";
  u.port = "443";
  out.push(u.href);
  u.hostname = "other.org";
  u.pathname = "c d/é?#";
  u.search = "?a=1&b=2";
  u.hash = "#frag ment";
  out.push(u.href);
  u.port = "99999";
  u.port = "12ab";
  out.push(u.port);
  u.username = "x y";
  u.password = "";
  u.host = "h2:81";
  out.push(u.href);
  u.protocol = "ftp";
  out.push(u.protocol);
  u.protocol = "foo";
  out.push(u.protocol);
  u.search = "";
  u.hash = "";
  out.push(u.href + " " + JSON.stringify(u.search) + " " + JSON.stringify(u.hash));
  u.hostname = "a:1";
  out.push(u.hostname);
  u.href = "mailto:x@y";
  out.push(u.href + " " + u.pathname + " " + JSON.stringify(u.host) + " " + u.origin);
  u.pathname = "/ignored";
  u.host = "ignored";
  out.push(u.href);
  const p = new NodeURL("http://h/?a=1&b=2&a=3&c=%20x+y&d");
  const sp = p.searchParams;
  out.push(sp.get("a") + " " + sp.getAll("a").join(",") + " " + sp.get("c") + " " + sp.get("d") + " " + sp.has("b") + " " + sp.has("zz") + " " + sp.size);
  sp.append("e", "ü &=");
  sp.set("a", "9");
  sp.delete("b");
  out.push(p.search + " " + p.href);
  sp.sort();
  out.push(sp.toString());
  out.push([...sp.keys()].join(",") + " " + [...sp.values()].join(",") + " " + [...sp].map(([k, v]) => k + ":" + v).join(","));
  const fe: string[] = [];
  sp.forEach((v, k) => fe.push(k + "=" + v));
  out.push(fe.join("&"));
  p.search = "?z=26";
  out.push(sp.get("z") + " " + sp.has("a"));
  sp.delete("z");
  out.push(JSON.stringify(p.search) + " " + p.href);
  out.push(new NodeParams({ q: "x y", n: "1" }).toString() + " " + new NodeParams([["a", "1"], ["b", "2"]]).toString() + " " + new NodeParams("?x=1").get("x") + " " + new NodeParams(new NodeParams("k=v")).toString());
  out.push(new NodeParams("a=1&a=2").getAll("a").join() + " " + new NodeParams("=v&k=").toString() + " " + String(new NodeParams("a=b").get("zz")));
  try { new NodeParams([["a"]] as unknown as [string, string][]); } catch (e) { out.push((e as Coded).code); }
  const dv = new NodeParams("x=1&x=2&y=3");
  dv.delete("x", "1");
  out.push(new NodeParams("has=1&has=2").has("has", "2") + " " + dv.toString() + " " + new NodeParams("a=%zz&b=%E3%81%82&c=+").toString());
  out.push(NodeURL.canParse("http://a") + " " + NodeURL.canParse("nope") + " " + NodeURL.canParse("/p", "http://a") + " " + (NodeURL.parse("nope") === null) + " " + NodeURL.parse("/p", "http://a")!.href);
  out.push(typeof URL + " " + new URL("http://g/x").pathname + " " + new URLSearchParams("a=1").get("a") + " " + JSON.stringify({ u: new NodeURL("http://a/b") }) + " " + String(new NodeURL("http://a/b")));
  out.push(fileURLToPath("file:///tmp/a%20b/c.txt") + " " + fileURLToPath(new NodeURL("file:///x/%E6%97%A5")) + " " + fileURLToPath("file://localhost/l"));
  for (const bad of ["http://x", "file://host/x", "file:///a%2Fb"]) {
    try { fileURLToPath(bad); } catch (e) { out.push((e as Coded).code); }
  }
  out.push(pathToFileURL("/tmp/a b#c?d%e\\f").href + " " + pathToFileURL("/tmp/dir/").href + " " + pathToFileURL("rel/x").href.endsWith("/rel/x"));
  const l = parse("http://user:pw@Example.com:8080/p/a/t/h?query=string&a=1#hash", true);
  out.push([l.protocol, l.slashes, l.auth, l.host, l.port, l.hostname, l.hash, l.search, JSON.stringify(l.query), l.pathname, l.path, l.href].join("|"));
  const l2 = parse("/relative/path?x=1");
  out.push([l2.protocol, l2.host, l2.pathname, l2.search, l2.query, l2.path, l2.href].join("|"));
  const l3 = parse("mailto:someone@example.com");
  out.push([l3.protocol, l3.auth, l3.host, l3.pathname, l3.href].join("|"));
  out.push(parse("//host/p", false, true).host + " " + parse("http://a.com").pathname + " " + parse("http://a.com/x y").pathname + " " + parse("http://[::1]:8/p").hostname + " " + parse("http://[::1]:8/p").host);
  out.push(format({ protocol: "https", hostname: "example.com", pathname: "/some/path", query: { page: "1", format: "json" } }) + " " + format({ protocol: "http:", host: "h:81", pathname: "p", search: "a=1", hash: "x" }) + " " + format(new NodeURL("https://u:p@a.b/c?d#e"), { auth: false, fragment: false }));
  out.push(resolve("/one/two/three", "four") + " " + resolve("http://example.com/", "/one") + " " + resolve("http://example.com/one", "/two") + " " + resolve("http://a/b/c/d;p?q", "../g") + " " + resolve("http://a/b/c", "https://x/y") + " " + resolve("/a/b/", "../c"));
  out.push(domainToASCII("Example.COM") + " " + JSON.stringify(domainToASCII("xn--iñvalid.com")) + " " + typeof url.parse + " " + typeof url.URL);
  out.push(JSON.stringify(qs.parse("a=1&b=2&a=3&c=%20x+y&d&e=")) + " " + qs.stringify({ a: ["1", "2"], b: "x y", c: "true", f: "ü&" }) + " " + qs.escape("a b&c/ü") + " " + qs.unescape("a%20b%zz+c") + " " + JSON.stringify(qs.parse("a:1;b:2", ";", ":")) + " " + qs.stringify({ x: "1", y: "2" }, ";", ":") + " " + Object.keys(qs.parse("a=1&b=2&c=3", "&", "=", { maxKeys: 2 })).join());
  console.log(out.join("\n"));
}
main();
