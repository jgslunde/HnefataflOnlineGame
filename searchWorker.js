/**
 * Web Worker that runs the network and the tree search off the main thread, so the page stays
 * responsive without the search having to pause for it.
 *
 * Messages from the page (each with an id; searchClient.js wraps them in promises):
 *   {type: 'load', modelId, url, info}         load an ONNX model and its description
 *   {type: 'search', state, params}            MCTS from a position (TaflGame.toState());
 *       params: {sims (0 = until stopped), cPuct, fpuReduction, discount, progressMs, maxSims}
 *   {type: 'evaluate', state}                  one network call: value, move priors, ending
 *                                              probabilities and plies left
 *   {type: 'cancel', ids}                      stop/drop jobs (all jobs if ids is missing)
 * Replies: {type: 'progress', id, stats}, {type: 'done', id, ...}, {type: 'error', id, message}.
 * Jobs run one at a time in the order received.
 */
'use strict';

const ORT_VERSION = '1.20.1';
const ORT_DIST = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
importScripts(ORT_DIST + 'ort.min.js', 'tafl.js', 'mcts.js', 'network.js');

// Multi-threaded WASM needs cross-origin isolation headers, which GitHub Pages does not send
ort.env.wasm.numThreads = 1;
// In a worker, onnxruntime cannot find its .wasm files from the script tag; point it at the CDN
ort.env.wasm.wasmPaths = ORT_DIST;

let model = null;      // {modelId, session, evaluator}
const queue = [];      // jobs waiting: {msg, stopped}
let running = null;    // the job being worked on
let pumping = false;

self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'cancel') {
        // Model loads are never cancelled; a newer load replaces the model anyway
        const ids = msg.ids ? new Set(msg.ids) : null;
        const matches = (job) => job.msg.type !== 'load' && (!ids || ids.has(job.msg.id));
        for (let i = queue.length - 1; i >= 0; i--) {
            if (matches(queue[i])) {
                self.postMessage({ type: 'done', id: queue[i].msg.id, cancelled: true });
                queue.splice(i, 1);
            }
        }
        if (running && matches(running)) running.stopped = true;
        return;
    }
    queue.push({ msg, stopped: false });
    pump();
};

async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
        running = queue.shift();
        try {
            await handle(running);
        } catch (error) {
            self.postMessage({ type: 'error', id: running.msg.id, message: String(error && error.message || error) });
        }
        running = null;
    }
    pumping = false;
}

function handle(job) {
    switch (job.msg.type) {
        case 'load': return loadModel(job);
        case 'search': return search(job);
        case 'evaluate': return evaluate(job);
        default: throw new Error(`Unknown message type '${job.msg.type}'`);
    }
}

/**
 * A promise that resolves after the worker has handled waiting messages (a MessageChannel post
 * is a macrotask without the 4 ms minimum of nested timers). onnxruntime-web's run() resolves in
 * microtasks only, so without this a running search would never see a 'cancel'.
 */
const yieldChannel = new MessageChannel();
const yieldResolvers = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()();
function yieldToEvents() {
    return new Promise(resolve => {
        yieldResolvers.push(resolve);
        yieldChannel.port2.postMessage(0);
    });
}

async function loadModel(job) {
    const { id, modelId, url, info } = job.msg;
    if (model) {
        try { await model.session.release(); } catch (e) { /* already gone */ }
        model = null;
    }
    const t0 = performance.now();
    const session = await ort.InferenceSession.create(url, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
    });
    const evaluator = new TaflNetwork.NetworkEvaluator(ort, session, info);
    const loadMs = performance.now() - t0;
    // Check the output sizes on the start position and time a few calls
    const game = new Tafl.TaflGame(evaluator.rules);
    await evaluator.run(game);
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) await evaluator.run(game);
    const msPerCall = (performance.now() - t1) / 5;
    evaluator.clearCache();
    model = { modelId, session, evaluator };
    self.postMessage({
        type: 'done', id, modelId, loadMs, msPerCall,
        inputNames: session.inputNames, outputNames: session.outputNames,
    });
}

function requireModel(game) {
    if (!model) throw new Error('No model loaded');
    if (game.N !== model.evaluator.N) {
        throw new Error(`The model is for ${model.evaluator.N}x${model.evaluator.N} boards, the game is ${game.N}x${game.N}`);
    }
    const needed = model.evaluator.historyNeeded;
    if (needed > game.prevBoards.length && game.moveCount > game.prevBoards.length) {
        throw new Error('The game does not keep enough previous positions for this model\'s history planes');
    }
    // Every search node copies the previous boards; keep only those the network looks at
    game.keepBoards = needed;
    game.prevBoards = needed > 0 ? game.prevBoards.slice(-needed) : [];
}

async function search(job) {
    const { id, state, params } = job.msg;
    const game = Tafl.TaflGame.fromState(state);
    requireModel(game);
    const mcts = new TaflMCTS.MCTS(model.evaluator.evaluate, params);
    mcts.reset(game);
    const limit = params.sims > 0 ? params.sims : Infinity;
    const maxSims = params.maxSims > 0 ? params.maxSims : Infinity;
    const progressMs = params.progressMs || 0;
    const t0 = performance.now();
    let lastYield = t0, lastProgress = t0;
    if (!game.gameOver) {
        while (mcts.simulations < limit && mcts.simulations < maxSims && !job.stopped) {
            await mcts.simulate();
            const now = performance.now();
            if (now - lastYield > 15) {
                await yieldToEvents();
                lastYield = performance.now();
            }
            if (progressMs && now - lastProgress >= progressMs && !job.stopped) {
                lastProgress = now;
                self.postMessage({ type: 'progress', id, stats: withTiming(mcts.stats(), t0) });
            }
        }
    }
    self.postMessage({
        type: 'done', id, stopped: job.stopped,
        limitReached: mcts.simulations >= maxSims,
        stats: withTiming(mcts.stats(), t0),
    });
}

function withTiming(stats, t0) {
    stats.ms = performance.now() - t0;
    stats.cacheHits = model.evaluator.cacheHits;
    stats.networkCalls = model.evaluator.calls;
    return stats;
}

async function evaluate(job) {
    const { id, state } = job.msg;
    const game = Tafl.TaflGame.fromState(state);
    requireModel(game);
    if (game.gameOver) {
        const value = game.winner === game.currentPlayer ? 1 : -1;
        self.postMessage({ type: 'done', id, result: { value, children: [], terminal: true, ending: null, movesLeft: 0 } });
        return;
    }
    const moves = game.legalMoves();
    const { priors, value, ending, movesLeft } = await model.evaluator.evaluateAll(game, moves);
    const children = moves.map((move, i) => ({ move, prior: priors[i] }));
    self.postMessage({ type: 'done', id, result: { value, children, terminal: false, ending, movesLeft } });
}
