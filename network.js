/**
 * A network model (ONNX) and its description (.json), as evaluation function for the search.
 *
 * The description is the .json file that convert_to_onnx.py in the training code writes next to
 * each .onnx file: board size, input planes in order, policy layout, the rule set the network was
 * trained with (ruleset, and all its fields in rules) and the search settings of its training run.
 * Everything model-specific comes from there: the input planes are built from input.planes, never
 * from assumptions.
 *
 * A model has four outputs (read by name): policy_logits and value, which the search uses, and
 * ending_logits (how the game will end, over Tafl.ENDINGS) and moves_left (plies until the end),
 * which the page only shows. Models from before the last two outputs (descriptions without an
 * ending key) and from before the named rule sets (without a ruleset key) are deprecated and refused.
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

    // The outputs of convert_to_onnx.py, in order
    const OUTPUT_NAMES = ['policy_logits', 'value', 'ending_logits', 'moves_left'];

    /**
     * The rule set a model was trained with, from its description. Throws for a deprecated model:
     * one without a named rule set, or without the ending and moves-left outputs.
     */
    function modelRules(info) {
        if (!info || !info.ruleset || !info.rules) {
            throw new Error('the model description names no rule set (a model trained before the named rule sets)');
        }
        if (!info.ending) {
            throw new Error('the model has no ending and moves-left outputs (a deprecated model)');
        }
        return Tafl.normalizeRules(info.rules);
    }

    /**
     * The probability of each ending the rules allow, from the ending logits: a softmax over those
     * endings only, as in training. Returns [{ending, p}] in the order of Tafl.ENDINGS.
     */
    function endingProbabilities(logits, rules) {
        const allowed = Tafl.endings(rules);
        const values = allowed.map(e => logits[Tafl.ENDINGS.indexOf(e)]);
        const max = Math.max(...values);
        const exps = values.map(v => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        return allowed.map((ending, i) => ({ ending, p: exps[i] / sum }));
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
            this.rules = modelRules(info);
            if (this.rules.board_size !== this.N) throw new Error('board_size and the rules\' setup disagree');
            this.planes = Tafl.parsePlanes(info.input.planes);
            if (info.input.shape && info.input.shape[1] !== this.planes.length) {
                throw new Error(`The description lists ${this.planes.length} planes but input.shape says ${info.input.shape[1]}`);
            }
            this.historyNeeded = Tafl.historyNeeded(this.planes);
            this.policySize = this.N * this.N * 4 * (this.N - 1);
            this.inputName = session.inputNames[0];
            const outputs = session.outputNames;
            if (outputs.length < OUTPUT_NAMES.length) {
                throw new Error(`The model has ${outputs.length} outputs, expected ${OUTPUT_NAMES.join(', ')}`);
            }
            // By name, or else by position
            [this.policyName, this.valueName, this.endingName, this.movesLeftName] =
                OUTPUT_NAMES.map((name, i) => (outputs.includes(name) ? name : outputs[i]));
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

        /**
         * Raw network output for a position: {logits (all moves), value, ending (logits over
         * Tafl.ENDINGS), movesLeft (plies)}.
         */
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
            const ending = results[this.endingName].data;
            if (ending.length !== Tafl.ENDINGS.length) {
                throw new Error(`Ending output has ${ending.length} entries, expected ${Tafl.ENDINGS.length}`);
            }
            return { logits, value: results[this.valueName].data[0], ending, movesLeft: results[this.movesLeftName].data[0] };
        }

        /**
         * Everything the network says about a position, for the page: priors over `moves`, the
         * value, the probabilities of the endings the rules allow, and the plies left.
         */
        async evaluateAll(game, moves) {
            const { logits, value, ending, movesLeft } = await this.run(game);
            const priors = softmaxOver(logits, moves.map(m => Tafl.policyIndex(this.N, m)));
            return { priors, value, ending: endingProbabilities(ending, game.rules), movesLeft };
        }

        /**
         * Evaluation for the search: priors over `moves` (softmax over the legal moves only) and
         * the value for the player to move.
         */
        async evaluate(game, moves) {
            let key = null;
            if (this.cacheSize > 0) {
                // Some planes (corners, throne, reach) and the legal moves depend on the rules: a game
                // with other rules starts afresh
                const rules = Tafl.rulesKey(game.rules);
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

    const exported = { NetworkEvaluator, modelSearchSettings, modelRules, endingProbabilities, OUTPUT_NAMES, DEFAULT_SEARCH };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    else root.TaflNetwork = exported;
})(typeof self !== 'undefined' ? self : this);
