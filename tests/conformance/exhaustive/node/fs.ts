// node:fs: whole files, stats, directories, links, descriptors, the promise and callback forms, Node's errors; all in a temp dir.
import fs, { promises as fsp, Stats, Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
let dir = "";
function rel(p: string | undefined): string { return p === undefined ? "-" : p === dir ? "<dir>" : path.basename(p); }
function code(f: () => unknown): string {
  try { f(); return "ok"; }
  catch (e) { const x = e as { code?: string; syscall?: string; path?: string; dest?: string; constructor: { name: string } }; return x.constructor.name + ":" + x.code + ":" + x.syscall + ":" + rel(x.path) + ":" + rel(x.dest); }
}
async function main(): Promise<void> {
  const out: string[] = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garnet-fs-"));
  const nope = path.join(dir, "nope");
  const f1 = path.join(dir, "a.txt");
  fs.writeFileSync(f1, "hello\n");
  fs.appendFileSync(f1, "wörld");
  const bytes = fs.readFileSync(f1);
  out.push([path.basename(dir).startsWith("garnet-fs-"), path.basename(dir).length, fs.readFileSync(f1, "utf8"), bytes.length, Buffer.isBuffer(bytes), bytes instanceof Uint8Array, fs.readFileSync(f1, { encoding: "hex" }).slice(0, 10), fs.readFileSync(f1, "latin1").length].join("|"));
  const f2 = path.join(dir, "b.bin");
  fs.writeFileSync(f2, Buffer.from([1, 2, 3, 250]));
  const st = fs.statSync(f1) as Stats;
  out.push([Array.from(fs.readFileSync(f2) as Buffer).join(","), st.size, st.isFile(), st.isDirectory(), st.isSymbolicLink(), (fs.statSync(dir) as Stats).isDirectory(), st.mtime instanceof Date, Math.abs(st.mtimeMs - Date.now()) < 300000, st.nlink, (st.mode & 0o170000) === 0o100000, typeof st.ino, st.blksize > 0].join("|"));
  out.push([fs.existsSync(f1), fs.existsSync(nope), fs.existsSync(dir), fs.statSync(nope, { throwIfNoEntry: false }) === undefined, code(() => fs.accessSync(nope)), code(() => fs.accessSync(f1, fs.constants.R_OK))].join("|"));
  const made = fs.mkdirSync(path.join(dir, "d1/d2/d3"), { recursive: true });
  out.push([made === path.join(dir, "d1"), fs.mkdirSync(path.join(dir, "d1/d2/d3"), { recursive: true }) === undefined, code(() => fs.mkdirSync(path.join(dir, "d1"))), fs.mkdirSync(path.join(dir, "e")) === undefined, code(() => fs.mkdirSync(path.join(f1, "x"))), code(() => fs.mkdirSync(path.join(nope, "x")))].join("|"));
  fs.writeFileSync(path.join(dir, "d1/d2/deep.txt"), "deep");
  const names = (fs.readdirSync(dir) as string[]).sort();
  const types = (fs.readdirSync(dir, { withFileTypes: true }) as Dirent[]).sort((a, b) => a.name < b.name ? -1 : 1).map((d) => d.name + ":" + (d.isDirectory() ? "d" : d.isFile() ? "f" : "?") + ":" + (d.parentPath === dir));
  const rec = (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
  out.push([names.join(","), types.join(","), rec.join(","), code(() => fs.readdirSync(nope)), code(() => fs.readdirSync(f1))].join("|"));
  const f3 = path.join(dir, "c.bin");
  fs.renameSync(f2, f3);
  const f4 = path.join(dir, "copy.txt");
  fs.copyFileSync(f1, f4);
  out.push([fs.existsSync(f2), fs.existsSync(f3), fs.readFileSync(f4, "utf8") === fs.readFileSync(f1, "utf8"), code(() => fs.copyFileSync(f1, f4, fs.constants.COPYFILE_EXCL)), code(() => fs.copyFileSync(nope, f4)), code(() => fs.renameSync(nope, f4))].join("|"));
  const link = path.join(dir, "link");
  fs.symlinkSync(f1, link);
  out.push([fs.readlinkSync(link) === f1, (fs.lstatSync(link) as Stats).isSymbolicLink(), (fs.statSync(link) as Stats).isFile(), fs.realpathSync(link) === fs.realpathSync(f1), fs.realpathSync.native(f1) === fs.realpathSync(f1), code(() => fs.realpathSync(nope)), code(() => fs.readlinkSync(f1)), code(() => fs.symlinkSync(f1, link))].join("|"));
  const f5 = path.join(dir, "fd.txt");
  const fd = fs.openSync(f5, "w+");
  const w1 = fs.writeSync(fd, "abcdef");
  const w2 = fs.writeSync(fd, Buffer.from("XY"), 0, 2, 1);
  const buf = Buffer.alloc(6);
  const r1 = fs.readSync(fd, buf, 0, 6, 0);
  const small = Buffer.alloc(2);
  const r2 = fs.readSync(fd, small, { position: 4 });
  const size = fs.fstatSync(fd).size;
  fs.ftruncateSync(fd, 3);
  fs.closeSync(fd);
  out.push([w1, w2, r1, buf.toString(), r2, small.toString(), size, fs.readFileSync(f5, "utf8"), code(() => fs.openSync(f5, "wx")), code(() => fs.openSync(nope, "r")), code(() => fs.closeSync(fd)), code(() => fs.readSync(fd, buf, 0, 1, 0))].join("|"));
  fs.utimesSync(f1, 1000, 2000);
  const st2 = fs.statSync(f1) as Stats;
  fs.utimesSync(f1, new Date(5000000), new Date(6000000));
  const st3 = fs.statSync(f1) as Stats;
  fs.chmodSync(f1, 0o600);
  const mode1 = (fs.statSync(f1) as Stats).mode & 0o777;
  fs.chmodSync(f1, "644");
  fs.truncateSync(f4, 2);
  out.push([st2.atimeMs, st2.mtimeMs, st3.mtimeMs, mode1.toString(8), ((fs.statSync(f1) as Stats).mode & 0o777).toString(8), fs.readFileSync(f4, "utf8"), code(() => fs.truncateSync(nope)), code(() => fs.chmodSync(nope, 0o600))].join("|"));
  out.push([code(() => fs.readFileSync(nope)), code(() => fs.readFileSync(dir)), code(() => fs.unlinkSync(nope)), code(() => fs.rmdirSync(path.join(dir, "d1"))), code(() => fs.rmdirSync(nope)), code(() => fs.rmSync(nope)), code(() => fs.rmSync(path.join(dir, "d1"))), code(() => fs.writeFileSync(path.join(nope, "x"), "y")), code(() => fs.readFileSync(5 as unknown as string + "")), code(() => fs.statSync(nope))].join("|"));
  let msg = "";
  try { fs.readFileSync(nope); } catch (e) { msg = (e as Error).message.replace(dir, "<dir>"); }
  out.push(msg);
  fs.rmSync(nope, { force: true });
  fs.rmSync(path.join(dir, "d1"), { recursive: true });
  out.push([fs.existsSync(path.join(dir, "d1")), (fs.readdirSync(dir) as string[]).sort().join(",")].join("|"));
  const f6 = path.join(dir, "p.txt");
  await fsp.writeFile(f6, "promised");
  await fsPromises.appendFile(f6, "!");
  const pst = await fsp.stat(f6);
  let pcode = "";
  try { await fsp.readFile(nope); } catch (e) { pcode = (e as { code: string }).code; }
  out.push([await fsp.readFile(f6, "utf8"), pst.size, (await fsPromises.readdir(dir) as string[]).sort().join(","), pcode, await fsp.realpath(f6) === fs.realpathSync(f6), fsPromises.readFile === fsp.readFile].join("|"));
  const cb1 = await new Promise<string>((res) => { fs.readFile(f6, "utf8", (err, data) => res(String(err) + ":" + data)); });
  const cb2 = await new Promise<string>((res) => { fs.stat(nope, (err) => res(String((err as { code: string }).code))); });
  const cb3 = await new Promise<string>((res) => { fs.exists(f6, (ok) => res(String(ok))); });
  const cb4 = await new Promise<string>((res) => { fs.writeFile(path.join(dir, "cb.txt"), "cb", (err) => res(String(err) + ":" + fs.readFileSync(path.join(dir, "cb.txt"), "utf8"))); });
  const cb5 = await new Promise<string>((res) => { const fd2 = fs.openSync(f6, "r"); const b = Buffer.alloc(4); fs.read(fd2, b, 0, 4, 2, (err, n, bb) => { fs.closeSync(fd2); res(String(err) + ":" + n + ":" + bb.toString()); }); });
  const cb6 = await new Promise<string>((res) => { fs.readdir(dir, (err, list) => res(String(err) + ":" + (list as string[]).sort().join(","))); });
  out.push([cb1, cb2, cb3, cb4, cb5, cb6].join("|"));
  fs.rmSync(dir, { recursive: true, force: true });
  out.push([fs.existsSync(dir), code(() => fs.rmSync(dir))].join("|"));
  console.log(out.join("\n"));
}
main();
