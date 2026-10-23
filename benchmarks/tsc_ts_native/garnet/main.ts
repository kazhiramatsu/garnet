// tsc-ts's src/main.ts for the garnet build: the same command line; the Node
// modules resolve to the shims beside this file (tsconfig `paths`). Checker
// threads are forked processes (docs/fork_workers_design.md): a child runs
// `runThread` with the data the main process gave its Worker. Parse threads
// are not started (`parallelParse.spawn` stays unset), so parsing is serial.
import './prelude.js';
import { dirname } from 'node:path';
import { runServer } from '../src/api/server.js';
import { runThread, type ThreadData, type ThreadDrivers } from '../src/compiler/thread-entry.js';
import { parallelCheck } from '../src/compiler/parallel-check.js';
import { mark, markMemory, timeline } from '../src/compiler/timeline.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from '../src/drivers/node-system.js';
import '../src/drivers/lowering.js';
import { enterWorker, Worker } from 'node:worker_threads';
import { host } from './host.js';

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

/** A checker thread: a forked child running `runThread` with `data`. */
function spawnThread(data: ThreadData): Worker {
  return new Worker(undefined, { workerData: data });
}
host.setWorkerEntry((data: unknown) => {
  enterWorker(data);
  runThread(data, drivers);
});

if (timeline) {
  // The monotonic clock at the same moment, to line the timeline up with profiles.
  const hr = process.hrtime();
  mark(`main clock ${hr[0]} ${hr[1]}`);
}
if (args[0] !== '--api') {
  // startThreads would also install parallelParse.spawn (parse threads).
  parallelCheck.writer = drivers.outputWriter();
  parallelCheck.spawn = (program, index, counter, order, nodeIds, symbolIds, reserved, emits, emitKinds, checking) =>
    spawnThread({ kind: 'check', program, args, index, counter, order, nodeIds, symbolIds, reserved, emits, emitKinds, checking });
}
const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
// Watch mode and `--checkers` keep running until their callbacks exit.
if (status !== watching) {
  markMemory();
  mark('exit');
  process.exit(status);
}
