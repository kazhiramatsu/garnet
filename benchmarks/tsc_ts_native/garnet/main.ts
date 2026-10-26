// tsc-ts's src/main.ts for the garnet build: the same command line; the Node
// modules are garnet's (lib/node), and node:worker_threads runs over forked
// processes (docs/fork_workers_design.md): a worker runs this file again with
// isMainThread false and calls `runThread` with its workerData. Parse threads
// are shared workers (docs/published_graphs_design.md): the bound files they
// publish reach the main thread by reference (`shared: true`, garnet's option
// on the Worker, which Node ignores).
import { dirname } from 'node:path';
import { runServer } from '../src/api/server.js';
import { runThread, startThreads, type ThreadData, type ThreadDrivers } from '../src/compiler/thread-entry.js';
import { mark, markMemory, timeline } from '../src/compiler/timeline.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from '../src/drivers/node-system.js';
import '../src/drivers/lowering.js';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

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

/** A thread: a forked child running this file, which calls `runThread` with `data`. */
function spawnThread(data: ThreadData): Worker {
  return new Worker(new URL(import.meta.url), { workerData: data, shared: data.kind === 'parse' });
}

if (!isMainThread) {
  runThread(workerData as ThreadData, drivers);
} else {
  if (timeline) {
    // The monotonic clock at the same moment, to line the timeline up with profiles.
    const hr = process.hrtime();
    mark(`main clock ${hr[0]} ${hr[1]}`);
  }
  // checker, parse and reference threads, as the Node build starts them
  if (args[0] !== '--api') startThreads(spawnThread, drivers, args);
  const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) {
    markMemory();
    mark('exit');
    process.exit(status);
  }
}
