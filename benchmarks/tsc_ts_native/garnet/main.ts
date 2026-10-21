// tsc-ts's src/main.ts for the garnet build: one thread (a worker would be
// spawned from this module's own URL, `new Worker(new URL(import.meta.url))`,
// which garnet does not build), the same command line otherwise. The Node
// modules resolve to the shims beside this file (tsconfig `paths`).
import './prelude.js';
import { dirname } from 'node:path';
import { runServer } from '../src/api/server.js';
import { startThreads, type ThreadData, type ThreadDrivers } from '../src/compiler/thread-entry.js';
import { mark, markMemory, timeline } from '../src/compiler/timeline.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from '../src/drivers/node-system.js';
import '../src/drivers/lowering.js';
import { Worker } from 'node:worker_threads';

// Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
const defaultLibraryPath = process.env.TSC_TS_LIB_DIR ?? dirname(process.execPath);

const args = process.argv.slice(2);

/** What the threads read from this command line. */
const drivers: ThreadDrivers = {
  outputWriter: () => outputWriterOfThread(defaultLibraryPath),
  programOfCommandLine: (threadArgs) => programOfCommandLine(threadArgs, defaultLibraryPath),
  parseThreadOfCommandLine: (threadArgs, configFileName) =>
    parseThreadOfCommandLine(threadArgs, configFileName, defaultLibraryPath),
};

/** No worker threads: the shim's Worker throws if a run asks for one. */
function spawnThread(data: ThreadData): Worker {
  return new Worker(undefined, { workerData: data });
}

if (timeline) {
  // The monotonic clock at the same moment, to line the timeline up with profiles.
  const hr = process.hrtime();
  mark(`main clock ${hr[0]} ${hr[1]}`);
}
if (args[0] !== '--api') startThreads(spawnThread, drivers, args);
const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
// Watch mode and `--checkers` keep running until their callbacks exit.
if (status !== watching) {
  markMemory();
  mark('exit');
  process.exit(status);
}
