/**
 * A network model (ONNX) and its description (.json), as evaluation function for the search.
 *
 * The description is the .json file that convert_to_onnx.py in the training code writes next to
 * each .onnx file: board size, input planes in order, policy layout, the rules the network was
 * trained with and the search settings of its training run. Everything model-specific comes from
 * there: the input planes are built from input.planes, never from assumptions.
 *
 * Works with onnxruntime-web in the Web Worker and in Node (tests); the `ort` object is passed in.
 */
(function (root) {
    'use strict';

    const Tafl = typeof module !== 'undefined' && module.exports ? require('./tafl.js') : root.Tafl;
    const { softmaxOver } = typeof module !== 'undefined' && module.exports ? require('./mcts.js') : root.TaflMCTS;

    // Used when a model's .json has no search settings (checkpoints too old to record them):
    // the settings of all current training runs, and no discount
    const DEFAULT_SEARCH = { cPuct: 1.5, fpuReduction: -0.25, discount: 1.0 };

    /** Search settings of a model description, with defaults for missing ones. */
    function modelSearchSettings(info) {
        const s = (info && info.search) || {};
        const value = (x, d) => (x === null || x === undefined ? d : Number(x));
        return {
            cPuct: value(s.c_puct, DEFAULT_SEARCH.cPuct),
            fpuReduction: value(s.fpu_reduction, DEFAULT_SEARCH.fpuReduction),
            discount: value(s.discount, DEFAULT_SEARCH.discount),
        };
    }

    /** Rules a model was trained with (normalized), or null if its description does not say. */
    function modelRules(info) {
        if (!info || !info.rules || info.rules.king_capture_pieces === undefined) return null;
        return Tafl.normalizeRules(info.rules);
    }

    class NetworkEvaluator {
        /**
         * @param {object} ort onnxruntime(-web) module
         * @param {object} session its InferenceSession of the model
         * @param {object} info the model's description (.json)
         * @param {object} options {cacheSize}: positions whose network output is kept (0 = none)
         */
        constructor(ort, session, info, options = {}) {
            this.ort = ort;
            this.session = session;
            this.info = info;
            this.N = info.board_size;
            if (!Tafl.VARIANTS[this.N]) throw new Error(`Unsupported board size ${this.N}`);
            this.planes = Tafl.parsePlanes(info.input.planes);
            if (info.input.shape && info.input.shape[1] !== this.planes.length) {
                throw new Error(`The description lists ${this.planes.length} planes but input.shape says ${info.input.shape[1]}`);
            }
            this.historyNeeded = Tafl.historyNeeded(this.planes);
            this.policySize = this.N * this.N * 4 * (this.N - 1);
            // Old exports use input/policy/value, convert_to_onnx.py board_state/policy_logits/value
            this.inputName = session.inputNames[0];
            const outputs = session.outputNames;
            this.policyName = outputs.find(n => /policy/i.test(n)) || outputs[0];
            this.valueName = outputs.find(n => /value/i.test(n) && n !== this.policyName) ||
                outputs.find(n => n !== this.policyName);
            // The network output depends only on the input planes. Without history planes those
            // depend only on the position key and the (fixed) rules, so outputs can be reused when
            // a position comes up again: in transpositions, and in later searches. This changes
            // nothing in the search, only its speed.
            this.cacheSize = this.historyNeeded === 0 ? (options.cacheSize !== undefined ? options.cacheSize : 50000) : 0;
            this.cache = new Map();
            this.cacheRules = null;
            this.calls = 0;
            this.cacheHits = 0;
            this.networkMs = 0;
            this.evaluate = this.evaluate.bind(this);
        }

        clearCache() {
            this.cache.clear();
        }

        /** Raw network output for a position: {logits (all moves), value}. */
        async run(game) {
            if (game.N !== this.N) throw new Error(`The model is for ${this.N}x${this.N}, the game is ${game.N}x${game.N}`);
            const N = this.N;
            const input = Tafl.buildFeatures(game, this.planes);
            const tensor = new this.ort.Tensor('float32', input, [1, this.planes.length, N, N]);
            const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
            const results = await this.session.run({ [this.inputName]: tensor });
            this.networkMs += (typeof performance !== 'undefined' ? performance : Date).now() - t0;
            this.calls++;
            const logits = results[this.policyName].data;
            if (logits.length !== this.policySize) {
                throw new Error(`Policy output has ${logits.length} entries, expected ${this.policySize}`);
            }
            return { logits, value: results[this.valueName].data[0] };
        }

        /**
         * Evaluation for the search: priors over `moves` (softmax over the legal moves only) and
         * the value for the player to move.
         */
        async evaluate(game, moves) {
            let key = null;
            if (this.cacheSize > 0) {
                // Some planes (throne, reach) depend on the rules: a game with other rules starts afresh
                const r = game.rules;
                const rules = `${r.kingCapturePieces}${+r.kingCanCapture}${+r.throneIsHostile}${+r.throneEnabled}`;
                if (rules !== this.cacheRules) {
                    this.cache.clear();
                    this.cacheRules = rules;
                }
                key = game.positionKey();
                const hit = this.cache.get(key);
                if (hit && sameMoves(hit.moves, moves)) {
                    this.cacheHits++;
                    return { priors: softmaxOver(hit.logits, identity(moves.length)), value: hit.value };
                }
            }
            const { logits, value } = await this.run(game);
            const indices = moves.map(m => Tafl.policyIndex(this.N, m));
            if (key !== null) {
                const legalLogits = new Float32Array(indices.length);
                for (let i = 0; i < indices.length; i++) legalLogits[i] = logits[indices[i]];
                if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value);
                this.cache.set(key, { moves, logits: legalLogits, value });
            }
            return { priors: softmaxOver(logits, indices), value };
        }
    }

    function sameMoves(a, b) {
        if (a === b) return true;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    const identities = [];
    function identity(n) {
        if (!identities[n]) identities[n] = Array.from({ length: n }, (_, i) => i);
        return identities[n];
    }

    const exported = { NetworkEvaluator, modelSearchSettings, modelRules, DEFAULT_SEARCH };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    else root.TaflNetwork = exported;
})(typeof self !== 'undefined' ? self : this);
