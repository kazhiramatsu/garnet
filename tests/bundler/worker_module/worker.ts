import { parentPort, workerData } from "node:worker_threads";
import { label } from "./shared";
import { total } from "./sum";
parentPort!.postMessage({ sum: total(workerData as number[]), label });
