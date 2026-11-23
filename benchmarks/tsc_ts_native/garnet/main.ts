// tsc-ts's src/main.ts for the garnet build: the same command line; the Node
// modules are garnet's (lib/node), and node:worker_threads runs over forked
// processes (docs/fork_workers_design.md): a worker runs this file again with
// isMainThread false and calls `runThread` with its workerData. Parse threads
// are shared workers (docs/published_graphs_design.md): the bound files they
// publish reach the main thread by reference (`shared: true`, garnet's option
// on the Worker, which Node ignores).
import { dirname } from 'node:path';
import { runServer } from '../src/api/server.js';
import { arena } from 'garnet:arena';
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

/**
 * The young budget of a checker thread, in MiB (`resourceLimits.maxYoungGenerationSizeMb`, which
 * garnet's forked workers take as the allocation between two young collections). A checker's heap
 * ends with it, and a collection in it promotes what the check keeps and makes the rest of the run
 * pay for an old generation (pretenured sites, barriers): with a budget its whole run fits in, the
 * checker of checker.ts runs 4.9% fewer instructions for 63 MB (the TypeScript compiler project;
 * its checkers allocate under 100 MiB each). A larger project collects once per budget.
 */
const checkerYoungMb = 128;

/**
 * What a checker allocates for each character of a file it parses in full itself, in bytes: a file whose
 * parse thread left a function body out (tsc-ts's `skippedBodyText`) is parsed and bound by the checker
 * that takes it, in its own heap (the parse thread of checker.ts used 64 MB of its region for 3.15 M
 * characters). Those files are part of what a checker's young budget must hold.
 */
const fullFileBytesPerChar = 32;

/** The budget of the checkers of the program last given to one, with the files they may parse in full. */
let checkerBudgetMb = checkerYoungMb;
let budgetProgram: unknown = undefined;

/**
 * A thread: a forked child running this file, which calls `runThread` with `data`. With `together` it is
 * not started here but by `Worker.startTogether`, with the other threads of its kind (below).
 */
function spawnThread(data: ThreadData, together = false): Worker {
  if (data.kind === 'check') {
    const program = data.program;
    if (program !== undefined && program !== budgetProgram) {
      budgetProgram = program;
      let chars = 0;
      for (const file of program.getSourceFiles()) if (file.skippedBodies > 0) chars += file.text.length;
      checkerBudgetMb = checkerYoungMb + Math.ceil((chars * fullFileBytesPerChar) / (1024 * 1024));
    }
    return new Worker(new URL(import.meta.url), { workerData: data, resourceLimits: { maxYoungGenerationSizeMb: checkerBudgetMb }, start: !together });
  }
  // A fork of a checker thread, started by that thread to share a huge file's statements: it has the
  // checker's heap as it is, the young cells it allocated so far among it, and the same budget again.
  if (data.kind === 'split')
    return new Worker(new URL(import.meta.url), { workerData: data, resourceLimits: { maxYoungGenerationSizeMb: 2 * checkerBudgetMb } });
  return new Worker(new URL(import.meta.url), { workerData: data, shared: data.kind === 'parse', start: !together });
}

if (!isMainThread) {
  runThread(workerData as ThreadData, drivers);
} else {
  if (timeline) {
    // The monotonic clock at the same moment, to line the timeline up with profiles.
    const hr = process.hrtime();
    mark(`main clock ${hr[0]} ${hr[1]}`);
  }
  // checker, parse and reference threads, as the Node build starts them; here a thread is a fork of
  // the thread that starts it (a checker thread shares a huge file with forks of itself), and the
  // parse threads, like the checker threads, are started together: one fork of this process, which
  // forks them, instead of ten forks that each keep this thread most of a millisecond
  // (docs/fork_workers_design.md, "Workers started together")
  if (args[0] !== '--api') startThreads(spawnThread, drivers, args, true, (workers) => Worker.startTogether(workers), arena);
  const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) {
    markMemory();
    mark('exit');
    process.exit(status);
  }
}
