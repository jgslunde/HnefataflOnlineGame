/**
 * Page side of the search worker (searchWorker.js): sends jobs and returns promises.
 *
 *   const client = new SearchClient();
 *   await client.loadModel(id, url, info);
 *   const job = client.search(game, params, stats => ...progress...);
 *   const result = await job.promise;   // {stats, stopped} or {cancelled: true}
 *   client.cancel([job.id]);            // or client.cancel() for every job
 */
class SearchClient {
    constructor(workerUrl = 'searchWorker.js') {
        this.nextId = 1;
        this.jobs = new Map();
        this.failed = null;
        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (event) => this._onMessage(event.data);
        this.worker.onerror = (event) => {
            // The worker script itself failed (for example onnxruntime could not be fetched)
            this.failed = new Error(event.message || 'The search worker failed to start');
            for (const job of this.jobs.values()) job.reject(this.failed);
            this.jobs.clear();
        };
    }

    _send(msg, onProgress) {
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            if (this.failed) {
                reject(this.failed);
                return;
            }
            this.jobs.set(id, { resolve, reject, onProgress });
            this.worker.postMessage({ ...msg, id });
        });
        return { id, promise };
    }

    _onMessage(msg) {
        const job = this.jobs.get(msg.id);
        if (!job) return;
        if (msg.type === 'progress') {
            if (job.onProgress) job.onProgress(msg.stats);
            return;
        }
        this.jobs.delete(msg.id);
        if (msg.type === 'error') job.reject(new Error(msg.message));
        else job.resolve(msg);
    }

    /** Load a model; resolves with {msPerCall, loadMs, inputNames, outputNames}. */
    loadModel(modelId, url, info) {
        return this._send({ type: 'load', modelId, url, info }).promise;
    }

    /**
     * Search a position. params: {sims (0 = until cancelled), cPuct, fpuReduction, discount,
     * progressMs, maxSims}. Returns {id, promise}.
     */
    search(game, params, onProgress) {
        return this._send({ type: 'search', state: game.toState(), params }, onProgress);
    }

    /** One network evaluation: resolves with {result: {value, children: [{move, prior}], ending: [{ending, p}], movesLeft}}. */
    evaluate(game) {
        return this._send({ type: 'evaluate', state: game.toState() });
    }

    /** Stop the given jobs, or all jobs. Their promises resolve with {cancelled: true} or {stopped: true}. */
    cancel(ids) {
        const list = ids === undefined ? undefined : ids.filter(id => id !== null && id !== undefined);
        if (list && list.length === 0) return;
        this.worker.postMessage({ type: 'cancel', ids: list });
    }
}
