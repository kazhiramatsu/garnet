// node:stream/promises: pipeline and finished returning promises.
import { pipeline as callbackPipeline, finished as callbackFinished, Stream, FinishedOptions } from "../stream";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pipeline(...streams: any[]): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    callbackPipeline(...streams, (err: Error | null | undefined, value: any) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}
export function finished(stream: Stream, options?: FinishedOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    callbackFinished(stream, options || {}, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
const promises = { pipeline, finished };
export default promises;
