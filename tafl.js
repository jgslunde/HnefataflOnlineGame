/**
 * Tafl rules engine: Brandubh (7x7), Tablut (9x9) and Hnefatafl (11x11).
 *
 * A port of brandubh.py, tablut.py, hnefatafl.py and features.py from the training code
 * (github.com/jgslunde/Games, folder Hnefatafl_RL/). A network only knows the game as those engines
 * play it, so every rule here follows the Python code, including the rule switches and their
 * per-variant differences. Where this file and the Python code disagree, the Python code is right;
 * tests/test_engine.js replays reference games written by the Python engines.
 *
 * Board: an Int8Array of N*N squares in row-major order, with the Python piece codes
 * 0 empty, 1 attacker, 2 defender, 3 king. Players: 0 attackers (they move first), 1 defenders.
 * A move is a packed integer (from << 8) | to, with squares numbered row * N + col.
 *
 * Runs in the page, in the search Web Worker and in Node (tests).
 */
(function (root) {
    'use strict';

    const EMPTY = 0, ATTACKER = 1, DEFENDER = 2, KING = 3;
    const ATTACKER_PLAYER = 0, DEFENDER_PLAYER = 1;

    // Directions in the order of the Python engines (and of the policy index): up, down, left, right
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    /**
     * The game variants, one per board size. Start positions are copied from _setup_board() of the
     * Python classes; the king always starts on the centre square.
     *
     * throneHostileToAttackers: in tablut.py and hnefatafl.py the empty throne is always hostile to
     * attackers and throne_is_hostile only adds defenders and the king. In brandubh.py
     * throne_is_hostile=False makes the empty throne hostile to nobody. The Python code differs
     * here on purpose or by accident; we match it per variant and do not harmonise it.
     */
    const VARIANTS = {
        7: {
            id: 'brandubh', name: 'Brandubh', size: 7,
            defenders: [[2, 3], [3, 2], [3, 4], [4, 3]],
            attackers: [[0, 3], [3, 6], [6, 3], [3, 0], [1, 3], [3, 1], [3, 5], [5, 3]],
            throneHostileToAttackers: false,
            encirclement: false,
            maxGameLength: 100,
        },
        9: {
            id: 'tablut', name: 'Tablut', size: 9,
            defenders: [[3, 4], [4, 3], [4, 5], [5, 4], [2, 4], [4, 2], [4, 6], [6, 4]],
            attackers: [
                [0, 3], [0, 4], [0, 5], [1, 4],
                [3, 8], [4, 8], [5, 8], [4, 7],
                [8, 3], [8, 4], [8, 5], [7, 4],
                [3, 0], [4, 0], [5, 0], [4, 1],
            ],
            throneHostileToAttackers: true,
            encirclement: false,
            maxGameLength: 200,
        },
        11: {
            id: 'hnefatafl', name: 'Hnefatafl', size: 11,
            defenders: [
                [4, 5], [5, 4], [5, 6], [6, 5],
                [3, 5], [5, 3], [5, 7], [7, 5],
                [4, 4], [4, 6], [6, 4], [6, 6],
            ],
            attackers: [
                [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [1, 5],
                [3, 10], [4, 10], [5, 10], [6, 10], [7, 10], [5, 9],
                [10, 3], [10, 4], [10, 5], [10, 6], [10, 7], [9, 5],
                [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [5, 1],
            ],
            throneHostileToAttackers: true,
            // Attackers also win when no 4-connected path of non-attacker squares leads from the king
            // to the edge (Hnefatafl._is_king_encircled)
            encirclement: true,
            maxGameLength: 300,
        },
    };

    // The constructor defaults of the Python game classes
    const PYTHON_DEFAULT_RULES = { kingCapturePieces: 2, kingCanCapture: true, throneIsHostile: false, throneEnabled: true };

    /**
     * Rules as {kingCapturePieces, kingCanCapture, throneIsHostile, throneEnabled}. Accepts these
     * names or the Python ones (king_capture_pieces, ...) as written in a model's .json file.
     */
    function normalizeRules(rules) {
        rules = rules || {};
        const pick = (camel, snake) => (rules[camel] !== undefined ? rules[camel]
            : rules[snake] !== undefined ? rules[snake] : PYTHON_DEFAULT_RULES[camel]);
        const kingCapturePieces = Number(pick('kingCapturePieces', 'king_capture_pieces'));
        if (![2, 3, 4].includes(kingCapturePieces)) {
            throw new Error(`king_capture_pieces must be 2, 3 or 4, not ${kingCapturePieces}`);
        }
        return Object.freeze({
            kingCapturePieces,
            kingCanCapture: Boolean(pick('kingCanCapture', 'king_can_capture')),
            throneIsHostile: Boolean(pick('throneIsHostile', 'throne_is_hostile')),
            throneEnabled: Boolean(pick('throneEnabled', 'throne_enabled')),
        });
    }

    function rulesEqual(a, b) {
        a = normalizeRules(a);
        b = normalizeRules(b);
        return a.kingCapturePieces === b.kingCapturePieces && a.kingCanCapture === b.kingCanCapture &&
            a.throneIsHostile === b.throneIsHostile && a.throneEnabled === b.throneEnabled;
    }

    // ------------------------------------------------------------------------------------------
    // Board geometry and Zobrist keys (per board size, built once)
    // ------------------------------------------------------------------------------------------

    function mulberry32(seed) {
        return function () {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return (t ^ (t >>> 14)) >>> 0;
        };
    }

    const geometries = {};

    /**
     * Corner and throne squares of a board size, and the Zobrist keys of its positions. A position
     * key is a 53-bit integer: 21 bits from zHi and 32 from zLo. Two different positions share a key
     * with probability about 2^-53, far below anything a game or a search can reach.
     */
    function geometry(N) {
        if (geometries[N]) return geometries[N];
        const NN = N * N;
        const corners = [0, N - 1, N * (N - 1), NN - 1];
        const isCorner = new Uint8Array(NN);
        for (const sq of corners) isCorner[sq] = 1;
        const rand = mulberry32(0x7AF1 + N);
        const zHi = new Int32Array(NN * 4), zLo = new Int32Array(NN * 4);
        for (let i = 0; i < NN * 4; i++) {
            zHi[i] = rand() & 0x1FFFFF;
            zLo[i] = rand() | 0;
        }
        const isEdge = new Uint8Array(NN);
        for (let sq = 0; sq < NN; sq++) {
            const r = (sq / N) | 0, c = sq % N;
            isEdge[sq] = (r === 0 || r === N - 1 || c === 0 || c === N - 1) ? 1 : 0;
        }
        geometries[N] = {
            N, NN, corners, isCorner, isEdge,
            throne: (NN - 1) / 2,
            zHi, zLo,
            playerHi: rand() & 0x1FFFFF,
            playerLo: rand() | 0,
        };
        return geometries[N];
    }

    // ------------------------------------------------------------------------------------------
    // Moves
    // ------------------------------------------------------------------------------------------

    const encodeMove = (from, to) => (from << 8) | to;
    const moveFrom = (move) => move >> 8;
    const moveTo = (move) => move & 255;

    /**
     * Index of a move in the network's policy output:
     * from_square * 4(N-1) + direction * (N-1) + (distance - 1), directions 0 up, 1 down, 2 left, 3 right.
     */
    function policyIndex(N, move) {
        const from = move >> 8, to = move & 255;
        const fr = (from / N) | 0, fc = from % N, tr = (to / N) | 0, tc = to % N;
        let direction, distance;
        if (tr !== fr) {
            direction = tr < fr ? 0 : 1;
            distance = Math.abs(tr - fr);
        } else {
            direction = tc < fc ? 2 : 3;
            distance = Math.abs(tc - fc);
        }
        return from * 4 * (N - 1) + direction * (N - 1) + (distance - 1);
    }

    /** Square name for display: column letter and row number counted from the bottom, as on a chess board. */
    function squareName(N, sq) {
        return String.fromCharCode(97 + (sq % N)) + (N - Math.floor(sq / N));
    }

    function moveName(N, move) {
        return squareName(N, move >> 8) + '-' + squareName(N, move & 255);
    }

    // ------------------------------------------------------------------------------------------
    // The game
    // ------------------------------------------------------------------------------------------

    class TaflGame {
        /**
         * A new game in the start position, attackers to move.
         * @param {number} size 7, 9 or 11
         * @param {object} rules see normalizeRules (defaults: those of the Python constructors)
         */
        constructor(size = 7, rules = {}) {
            const variant = VARIANTS[size];
            if (!variant) throw new Error(`No Tafl variant with a ${size}x${size} board`);
            this.N = size;
            this.variant = variant;
            this.geo = geometry(size);
            this.rules = normalizeRules(rules);
            this.board = new Int8Array(size * size);
            this.currentPlayer = ATTACKER_PLAYER;
            this.gameOver = false;
            this.winner = null;
            this.moveCount = 0;
            // Keys of the positions since the last capture, oldest first, the current one last. A
            // capture removes pieces for good, so no earlier position can occur again; for the
            // repetition rule these are all the positions that matter.
            this.repKeys = [];
            this.repHasDuplicate = false;
            // Boards of the previous positions, oldest first (for history input planes), at most
            // keepBoards of them
            this.prevBoards = [];
            this.keepBoards = 0;
            this._legal = null;
            this._setupBoard();
            this._recordPosition(true);
        }

        _setupBoard() {
            const N = this.N, v = this.variant;
            this.board[this.geo.throne] = KING;
            for (const [r, c] of v.defenders) this.board[r * N + c] = DEFENDER;
            for (const [r, c] of v.attackers) this.board[r * N + c] = ATTACKER;
            this._computeHash();
        }

        _computeHash() {
            const { zHi, zLo } = this.geo;
            let hi = 0, lo = 0;
            for (let sq = 0; sq < this.board.length; sq++) {
                const p = this.board[sq];
                if (p !== EMPTY) {
                    hi ^= zHi[sq * 4 + p];
                    lo ^= zLo[sq * 4 + p];
                }
            }
            if (this.currentPlayer === DEFENDER_PLAYER) {
                hi ^= this.geo.playerHi;
                lo ^= this.geo.playerLo;
            }
            this.hashHi = hi;
            this.hashLo = lo;
        }

        /** Key of the position (board and player to move), as used by the repetition rule. */
        positionKey() {
            return this.hashHi * 4294967296 + (this.hashLo >>> 0);
        }

        _recordPosition(reset) {
            const key = this.positionKey();
            if (reset) {
                this.repKeys = [key];
                this.repHasDuplicate = false;
            } else {
                if (!this.repHasDuplicate && this.repKeys.includes(key)) this.repHasDuplicate = true;
                this.repKeys.push(key);
            }
        }

        /** How often the current position has occurred (1 the first time). */
        repetitionCount() {
            const key = this.positionKey();
            let count = 0;
            for (const k of this.repKeys) if (k === key) count++;
            return count;
        }

        clone() {
            const g = Object.create(TaflGame.prototype);
            g.N = this.N;
            g.variant = this.variant;
            g.geo = this.geo;
            g.rules = this.rules;
            g.board = this.board.slice();
            g.currentPlayer = this.currentPlayer;
            g.gameOver = this.gameOver;
            g.winner = this.winner;
            g.moveCount = this.moveCount;
            g.hashHi = this.hashHi;
            g.hashLo = this.hashLo;
            g.repKeys = this.repKeys.slice();
            g.repHasDuplicate = this.repHasDuplicate;
            g.prevBoards = this.prevBoards.slice();  // the stored boards are never changed
            g.keepBoards = this.keepBoards;
            g._legal = this._legal;                 // never changed in place either
            return g;
        }

        /** A plain object that survives postMessage; TaflGame.fromState rebuilds the game. */
        toState() {
            return {
                size: this.N,
                rules: { ...this.rules },
                board: this.board.slice(),
                currentPlayer: this.currentPlayer,
                gameOver: this.gameOver,
                winner: this.winner,
                moveCount: this.moveCount,
                repKeys: this.repKeys.slice(),
                prevBoards: this.prevBoards.map(b => b.slice()),
                keepBoards: this.keepBoards,
            };
        }

        static fromState(state) {
            const g = new TaflGame(state.size, state.rules);
            g.board = Int8Array.from(state.board);
            g.currentPlayer = state.currentPlayer;
            g.gameOver = Boolean(state.gameOver);
            g.winner = state.winner === undefined ? null : state.winner;
            g.moveCount = state.moveCount || 0;
            g._computeHash();
            g.repKeys = state.repKeys && state.repKeys.length ? state.repKeys.slice() : [g.positionKey()];
            g.repHasDuplicate = new Set(g.repKeys).size < g.repKeys.length;
            g.prevBoards = (state.prevBoards || []).map(b => Int8Array.from(b));
            g.keepBoards = state.keepBoards || 0;
            g._legal = null;
            return g;
        }

        /**
         * A game in a given position, without history (as if it were the start position). For tests
         * and set-up positions. board: N*N piece codes, flat or as rows.
         */
        static fromBoard(size, rules, board, currentPlayer = ATTACKER_PLAYER) {
            const g = new TaflGame(size, rules);
            g.board = Int8Array.from(Array.isArray(board[0]) ? board.flat() : board);
            g.currentPlayer = currentPlayer;
            g._computeHash();
            g._recordPosition(true);
            g._legal = null;
            return g;
        }

        kingSquare() {
            return this.board.indexOf(KING);
        }

        isOwnPiece(sq, player = this.currentPlayer) {
            const p = this.board[sq];
            return player === ATTACKER_PLAYER ? p === ATTACKER : (p === DEFENDER || p === KING);
        }

        // --------------------------------------------------------------------------------------
        // Move generation (Python: get_legal_moves, _get_piece_moves, _would_cause_repetition)
        // --------------------------------------------------------------------------------------

        /**
         * All legal moves of the player to move, in the order of the Python engines (squares in
         * row-major order; per piece up, down, left, right; nearest square first). Moves that
         * would create a position for the third time are left out. The returned array is cached
         * and shared: do not change it.
         */
        legalMoves() {
            if (this._legal === null) this._legal = this._generateMoves();
            return this._legal;
        }

        isLegalMove(move) {
            return this.legalMoves().includes(move);
        }

        /** Legal moves of the piece on a square (empty unless it belongs to the player to move). */
        legalMovesFrom(sq) {
            return this.legalMoves().filter(m => (m >> 8) === sq);
        }

        /** Whether a move is illegal only because it would create a position for the third time. */
        isBlockedByRepetition(move) {
            if (!this.repHasDuplicate || this.isLegalMove(move)) return false;
            const g = this.clone();
            g.repHasDuplicate = false;
            g._legal = null;
            return g.legalMoves().includes(move);
        }

        _generateMoves() {
            const N = this.N, b = this.board, NN = N * N;
            const { isCorner, throne } = this.geo;
            const throneOn = this.rules.throneEnabled;
            const attackersMove = this.currentPlayer === ATTACKER_PLAYER;
            // A move can only give a third occurrence if some position has occurred twice already
            const checkRepetition = this.repHasDuplicate;
            const moves = [];
            for (let sq = 0; sq < NN; sq++) {
                const p = b[sq];
                if (attackersMove ? p !== ATTACKER : (p !== DEFENDER && p !== KING)) continue;
                const isKing = p === KING;
                const r = (sq / N) | 0, c = sq % N;
                for (let d = 0; d < 4; d++) {
                    const dr = DIRS[d][0], dc = DIRS[d][1];
                    let nr = r + dr, nc = c + dc;
                    while (nr >= 0 && nr < N && nc >= 0 && nc < N) {
                        const t = nr * N + nc;
                        if (b[t] !== EMPTY) break;
                        // Only the king may enter a corner (a corner is at the end of its line)
                        if (isCorner[t] && !isKing) break;
                        // Only the king may stop on the throne; others may pass over it when it is empty
                        if (throneOn && t === throne && !isKing) {
                            nr += dr;
                            nc += dc;
                            continue;
                        }
                        if (!checkRepetition || !this._wouldRepeat(sq, t, p)) moves.push((sq << 8) | t);
                        nr += dr;
                        nc += dc;
                    }
                }
            }
            return moves;
        }

        /**
         * Whether moving piece p from `from` to `to` would give a position that has occurred twice
         * already. As in Python, the position after the move is first compared without captures; a
         * capturing move never repeats a position, because pieces are never added.
         */
        _wouldRepeat(from, to, p) {
            const { zHi, zLo, playerHi, playerLo } = this.geo;
            const hi = this.hashHi ^ zHi[from * 4 + p] ^ zHi[to * 4 + p] ^ playerHi;
            const lo = this.hashLo ^ zLo[from * 4 + p] ^ zLo[to * 4 + p] ^ playerLo;
            const key = hi * 4294967296 + (lo >>> 0);
            let count = 0;
            for (const k of this.repKeys) if (k === key) count++;
            if (count < 2) return false;
            const b = this.board;
            b[from] = EMPTY;
            b[to] = p;
            const captures = this._captureTargets(to);
            b[to] = EMPTY;
            b[from] = p;
            return captures.length === 0;
        }

        // --------------------------------------------------------------------------------------
        // Making a move (Python: make_move, _check_captures, _check_game_over)
        // --------------------------------------------------------------------------------------

        /**
         * Make a move (it must be legal; see isLegalMove). Returns the captured squares, or null if
         * the game is already over.
         */
        makeMove(move) {
            if (this.gameOver) return null;
            const from = move >> 8, to = move & 255;
            const b = this.board;
            const p = b[from];
            if (this.keepBoards > 0) {
                this.prevBoards.push(b.slice());
                if (this.prevBoards.length > this.keepBoards) this.prevBoards.shift();
            }
            const { zHi, zLo } = this.geo;
            b[from] = EMPTY;
            b[to] = p;
            this.hashHi ^= zHi[from * 4 + p] ^ zHi[to * 4 + p];
            this.hashLo ^= zLo[from * 4 + p] ^ zLo[to * 4 + p];
            this.moveCount++;

            const captured = this._captureTargets(to);
            for (const sq of captured) {
                const q = b[sq];
                if (q === KING) {
                    this.gameOver = true;
                    this.winner = ATTACKER_PLAYER;
                }
                this.hashHi ^= zHi[sq * 4 + q];
                this.hashLo ^= zLo[sq * 4 + q];
                b[sq] = EMPTY;
            }

            this.currentPlayer = 1 - this.currentPlayer;
            this.hashHi ^= this.geo.playerHi;
            this.hashLo ^= this.geo.playerLo;
            this._legal = null;
            this._recordPosition(captured.length > 0);
            this._checkGameOver();
            return captured;
        }

        static _friendly(p1, p2) {
            if (p1 === EMPTY || p2 === EMPTY) return false;
            return (p1 === ATTACKER) === (p2 === ATTACKER);
        }

        /**
         * The squares whose pieces the piece that just moved to `to` captures (custodian captures;
         * the king by the king_capture_pieces rule). The board is not changed. The Python code
         * removes captured pieces one direction at a time; the four directions look at disjoint
         * squares, so collecting first and removing afterwards gives the same result.
         */
        _captureTargets(to) {
            const N = this.N, b = this.board;
            const piece = b[to];
            const out = [];
            // A king that may not capture never captures when it moves
            if (piece === KING && !this.rules.kingCanCapture) return out;
            const r = (to / N) | 0, c = to % N;
            for (let d = 0; d < 4; d++) {
                const dr = DIRS[d][0], dc = DIRS[d][1];
                const nr = r + dr, nc = c + dc;
                if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
                const n = nr * N + nc;
                const enemy = b[n];
                if (enemy === EMPTY || TaflGame._friendly(piece, enemy)) continue;
                const nr2 = nr + dr, nc2 = nc + dc;
                const inside2 = nr2 >= 0 && nr2 < N && nc2 >= 0 && nc2 < N;
                const n2 = nr2 * N + nc2;
                if (enemy === KING) {
                    if (this.rules.kingCapturePieces === 2) {
                        // Sandwich completed in this direction
                        if (inside2 && (b[n2] === ATTACKER || this._isHostile(n2, KING))) out.push(n);
                    } else if (this._isKingCaptured(n)) {
                        out.push(n);
                    }
                } else {
                    if (!inside2) continue;
                    const opposite = b[n2];
                    // A king that may not capture is not the second capturing piece either
                    const friendlyAnvil = TaflGame._friendly(piece, opposite) &&
                        (opposite !== KING || this.rules.kingCanCapture);
                    if (friendlyAnvil || this._isHostile(n2, enemy)) out.push(n);
                }
            }
            return out;
        }

        /**
         * Whether a square counts as an enemy of the piece type `target` in a capture. Corners
         * always do; an occupied throne never does; the empty throne depends on the variant (see
         * VARIANTS) and throne_is_hostile.
         */
        _isHostile(sq, target) {
            if (this.geo.isCorner[sq]) return true;
            if (this.rules.throneEnabled && sq === this.geo.throne) {
                if (this.board[sq] !== EMPTY) return false;
                if (this.variant.throneHostileToAttackers && target === ATTACKER) return true;
                return this.rules.throneIsHostile;
            }
            return false;
        }

        /** Whether the king on square k is captured under king_capture_pieces (Python: _is_king_captured). */
        _isKingCaptured(k) {
            const N = this.N, b = this.board;
            const r = (k / N) | 0, c = k % N;
            const hostile = (sq) => b[sq] === ATTACKER || this._isHostile(sq, KING);
            const kcp = this.rules.kingCapturePieces;
            if (kcp === 2) {
                if (c > 0 && c < N - 1 && hostile(k - 1) && hostile(k + 1)) return true;
                if (r > 0 && r < N - 1 && hostile(k - N) && hostile(k + N)) return true;
                return false;
            }
            if (kcp === 3) {
                // Three of the sides on the board
                let count = 0;
                for (const [dr, dc] of DIRS) {
                    const nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < N && nc >= 0 && nc < N && hostile(nr * N + nc)) count++;
                }
                return count >= 3;
            }
            // All four sides; the board edge counts as a hostile side
            for (const [dr, dc] of DIRS) {
                const nr = r + dr, nc = c + dc;
                if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
                if (!hostile(nr * N + nc)) return false;
            }
            return true;
        }

        /** Whether no 4-connected path of non-attacker squares leads from the king to the edge. */
        isKingEncircled() {
            const king = this.kingSquare();
            if (king < 0) return false;
            const region = kingRegion(this);
            for (let sq = 0; sq < region.length; sq++) if (region[sq] && this.geo.isEdge[sq]) return false;
            return true;
        }

        _checkGameOver() {
            const b = this.board;
            for (const corner of this.geo.corners) {
                if (b[corner] === KING) {
                    this.gameOver = true;
                    this.winner = DEFENDER_PLAYER;
                    return;
                }
            }
            if (this.kingSquare() < 0) {
                this.gameOver = true;
                this.winner = ATTACKER_PLAYER;
                return;
            }
            if (this.variant.encirclement && this.isKingEncircled()) {
                this.gameOver = true;
                this.winner = ATTACKER_PLAYER;
                return;
            }
            // No legal moves (also when only repeating moves are left): the player to move loses
            if (this.legalMoves().length === 0) {
                this.gameOver = true;
                this.winner = 1 - this.currentPlayer;
            }
        }

        /** Why the game ended: 'escape', 'capture', 'encirclement', 'no-moves', or null. */
        endReason() {
            if (!this.gameOver) return null;
            const b = this.board;
            if (this.geo.corners.some(sq => b[sq] === KING)) return 'escape';
            if (this.kingSquare() < 0) return 'capture';
            if (this.variant.encirclement && this.isKingEncircled()) return 'encirclement';
            return 'no-moves';
        }

        /** Number of pieces of a kind on the board. */
        count(piece) {
            let n = 0;
            for (let sq = 0; sq < this.board.length; sq++) if (this.board[sq] === piece) n++;
            return n;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Network input planes (features.py)
    // ------------------------------------------------------------------------------------------

    /**
     * Squares connected to the king through squares without an attacker (4-connected, the king's
     * square included). All zero when there is no king. Python: features.king_region_plane and
     * Hnefatafl._is_king_encircled.
     */
    function kingRegion(game) {
        const N = game.N, b = game.board;
        const region = new Uint8Array(N * N);
        const king = b.indexOf(KING);
        if (king < 0) return region;
        const stack = [king];
        region[king] = 1;
        while (stack.length) {
            const sq = stack.pop();
            const r = (sq / N) | 0, c = sq % N;
            if (r > 0 && !region[sq - N] && b[sq - N] !== ATTACKER) { region[sq - N] = 1; stack.push(sq - N); }
            if (r < N - 1 && !region[sq + N] && b[sq + N] !== ATTACKER) { region[sq + N] = 1; stack.push(sq + N); }
            if (c > 0 && !region[sq - 1] && b[sq - 1] !== ATTACKER) { region[sq - 1] = 1; stack.push(sq - 1); }
            if (c < N - 1 && !region[sq + 1] && b[sq + 1] !== ATTACKER) { region[sq + 1] = 1; stack.push(sq + 1); }
        }
        return region;
    }

    /**
     * [reach_attackers, reach_defenders, reach_king]: the squares each side could move to now, for
     * both sides whatever the turn, ignoring the repetition rule. reach_defenders includes the
     * king's squares. Python: features.reach_planes (equal to the engines' _get_piece_moves).
     */
    function reachPlanes(game) {
        const N = game.N, b = game.board, NN = N * N;
        const { isCorner, throne } = game.geo;
        const throneOn = game.rules.throneEnabled;
        const attackers = new Uint8Array(NN), defenders = new Uint8Array(NN), king = new Uint8Array(NN);
        for (let sq = 0; sq < NN; sq++) {
            const p = b[sq];
            if (p === EMPTY) continue;
            const isKing = p === KING;
            const r = (sq / N) | 0, c = sq % N;
            for (let d = 0; d < 4; d++) {
                const dr = DIRS[d][0], dc = DIRS[d][1];
                let nr = r + dr, nc = c + dc;
                while (nr >= 0 && nr < N && nc >= 0 && nc < N) {
                    const t = nr * N + nc;
                    if (b[t] !== EMPTY) break;
                    if (isCorner[t] && !isKing) break;
                    if (!(throneOn && t === throne && !isKing)) {
                        if (p === ATTACKER) attackers[t] = 1;
                        else if (p === DEFENDER) defenders[t] = 1;
                        else { king[t] = 1; defenders[t] = 1; }
                    }
                    nr += dr;
                    nc += dc;
                }
            }
        }
        return { attackers, defenders, king };
    }

    const PIECE_CODES = { attackers: ATTACKER, defenders: DEFENDER, king: KING };
    const SIMPLE_PLANES = new Set(['player', 'ones', 'corners', 'throne', 'reach_attackers',
        'reach_defenders', 'reach_king', 'king_region']);

    /**
     * Parse the plane names of a model description (input.planes in its .json, from
     * FeatureSpec.plane_names()). Throws on a plane this code does not know, so a model with a
     * new kind of input fails loudly instead of playing with wrong input.
     */
    function parsePlanes(names) {
        return names.map(name => {
            const m = /^(attackers|defenders|king)_t(\d+)$/.exec(name);
            if (m) return { kind: m[1], t: Number(m[2]), name };
            if (SIMPLE_PLANES.has(name)) return { kind: name, t: 0, name };
            throw new Error(`Unknown input plane '${name}'`);
        });
    }

    /** The number of previous boards the planes need (history_length - 1). */
    function historyNeeded(planes) {
        return planes.reduce((m, p) => Math.max(m, p.t), 0);
    }

    /**
     * The network input of a position: a Float32Array of planes.length * N * N values, 0 or 1, in
     * the order of `planes` (from parsePlanes). History planes need game.prevBoards; before the
     * start of the game they are zero.
     */
    function buildFeatures(game, planes, out) {
        const N = game.N, NN = N * N, b = game.board;
        out = out || new Float32Array(planes.length * NN);
        let reach = null, region = null;
        planes.forEach((plane, i) => {
            const off = i * NN;
            switch (plane.kind) {
                case 'attackers':
                case 'defenders':
                case 'king': {
                    const board = plane.t === 0 ? b : game.prevBoards[game.prevBoards.length - plane.t];
                    if (!board) break;
                    const code = PIECE_CODES[plane.kind];
                    for (let sq = 0; sq < NN; sq++) if (board[sq] === code) out[off + sq] = 1;
                    break;
                }
                case 'player':
                    if (game.currentPlayer === DEFENDER_PLAYER) out.fill(1, off, off + NN);
                    break;
                case 'ones':
                    out.fill(1, off, off + NN);
                    break;
                case 'corners':
                    for (const sq of game.geo.corners) out[off + sq] = 1;
                    break;
                case 'throne':
                    if (game.rules.throneEnabled) out[off + game.geo.throne] = 1;
                    break;
                case 'reach_attackers':
                case 'reach_defenders':
                case 'reach_king': {
                    reach = reach || reachPlanes(game);
                    const src = reach[plane.kind.slice(6)];
                    for (let sq = 0; sq < NN; sq++) if (src[sq]) out[off + sq] = 1;
                    break;
                }
                case 'king_region':
                    region = region || kingRegion(game);
                    for (let sq = 0; sq < NN; sq++) if (region[sq]) out[off + sq] = 1;
                    break;
            }
        });
        return out;
    }

    const Tafl = {
        EMPTY, ATTACKER, DEFENDER, KING, ATTACKER_PLAYER, DEFENDER_PLAYER,
        VARIANTS, PYTHON_DEFAULT_RULES, TaflGame,
        normalizeRules, rulesEqual, geometry,
        encodeMove, moveFrom, moveTo, policyIndex, squareName, moveName,
        parsePlanes, historyNeeded, buildFeatures, reachPlanes, kingRegion,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = Tafl;
    else root.Tafl = Tafl;
})(typeof self !== 'undefined' ? self : this);
