import { parentPort, workerData } from 'node:worker_threads';
import { runSimulation } from './runner.js';

const results = [];
for (const cfg of workerData.configs) {
  try {
    results.push(runSimulation(cfg));
  } catch (err) {
    results.push({ cfg, error: err.message });
  }
}
parentPort.postMessage(results);
