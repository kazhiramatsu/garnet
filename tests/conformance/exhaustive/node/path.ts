// node:path (docs/node_compat_design.md): the POSIX algorithms against Node's.
import path from "node:path";
import { join, resolve, normalize, dirname, basename, extname, relative, isAbsolute, parse, format, sep, delimiter } from "node:path";
import posix from "node:path/posix";
function attempt(f: () => unknown): string {
  try { return String(f()); } catch (e) { return (e as Error).name + ":" + (e as { code?: string }).code + ":" + (e as Error).message; }
}
function main(): void {
  const out: string[] = [];
  out.push([join("a", "b", "../c", "./d"), join("/a/", "/b"), join("", ""), join("a", "", "b"), join("/"), join("a/", "..")].join("|"));
  out.push([resolve("/a/b", "../c", "./d"), resolve("/a", "/b", "c"), resolve("/x/y/", "..", "..", ".."), resolve("/"), resolve("a", "b") === join(process.cwd(), "a", "b")].join("|"));
  out.push([normalize("/a//b/../c/."), normalize("a/./b/"), normalize("../a/../../b"), normalize(""), normalize("/.."), normalize("./"), normalize("//a")].join("|"));
  out.push([dirname("/a/b/c"), dirname("/a"), dirname("a"), dirname(""), dirname("/"), dirname("//a"), dirname("a/b/")].join("|"));
  out.push([basename("/q/w/e.tar.gz", ".gz"), basename("/q/w/e.tar.gz"), basename("a/b/"), basename("/"), basename(""), basename("abc", "abc"), basename("x.js", ".js"), basename("x.js", "js")].join("|"));
  out.push([extname("a.b.c"), extname(".bashrc"), extname("a."), extname("a"), extname("/x/y.z/w"), extname("..."), extname("a.b/")].join("|"));
  out.push([relative("/data/a/b", "/data/c"), relative("/a", "/a"), relative("/a/b", "/a/b/c/d"), relative("/a/b/c", "/a"), relative("/", "/x")].join("|"));
  out.push([isAbsolute("/x"), isAbsolute("x"), isAbsolute(""), isAbsolute("./x")].join("|"));
  out.push([JSON.stringify(parse("/home/u/file.txt")), JSON.stringify(parse("file")), JSON.stringify(parse("/")), JSON.stringify(parse(".bashrc")), JSON.stringify(parse("a/b.c.d/"))].join("|"));
  out.push([format({ dir: "/x/y", base: "z.txt" }), format({ root: "/", name: "n", ext: "e" }), format({ name: "n", ext: ".e" }), format(parse("/a/b/c.d")), format({ root: "/", base: "r" })].join("|"));
  out.push([sep, delimiter, path.sep === posix.sep, path.posix === path, posix.posix === posix, path.join === join].join("|"));
  out.push([attempt(() => join(1 as unknown as string)), attempt(() => basename("x", 2 as unknown as string)), attempt(() => path.resolve(null as unknown as string))].join("|"));
  console.log(out.join("\n"));
}
main();
