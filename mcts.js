/**
 * Monte Carlo tree search guided by a policy/value network (AlphaZero style).
 *
 * A port of mcts.py from the training code (github.com/jgslunde/Games, Hnefatafl_RL/), with its
 * October 2026 fixes:
 * - FPU: an unvisited move is valued at the parent's mean value plus fpu_reduction (negative =
 *   pessimistic). The parent's mean value is already seen by the player choosing the move.
 * - Backup discount: the value is multiplied by -discount at every ply, as the training targets were.
 * - Temperature: visit counts are divided by the largest one before the power 1/T.
 * - With no visits yet (a single simulation), moves are chosen by the network's priors.
 * - Every node holds its own game (a TaflGame) with its own position history, so the repetition
 *   rule inside the tree follows the simulated line, not the real game.
 *
 * Works in the search Web Worker and in Node (tests). The network is behind an `evaluate`
 * function: async (game, legalMoves) => ({priors, value}), with priors over legalMoves (same
 * order) and value in [-1, 1] for the player to move in `game`.
 */
(function (root) {
    'use strict';

    class MCTSNode {
        constructor(game) {
            this.game = game;      // TaflGame of this position
            this.N = 0;            // visit count
            this.W = 0;            // total value, seen by the player to move here
            this.Q = 0;            // mean value W / N
            this.moves = null;     // legal moves (set when the node is expanded)
            this.priors = null;    // network prior of each move
            this.children = null;  // child node of each move, null until the move is first chosen
        }

        get expanded() {
            return this.moves !== null;
        }

        expand(moves, priors) {
            let sum = 0;
            for (let i = 0; i < priors.length; i++) sum += priors[i];
            this.priors = new Float64Array(moves.length);
            for (let i = 0; i < moves.length; i++) this.priors[i] = sum > 0 ? priors[i] / sum : 1 / moves.length;
            this.moves = moves;
            this.children = new Array(moves.length).fill(null);
        }
    }

    class MCTS {
        /**
         * @param {Function} evaluate async (game, legalMoves) => ({priors, value})
         * @param {object} params {cPuct, fpuReduction, discount}; the defaults are those of the
         *        current training runs' evaluation games (discount 1 = none)
         */
        constructor(evaluate, params = {}) {
            this.evaluate = evaluate;
            this.cPuct = params.cPuct !== undefined ? params.cPuct : 1.5;
            this.fpuReduction = params.fpuReduction !== undefined ? params.fpuReduction : -0.25;
            this.discount = params.discount !== undefined ? params.discount : 1.0;
            this.root = null;
            this.simulations = 0;
            this.nodes = 0;
        }

        /** Start a new tree at a position (the game is copied). */
        reset(game) {
            this.root = new MCTSNode(game.clone());
            this.simulations = 0;
            this.nodes = 1;
        }

        /** PUCT selection; creates the child's game the first time a move is chosen. */
        _select(node) {
            const sqrtN = Math.sqrt(node.N);
            const fpuValue = node.Q + this.fpuReduction;
            const { priors, children } = node;
            let best = -Infinity, bestIndex = 0;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const n = child === null ? 0 : child.N;
                // A child's Q is seen by its own player to move, so negate it for this node's player
                const q = n > 0 ? -child.Q : fpuValue;
                const score = q + this.cPuct * priors[i] * sqrtN / (1 + n);
                if (score > best) {
                    best = score;
                    bestIndex = i;
                }
            }
            let child = children[bestIndex];
            if (child === null) {
                const game = node.game.clone();
                game.makeMove(node.moves[bestIndex]);
                child = children[bestIndex] = new MCTSNode(game);
                this.nodes++;
            }
            return child;
        }

        /** One simulation: select down to a leaf, evaluate and expand it, back the value up. */
        async simulate() {
            let node = this.root;
            const path = [node];
            while (node.expanded && !node.game.gameOver) {
                node = this._select(node);
                path.push(node);
            }

            let value;
            const game = node.game;
            if (game.gameOver) {
                value = game.winner === game.currentPlayer ? 1 : (game.winner === 1 - game.currentPlayer ? -1 : 0);
            } else {
                const moves = game.legalMoves();
                const result = await this.evaluate(game, moves);
                value = result.value;
                node.expand(moves, result.priors);
            }

            for (let i = path.length - 1; i >= 0; i--) {
                const n = path[i];
                n.N++;
                n.W += value;
                n.Q = n.W / n.N;
                value = -value * this.discount;
            }
            this.simulations++;
        }

        /** Value of the root position for the player to move there. */
        rootValue() {
            const root = this.root;
            if (root.game.gameOver) {
                return root.game.winner === root.game.currentPlayer ? 1 : (root.game.winner === null ? 0 : -1);
            }
            return root.Q;
        }

        /**
         * Search statistics of the root: per legal move its visits, its value for the player to
         * move at the root (null if unvisited) and its prior. Also the most visited line.
         */
        stats() {
            const root = this.root;
            const children = [];
            if (root.expanded) {
                for (let i = 0; i < root.moves.length; i++) {
                    const child = root.children[i];
                    children.push({
                        move: root.moves[i],
                        visits: child ? child.N : 0,
                        q: child && child.N > 0 ? -child.Q : null,
                        prior: root.priors[i],
                    });
                }
            }
            const pv = [];
            for (let node = root; node && node.expanded && pv.length < 12;) {
                let best = -1, bestN = 0;
                for (let i = 0; i < node.children.length; i++) {
                    const c = node.children[i];
                    if (c && c.N > bestN) { bestN = c.N; best = i; }
                }
                if (best < 0) break;
                pv.push(node.moves[best]);
                node = node.children[best];
            }
            return {
                visits: root.N,
                value: this.rootValue(),
                terminal: root.game.gameOver,
                simulations: this.simulations,
                nodes: this.nodes,
                children,
                pv,
            };
        }
    }

    /**
     * Choose a move from root statistics (stats().children), as mcts.py's select_move: the most
     * visited at temperature 0, else sampled with probability proportional to
     * (visits / max visits) ^ (1 / temperature). Without any visits the network priors are used.
     * Returns a move, or null if there are none.
     */
    function chooseMove(children, temperature = 0, random = Math.random) {
        if (!children || children.length === 0) return null;
        let weights = children.map(c => c.visits);
        if (weights.every(w => w === 0)) weights = children.map(c => c.prior);
        if (temperature <= 0) {
            let best = 0;
            for (let i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
            return children[best].move;
        }
        const max = Math.max(...weights);
        const scaled = weights.map(w => Math.pow(w / max, 1 / temperature));
        const sum = scaled.reduce((a, b) => a + b, 0);
        let r = random() * sum;
        for (let i = 0; i < scaled.length; i++) {
            r -= scaled[i];
            if (r < 0) return children[i].move;
        }
        return children[children.length - 1].move;
    }

    /** Softmax of the logits of some moves (the network output is logits over all moves). */
    function softmaxOver(logits, indices) {
        const out = new Float64Array(indices.length);
        let max = -Infinity;
        for (let i = 0; i < indices.length; i++) max = Math.max(max, logits[indices[i]]);
        let sum = 0;
        for (let i = 0; i < indices.length; i++) {
            out[i] = Math.exp(logits[indices[i]] - max);
            sum += out[i];
        }
        for (let i = 0; i < indices.length; i++) out[i] /= sum;
        return out;
    }

    const exported = { MCTS, MCTSNode, chooseMove, softmaxOver };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    else root.TaflMCTS = exported;
})(typeof self !== 'undefined' ? self : this);
