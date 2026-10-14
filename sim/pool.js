import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** Runs simulation configs across worker threads; returns results (failed runs carry `error`). */
export async function runParallel(configs, workers = Math.max(1, availableParallelism() - 1)) {
  const chunks = Array.from({ length: workers }, () => []);
  configs.forEach((c, i) => chunks[i % workers].push(c));
  const parts = await Promise.all(chunks.filter((c) => c.length).map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: { configs: chunk } });
    w.once('message', resolve);
    w.once('error', reject);
  })));
  return parts.flat();
}
