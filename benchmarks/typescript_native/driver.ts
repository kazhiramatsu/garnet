import * as ts from "./src/compiler/_namespaces/ts.js";

type NativeSystem = ts.System & {
  getAccessibleFileSystemEntries(path: string): ts.FileSystemEntries;
  modifiedTime(path: string): number | undefined;
  setModifiedTimeMs(path: string, time: number): void;
};
const native = (globalThis as unknown as { __garnetSystem?: NativeSystem }).__garnetSystem;
if (native) {
  native.resolvePath = path => ts.resolvePath(native.getCurrentDirectory(), path);
  native.getDirectories = path => native.getAccessibleFileSystemEntries(path).directories.slice();
  native.readDirectory = (root, extensions, exclude, include, depth) => ts.matchFiles(
    root, extensions, exclude, include, native.useCaseSensitiveFileNames,
    native.getCurrentDirectory(), depth, native.getAccessibleFileSystemEntries, native.realpath!,
  );
  native.getModifiedTime = path => {
    const time = native.modifiedTime(path);
    return time === undefined ? undefined : new Date(time);
  };
  native.setModifiedTime = (path, date) => native.setModifiedTimeMs(path, date.getTime());
  ts.setSys(native);
}
ts.executeCommandLine(ts.sys, ts.noop, ts.sys.args);
