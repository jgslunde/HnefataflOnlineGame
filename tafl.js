/**
 * Tafl rules engine for 7x7, 9x9 and 11x11 boards under named rule sets.
 *
 * A port of tafl.py and features.py from the training code (github.com/jgslunde/Games, folder
 * Hnefatafl_RL/). A network only knows the game as that engine plays it, so every rule here
 * follows the Python code; where they disagree, the Python code is right. tests/test_engine.js
 * replays reference games and rule positions written by the Python engine.
 *
 * A rule set (see makeRules) fixes the starting position, who moves first, where the king escapes
 * to, how he is captured, the throne, and the extra rules of some sets (encirclement, shieldwall,
 * exit fort, what a repeated position means). Its fields keep the Python names, so the rules
 * object of a model's .json file can be used as it is.
 *
 * Board: an Int8Array of N*N squares in row-major order (row 0 is the top row), with the Python
 * piece codes 0 empty, 1 attacker, 2 defender, 3 king. Players: 0 attackers, 1 defenders.
 * A move is a packed integer (from << 8) | to, with squares numbered row * N + col.
 *
 * Shared by all rule sets: pieces move like rooks; a piece other than the king is captured when
 * the opponent's move closes a sandwich (two enemies, or an enemy and a hostile square, on opposite
 * sides); only the king may stop on the throne and on the corners (where those exist); a player
 * who cannot move loses. After a move the checks run in this order (reference A7): captures, king
 * on a goal square, king captured, exit fort (after a defenders' move), encirclement (after an
 * attackers' move), repetition, no legal move for the side to move.
 *
 * Runs in the page, in the search Web Worker and in Node (tests).
 */
(function (root) {
    'use strict';

    const EMPTY = 0, ATTACKER = 1, DEFENDER = 2, KING = 3;
    const ATTACKER_PLAYER = 0, DEFENDER_PLAYER = 1;
    const PIECE_CODES = { '.': EMPTY, A: ATTACKER, D: DEFENDER, K: KING };

    // Directions in the order of the Python engine (and of the policy index): up, down, left, right
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    const KING_CAPTURE_RULES = {
        weak: 'between two attackers like any other piece, everywhere',
        weak_throne: 'like any other piece, but on the throne only from all four sides',
        weak_near_throne: 'like any other piece, but on the throne from all four sides and next to it from the three other sides',
        strong: 'from all four sides (next to the throne from the three other sides); never on the board edge',
    };
    // What the repetition_count-th occurrence of a position means, whichever side made the move
    const REPETITION_RULES = { defenders_lose: 'a win for the attackers', draw: 'a draw' };

    const RULE_FIELDS = ['name', 'description', 'setup', 'first_player', 'king_goal', 'king_capture',
        'king_armed', 'throne', 'throne_hostile', 'encirclement', 'shieldwall', 'exit_fort', 'repetition',
        'throne_passable', 'repetition_count'];
    // Fields added after the first rule sets; model descriptions written before them leave them out
    const RULE_DEFAULTS = { throne_passable: true, repetition_count: 3 };
    const RULES_MARK = Symbol('taflRules');

    /**
     * A rule set from its fields (as Python's Rules; missing later fields get their defaults).
     * Validated like Rules.__post_init__. The result is frozen and carries board_size.
     */
    function makeRules(data) {
        const fields = { ...RULE_DEFAULTS, ...data };
        for (const name of RULE_FIELDS) {
            if (fields[name] === undefined) throw new Error(`Rule set ${fields.name || '?'}: missing field '${name}'`);
        }
        const setup = Array.from(fields.setup, String);
        const n = setup.length;
        const label = fields.name;
        if (n % 2 === 0 || setup.some(row => row.length !== n) || !(n in VARIANTS)) {
            throw new Error(`${label}: the setup must be a 7x7, 9x9 or 11x11 square`);
        }
        if (setup[(n - 1) / 2][(n - 1) / 2] !== 'K') throw new Error(`${label}: the king must start on the centre square`);
        if (setup.some(row => [...row].some(ch => !(ch in PIECE_CODES)))) throw new Error(`${label}: unknown piece in the setup`);
        if (!['attackers', 'defenders'].includes(fields.first_player) || !['corner', 'edge'].includes(fields.king_goal)) {
            throw new Error(`${label}: invalid first_player or king_goal`);
        }
        if (!(fields.king_capture in KING_CAPTURE_RULES) || !(fields.repetition in REPETITION_RULES)) {
            throw new Error(`${label}: invalid king_capture or repetition`);
        }
        const rules = {};
        for (const name of RULE_FIELDS) rules[name] = fields[name];
        for (const name of ['king_armed', 'throne', 'throne_hostile', 'encirclement', 'shieldwall', 'exit_fort', 'throne_passable']) {
            rules[name] = Boolean(rules[name]);
        }
        rules.repetition_count = Number(rules.repetition_count);
        rules.setup = Object.freeze(setup);
        rules.board_size = n;
        Object.defineProperty(rules, RULES_MARK, { value: true });
        return Object.freeze(rules);
    }

    /** A rule set from a rules object, the name of a set in RULESETS, or the fields of one. */
    function normalizeRules(rules) {
        if (typeof rules === 'string') {
            if (!RULESETS[rules]) throw new Error(`Unknown rule set '${rules}'`);
            return RULESETS[rules];
        }
        if (rules && rules[RULES_MARK]) return rules;
        return makeRules(rules || {});
    }

    const rulesKeys = new WeakMap();

    /** A string that is equal for two rule sets exactly when they play the same game. */
    function rulesKey(rules) {
        const r = normalizeRules(rules);
        let key = rulesKeys.get(r);
        if (key === undefined) {
            key = RULE_FIELDS.filter(f => f !== 'name' && f !== 'description')
                .map(f => (f === 'setup' ? r.setup.join('/') : String(r[f]))).join('|');
            rulesKeys.set(r, key);
        }
        return key;
    }

    function rulesEqual(a, b) {
        return rulesKey(a) === rulesKey(b);
    }

    const replace = (rules, changes) => makeRules({ ...rules, ...changes });

    // The board sizes, with the defenders-win share of human games noted in RULESETS.md per set
    const VARIANTS = { 7: { size: 7 }, 9: { size: 9 }, 11: { size: 11 } };

    const BRANDUBH_SETUP = ['...A...', '...A...', '...D...', 'AADKDAA', '...D...', '...A...', '...A...'];
    const TABLUT_SETUP = ['...AAA...', '....A....', '....D....', 'A...D...A', 'AADDKDDAA', 'A...D...A',
        '....D....', '....A....', '...AAA...'];
    const COPENHAGEN_SETUP = ['...AAAAA...', '.....A.....', '...........', 'A....D....A', 'A...DDD...A',
        'AA.DDKDD.AA', 'A...DDD...A', 'A....D....A', '...........', '.....A.....', '...AAAAA...'];
    const SEA_BATTLE_9X9_SETUP = ['....A....', '.A..A..A.', '..A...A..', '...DDD...', 'AA.DKD.AA',
        '...DDD...', '..A...A..', '.A..A..A.', '....A....'];
    const LEWIS_CROSS_SETUP = ['....AAA....', '....AAA....', '.....D.....', '.....D.....', 'AA...D...AA',
        'AADDDKDDDAA', 'AA...D...AA', '.....D.....', '.....D.....', '....AAA....', '....AAA....'];
    const BELL_SETUP = ['....AAA....', '....A.A....', '.....A.....', '.....D.....', 'AA..DDD..AA',
        'A.ADDKDDA.A', 'AA..DDD..AA', '.....D.....', '.....A.....', '....A.A....', '....AAA....'];

    const RULESETS = {};
    {
        const BRANDUBH = makeRules({
            name: 'brandubh', description: 'Brandubh 2 (World Tafl Federation, 2020), the most played 7x7 rules',
            setup: BRANDUBH_SETUP, first_player: 'attackers', king_goal: 'corner', king_capture: 'weak_throne',
            king_armed: true, throne: true, throne_hostile: true, encirclement: true, shieldwall: false,
            exit_fort: false, repetition: 'defenders_lose',
        });
        const SAMI_TABLUT = makeRules({
            name: 'sami_tablut', description: 'Sami Tablut 9x9 as in the WTF championship (Saami Tablut-w, defenders first)',
            setup: TABLUT_SETUP, first_player: 'defenders', king_goal: 'edge', king_capture: 'weak_near_throne',
            king_armed: true, throne: true, throne_hostile: true, encirclement: true, shieldwall: false,
            exit_fort: false, repetition: 'defenders_lose',
        });
        const COPENHAGEN = makeRules({
            name: 'copenhagen', description: 'Copenhagen Hnefatafl 11x11 (World Tafl Federation, 2012), the most played 11x11 rules',
            setup: COPENHAGEN_SETUP, first_player: 'attackers', king_goal: 'corner', king_capture: 'strong',
            king_armed: true, throne: true, throne_hostile: true, encirclement: true, shieldwall: true,
            exit_fort: true, repetition: 'defenders_lose',
        });
        const sets = [
            BRANDUBH,
            replace(BRANDUBH, { name: 'walker_brandub', king_capture: 'weak', throne_hostile: false,
                description: "Walker's Brandub 7x7 (2011), as played on aagenielsen.dk" }),
            replace(BRANDUBH, { name: 'brandubh_2_5w', first_player: 'defenders', throne_passable: false,
                repetition_count: 5, description: 'Brandubh 2.5W 7x7 (draft of February 2026; start position assumed to be that of Brandubh 2)' }),
            SAMI_TABLUT,
            makeRules({
                name: 'sea_battle_9x9', description: 'Sea Battle 9x9, Nielsen setup', setup: SEA_BATTLE_9X9_SETUP,
                first_player: 'attackers', king_goal: 'edge', king_capture: 'strong', king_armed: false,
                throne: false, throne_hostile: false, encirclement: true, shieldwall: false, exit_fort: false,
                repetition: 'defenders_lose',
            }),
            makeRules({
                name: 'market_hnefatafl', description: "Market Hnefatafl 9x9, the beginners' version of Sami Tablut",
                setup: TABLUT_SETUP, first_player: 'defenders', king_goal: 'edge', king_capture: 'weak',
                king_armed: true, throne: false, throne_hostile: false, encirclement: false, shieldwall: false,
                exit_fort: false, repetition: 'defenders_lose',
            }),
            COPENHAGEN,
            replace(SAMI_TABLUT, { name: 'historical_lewis', setup: LEWIS_CROSS_SETUP,
                description: 'Historical 11x11 (Tawlbwrdd), Lewis cross setup, as in the WTF championship' }),
            replace(SAMI_TABLUT, { name: 'historical_bell', setup: BELL_SETUP,
                description: 'Historical 11x11 (Tawlbwrdd), Bell setup, defenders first' }),
            replace(SAMI_TABLUT, { name: 'simple_tafl', setup: LEWIS_CROSS_SETUP, throne: false,
                throne_hostile: false, description: 'Simple Tafl 11x11: historical rules, Lewis cross setup, no throne, defenders first' }),
            replace(COPENHAGEN, { name: 'fetlar', shieldwall: false, exit_fort: false, repetition: 'draw',
                description: 'Fetlar Hnefatafl 11x11 (2007)' }),
        ];
        for (const rules of sets) RULESETS[rules.name] = rules;
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
     * Corner, centre and edge squares of a board size, and the Zobrist keys of its positions. A
     * position key is a 53-bit integer: 21 bits from zHi and 32 from zLo. Two different positions
     * share a key with probability about 2^-53, far below anything a game or a search can reach.
     */
    function geometry(N) {
        if (geometries[N]) return geometries[N];
        const NN = N * N;
        const corners = [0, N - 1, N * (N - 1), NN - 1];
        const cornerMask = new Uint8Array(NN);
        for (const sq of corners) cornerMask[sq] = 1;
        const isEdge = new Uint8Array(NN);
        for (let sq = 0; sq < NN; sq++) {
            const r = (sq / N) | 0, c = sq % N;
            isEdge[sq] = (r === 0 || r === N - 1 || c === 0 || c === N - 1) ? 1 : 0;
        }
        const rand = mulberry32(0x7AF1 + N);
        const zHi = new Int32Array(NN * 4), zLo = new Int32Array(NN * 4);
        for (let i = 0; i < NN * 4; i++) {
            zHi[i] = rand() & 0x1FFFFF;
            zLo[i] = rand() | 0;
        }
        geometries[N] = {
            N, NN, corners, cornerMask, noCorners: new Uint8Array(NN), isEdge,
            center: (NN - 1) / 2,
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
         * A new game in the rule set's start position.
         * @param {string|object} rules a rule set name (see RULESETS), a rules object, or its fields
         */
        constructor(rules = 'copenhagen') {
            this._init(normalizeRules(rules));
            const N = this.N;
            this.rules.setup.forEach((row, r) => {
                for (let c = 0; c < N; c++) this.board[r * N + c] = PIECE_CODES[row[c]];
            });
            this.currentPlayer = this.rules.first_player === 'attackers' ? ATTACKER_PLAYER : DEFENDER_PLAYER;
            this._computeHash();
            this.repKeys = [this.positionKey()];
        }

        _init(rules) {
            this.rules = rules;
            const N = this.N = rules.board_size;
            this.geo = geometry(N);
            // Corner squares exist only where the king escapes to a corner; the centre is a throne
            // only in sets with a throne
            this.isCorner = rules.king_goal === 'corner' ? this.geo.cornerMask : this.geo.noCorners;
            this.corners = rules.king_goal === 'corner' ? this.geo.corners : [];
            this.throneSq = rules.throne ? this.geo.center : -1;
            this.board = new Int8Array(N * N);
            this.currentPlayer = ATTACKER_PLAYER;
            this.gameOver = false;
            this.winner = null;      // stays null for a draw
            this.endReason = null;   // escape, capture, exit_fort, encirclement, repetition, no_moves
            this.moveCount = 0;
            // Keys of the positions since the last capture, oldest first, the current one last. A
            // capture removes pieces for good, so no earlier position can occur again; for the
            // repetition rule these are all the positions that matter.
            this.repKeys = [];
            // Boards of the previous positions, oldest first (for history input planes), at most
            // keepBoards of them
            this.prevBoards = [];
            this.keepBoards = 0;
            this._legal = null;
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

        _flip(sq, piece) {
            this.hashHi ^= this.geo.zHi[sq * 4 + piece];
            this.hashLo ^= this.geo.zLo[sq * 4 + piece];
        }

        /** Key of the position (board and player to move), as used by the repetition rule. */
        positionKey() {
            return this.hashHi * 4294967296 + (this.hashLo >>> 0);
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
            Object.assign(g, this);
            g.board = this.board.slice();
            g.repKeys = this.repKeys.slice();
            g.prevBoards = this.prevBoards.slice();  // the stored boards are never changed
            return g;                               // rules, geometry and _legal are shared, never changed
        }

        /** A plain object that survives postMessage; TaflGame.fromState rebuilds the game. */
        toState() {
            return {
                rules: { ...this.rules, setup: [...this.rules.setup] },
                board: this.board.slice(),
                currentPlayer: this.currentPlayer,
                gameOver: this.gameOver,
                winner: this.winner,
                endReason: this.endReason,
                moveCount: this.moveCount,
                repKeys: this.repKeys.slice(),
                prevBoards: this.prevBoards.map(b => b.slice()),
                keepBoards: this.keepBoards,
            };
        }

        static fromState(state) {
            const g = Object.create(TaflGame.prototype);
            g._init(normalizeRules(state.rules));
            g.board = Int8Array.from(state.board);
            g.currentPlayer = state.currentPlayer;
            g.gameOver = Boolean(state.gameOver);
            g.winner = state.winner === undefined ? null : state.winner;
            g.endReason = state.endReason || null;
            g.moveCount = state.moveCount || 0;
            g._computeHash();
            g.repKeys = state.repKeys && state.repKeys.length ? state.repKeys.slice() : [g.positionKey()];
            g.prevBoards = (state.prevBoards || []).map(b => Int8Array.from(b));
            g.keepBoards = state.keepBoards || 0;
            return g;
        }

        /**
         * A game in a given position (for tests and set-up positions). board: N*N piece codes, flat or
         * as rows. history: the earlier positions, oldest first, as [{board, player}], for the
         * repetition rule and the history planes (default: none, as if the game started here).
         */
        static fromPosition(rules, board, currentPlayer, history = []) {
            const g = Object.create(TaflGame.prototype);
            g._init(normalizeRules(rules));
            g.currentPlayer = currentPlayer;
            g.repKeys = history.map(({ board: b, player }) => {
                g.board = Int8Array.from(Array.isArray(b[0]) ? b.flat() : b);
                g.currentPlayer = player;
                g._computeHash();
                return g.positionKey();
            });
            g.prevBoards = history.map(({ board: b }) => Int8Array.from(Array.isArray(b[0]) ? b.flat() : b));
            g.board = Int8Array.from(Array.isArray(board[0]) ? board.flat() : board);
            g.currentPlayer = currentPlayer;
            g._computeHash();
            g.repKeys.push(g.positionKey());
            return g;
        }

        kingSquare() {
            return this.board.indexOf(KING);
        }

        isOwnPiece(sq, player = this.currentPlayer) {
            const p = this.board[sq];
            return player === ATTACKER_PLAYER ? p === ATTACKER : (p === DEFENDER || p === KING);
        }

        _inside(r, c) {
            return r >= 0 && r < this.N && c >= 0 && c < this.N;
        }

        // --------------------------------------------------------------------------------------
        // Move generation (Python: get_legal_moves)
        // --------------------------------------------------------------------------------------

        /**
         * All legal moves of the player to move, in the order of the Python engine (squares in
         * row-major order; per piece up, down, left, right; nearest square first). The returned
         * array is cached and shared: do not change it.
         */
        legalMoves() {
            if (this._legal === null) this._legal = this._slides(this.currentPlayer === ATTACKER_PLAYER ? 1 : 2, null);
            return this._legal;
        }

        isLegalMove(move) {
            return this.legalMoves().includes(move);
        }

        /** Legal moves of the piece on a square (empty unless it belongs to the player to move). */
        legalMovesFrom(sq) {
            return this.legalMoves().filter(m => (m >> 8) === sq);
        }

        /**
         * The rook slides of pieces: side 1 attackers, 2 defenders and king, 3 all pieces. Pieces
         * other than the king never stop on a corner or the throne; they pass over the empty throne
         * only where the rules allow it. With `visit`, calls visit(piece, target) instead of
         * collecting moves.
         */
        _slides(side, visit) {
            const N = this.N, b = this.board, NN = N * N;
            const isCorner = this.isCorner, throne = this.throneSq, passable = this.rules.throne_passable;
            const moves = [];
            for (let sq = 0; sq < NN; sq++) {
                const p = b[sq];
                if (p === EMPTY) continue;
                if (side === 1 && p !== ATTACKER) continue;
                if (side === 2 && p === ATTACKER) continue;
                const isKing = p === KING;
                const r = (sq / N) | 0, c = sq % N;
                for (let d = 0; d < 4; d++) {
                    const dr = DIRS[d][0], dc = DIRS[d][1];
                    let nr = r + dr, nc = c + dc;
                    while (nr >= 0 && nr < N && nc >= 0 && nc < N) {
                        const t = nr * N + nc;
                        if (b[t] !== EMPTY) break;
                        if (!isKing) {
                            if (isCorner[t]) break;  // corners end a ray, so nothing lies beyond
                            if (t === throne) {
                                if (!passable) break;
                                nr += dr;
                                nc += dc;
                                continue;
                            }
                        }
                        if (visit) visit(p, t);
                        else moves.push((sq << 8) | t);
                        nr += dr;
                        nc += dc;
                    }
                }
            }
            return moves;
        }

        // --------------------------------------------------------------------------------------
        // Making a move (Python: make_move)
        // --------------------------------------------------------------------------------------

        /**
         * Make a move (it must be legal; see isLegalMove) and decide whether the game is over.
         * Returns the captured squares (the king's included), or null if the game was already over.
         */
        makeMove(move) {
            if (this.gameOver) return null;
            const from = move >> 8, to = move & 255;
            const b = this.board;
            const piece = b[from];
            if (this.keepBoards > 0) {
                this.prevBoards.push(b.slice());
                if (this.prevBoards.length > this.keepBoards) this.prevBoards.shift();
            }
            b[from] = EMPTY;
            b[to] = piece;
            this._flip(from, piece);
            this._flip(to, piece);
            this.moveCount++;

            const { captured, kingCaptured } = this._findCaptures(to);
            const removed = [];
            for (const sq of captured) {
                if (b[sq] === EMPTY) continue;  // the same piece twice (custodian and shieldwall)
                this._flip(sq, b[sq]);
                b[sq] = EMPTY;
                removed.push(sq);
            }
            const mover = this.currentPlayer;
            this.currentPlayer = 1 - mover;
            this.hashHi ^= this.geo.playerHi;
            this.hashLo ^= this.geo.playerLo;
            this._legal = null;
            // As in Python, the position is recorded before a captured king leaves the board
            const key = this.positionKey();
            if (removed.length) this.repKeys = [key];
            else this.repKeys.push(key);

            if (piece === KING && this._isGoal(to)) {
                this._end(DEFENDER_PLAYER, 'escape');
            } else if (kingCaptured) {
                const king = b.indexOf(KING);
                this._flip(king, KING);
                b[king] = EMPTY;
                removed.push(king);
                this._end(ATTACKER_PLAYER, 'capture');
            } else if (this.rules.exit_fort && mover === DEFENDER_PLAYER && this.isKingInExitFort()) {
                this._end(DEFENDER_PLAYER, 'exit_fort');
            } else if (this.rules.encirclement && mover === ATTACKER_PLAYER && this.areDefendersEncircled()) {
                this._end(ATTACKER_PLAYER, 'encirclement');
            } else if (this.repetitionCount() >= this.rules.repetition_count) {
                this._end(this.rules.repetition === 'defenders_lose' ? ATTACKER_PLAYER : null, 'repetition');
            } else if (this.legalMoves().length === 0) {
                this._end(mover, 'no_moves');
            }
            return removed;
        }

        _end(winner, reason) {
            this.gameOver = true;
            this.winner = winner;
            this.endReason = reason;
        }

        _isGoal(sq) {
            return this.rules.king_goal === 'corner' ? this.isCorner[sq] === 1 : this.geo.isEdge[sq] === 1;
        }

        // --------------------------------------------------------------------------------------
        // Captures (Python: _closes_sandwich, _find_captures, _king_captured, _shieldwall_captures)
        // --------------------------------------------------------------------------------------

        /** Whether square sq closes a sandwich against a `target` piece (not the king). */
        _closesSandwich(sq, target) {
            const p = this.board[sq];
            if (target === ATTACKER && (p === DEFENDER || (p === KING && this.rules.king_armed))) return true;
            if (target === DEFENDER && p === ATTACKER) return true;
            if (this.isCorner[sq]) return true;
            if (this.rules.throne && this.rules.throne_hostile && sq === this.throneSq) return target === ATTACKER || p === EMPTY;
            return false;
        }

        /** The captures made by the piece that just moved to `to`, without changing the board. */
        _findCaptures(to) {
            const N = this.N, b = this.board;
            const piece = b[to];
            const captured = [];
            let kingCaptured = false;
            if (piece === KING && !this.rules.king_armed) return { captured, kingCaptured };
            const attacking = piece === ATTACKER;
            const r = (to / N) | 0, c = to % N;
            for (let d = 0; d < 4; d++) {
                const dr = DIRS[d][0], dc = DIRS[d][1];
                const r1 = r + dr, c1 = c + dc, r2 = r + 2 * dr, c2 = c + 2 * dc;
                if (!this._inside(r1, c1)) continue;
                const n1 = r1 * N + c1;
                const target = b[n1];
                if (target === EMPTY || (target === ATTACKER) === attacking) continue;
                if (target === KING) {
                    kingCaptured = kingCaptured || this._isKingCaptured(n1, dr, dc);
                } else if (this._inside(r2, c2) && this._closesSandwich(r2 * N + c2, target)) {
                    captured.push(n1);
                }
            }
            if (this.rules.shieldwall && this.geo.isEdge[to]) captured.push(...this._shieldwallCaptures(to));
            return { captured, kingCaptured };
        }

        /**
         * Whether the king on square k is captured by the attacker that just moved next to him,
         * coming from direction (-dr, -dc).
         */
        _isKingCaptured(k, dr, dc) {
            const N = this.N, b = this.board, rule = this.rules.king_capture;
            const r = (k / N) | 0, c = k % N, t = (N - 1) / 2;
            const onThrone = this.rules.throne && k === this.throneSq;
            const nextToThrone = this.rules.throne && Math.abs(r - t) + Math.abs(c - t) === 1;
            const fourSides = rule === 'strong' || (rule === 'weak_throne' && onThrone) ||
                (rule === 'weak_near_throne' && (onThrone || nextToThrone));
            if (!fourSides) {
                // Two opposite sides: the attacker that moved, and an attacker or a corner beyond
                const r2 = r + dr, c2 = c + dc;
                return this._inside(r2, c2) && (b[r2 * N + c2] === ATTACKER || this.isCorner[r2 * N + c2] === 1);
            }
            if (this.geo.isEdge[k]) return false;  // the edge never counts as a side
            // Attackers on all four sides; the empty throne next to the king counts as one of them
            for (const [ar, ac] of DIRS) {
                const n = (r + ar) * N + (c + ac);
                if (b[n] !== ATTACKER && !(this.rules.throne && n === this.throneSq)) return false;
            }
            return true;
        }

        /** Pieces captured by a shieldwall that the piece on edge square sq closes. */
        _shieldwallCaptures(sq) {
            const N = this.N, b = this.board;
            const r = (sq / N) | 0, c = sq % N;
            const attacking = b[sq] === ATTACKER;
            const armed = this.rules.king_armed;
            const isEnemy = attacking ? (p => p === DEFENDER || p === KING) : (p => p === ATTACKER);
            const isOwn = attacking ? (p => p === ATTACKER) : (p => p === DEFENDER || (armed && p === KING));
            const captured = [];
            // (direction into the board, whether sq is on that edge)
            const edges = [[1, 0, r === 0], [-1, 0, r === N - 1], [0, 1, c === 0], [0, -1, c === N - 1]];
            for (const [ir, ic, onEdge] of edges) {
                if (!onEdge) continue;
                for (const [ar, ac] of [[ic, ir], [-ic, -ir]]) {
                    const row = [];
                    let rr = r + ar, cc = c + ac;
                    while (this._inside(rr, cc) && isEnemy(b[rr * N + cc])) {
                        row.push(rr * N + cc);
                        rr += ar;
                        cc += ac;
                    }
                    const closed = this._inside(rr, cc) && (isOwn(b[rr * N + cc]) || this.isCorner[rr * N + cc] === 1);
                    const faced = row.every(s => isOwn(b[s + ir * N + ic]));
                    if (row.length >= 2 && closed && faced) {
                        for (const s of row) if (b[s] !== KING) captured.push(s);
                    }
                }
            }
            return captured;
        }

        // --------------------------------------------------------------------------------------
        // Encirclement and exit fort (Python: _defenders_encircled, _king_in_exit_fort)
        // --------------------------------------------------------------------------------------

        /** True if no defender (king included) can reach the edge through squares without attackers. */
        areDefendersEncircled() {
            const region = defenderRegion(this);
            const isEdge = this.geo.isEdge;
            for (let sq = 0; sq < region.length; sq++) if (region[sq] && isEdge[sq]) return false;
            return true;
        }

        /**
         * The exit fort test (reference B2): the king stands on the edge, can move, and is walled in
         * by defending soldiers that can never be captured, whatever the attackers do. See the
         * Python method for the reasoning; this follows it step by step.
         */
        isKingInExitFort() {
            const N = this.N, NN = N * N, b = this.board;
            const king = b.indexOf(KING);
            if (king < 0 || !this.geo.isEdge[king]) return false;
            // The fort's inside: the king's square and the empty squares he can walk to
            const inside = new Uint8Array(NN);
            inside[king] = 1;
            const stack = [king];
            let size = 1;
            while (stack.length) {
                const sq = stack.pop();
                for (const n of neighbours(N, sq)) {
                    if (!inside[n] && b[n] === EMPTY) {
                        inside[n] = 1;
                        size++;
                        stack.push(n);
                    }
                }
            }
            if (size < 2) return false;  // the king cannot move
            const wall = new Uint8Array(NN);
            for (let sq = 0; sq < NN; sq++) {
                if (!inside[sq]) continue;
                for (const n of neighbours(N, sq)) if (!inside[n]) wall[n] = 1;
            }
            for (let sq = 0; sq < NN; sq++) if (wall[sq] && b[sq] === ATTACKER) return false;

            const safe = new Uint8Array(NN);
            for (let sq = 0; sq < NN; sq++) if (b[sq] === DEFENDER) safe[sq] = 1;
            const openSquares = () => {
                const open = new Uint8Array(NN);
                for (let sq = 0; sq < NN; sq++) open[sq] = !inside[sq] && !safe[sq] ? 1 : 0;
                return open;
            };
            // The four edge lines, each with the direction into the board (for shieldwall runs)
            const line = (f) => Array.from({ length: N }, (_, i) => f(i));
            const edgeLines = [
                [line(i => i), N], [line(i => (N - 1) * N + i), -N],
                [line(i => i * N), 1], [line(i => i * N + N - 1), -1],
            ];
            let changed = true;
            while (changed) {
                changed = false;
                // A soldier with open squares on both sides along one line could be captured
                let open = openSquares();
                const soldiers = [];
                for (let sq = 0; sq < NN; sq++) if (safe[sq]) soldiers.push(sq);
                for (const sq of soldiers) {
                    const r = (sq / N) | 0, c = sq % N;
                    for (const [dr, dc] of [[1, 0], [0, 1]]) {
                        if (this._inside(r - dr, c - dc) && this._inside(r + dr, c + dc) &&
                            open[(r - dr) * N + c - dc] && open[(r + dr) * N + c + dc]) {
                            safe[sq] = 0;
                            changed = true;
                        }
                    }
                }
                if (!this.rules.shieldwall) continue;
                // A run of two or more soldiers along an edge, open in front and at both ends
                open = openSquares();
                for (const [squares, inward] of edgeLines) {
                    let i = 0;
                    while (i < N) {
                        if (!safe[squares[i]]) {
                            i++;
                            continue;
                        }
                        let j = i;
                        while (j < N && safe[squares[j]]) j++;
                        const run = squares.slice(i, j);
                        const endsOpen = i > 0 && j < N && open[squares[i - 1]] && open[squares[j]];
                        if (run.length >= 2 && endsOpen && run.every(s => open[s + inward])) {
                            for (const s of run) safe[s] = 0;
                            changed = true;
                        }
                        i = j;
                    }
                }
            }
            for (let sq = 0; sq < NN; sq++) if (wall[sq] && !safe[sq]) return false;
            return true;
        }

        /** Number of pieces of a kind on the board. */
        count(piece) {
            let n = 0;
            for (let sq = 0; sq < this.board.length; sq++) if (this.board[sq] === piece) n++;
            return n;
        }
    }

    function neighbours(N, sq) {
        const r = (sq / N) | 0, c = sq % N, out = [];
        if (r > 0) out.push(sq - N);
        if (r < N - 1) out.push(sq + N);
        if (c > 0) out.push(sq - 1);
        if (c < N - 1) out.push(sq + 1);
        return out;
    }

    // ------------------------------------------------------------------------------------------
    // Network input planes (features.py)
    // ------------------------------------------------------------------------------------------

    /**
     * Squares connected to a defender or the king through squares that hold no attacker (their own
     * squares included). The defenders are encircled exactly when this region touches no edge
     * square. Python: features.defender_region_plane and Tafl._defenders_encircled.
     */
    function defenderRegion(game) {
        const N = game.N, b = game.board;
        const region = new Uint8Array(N * N);
        const stack = [];
        for (let sq = 0; sq < b.length; sq++) {
            if (b[sq] >= DEFENDER) {
                region[sq] = 1;
                stack.push(sq);
            }
        }
        while (stack.length) {
            const sq = stack.pop();
            for (const n of neighbours(N, sq)) {
                if (!region[n] && b[n] !== ATTACKER) {
                    region[n] = 1;
                    stack.push(n);
                }
            }
        }
        return region;
    }

    /**
     * [reach_attackers, reach_defenders, reach_king]: the squares each side could move to now, for
     * both sides whatever the turn. reach_defenders includes the king's squares. Python:
     * features.reach_planes (equal to the moves of Tafl.get_legal_moves).
     */
    function reachPlanes(game) {
        const NN = game.N * game.N;
        const attackers = new Uint8Array(NN), defenders = new Uint8Array(NN), king = new Uint8Array(NN);
        game._slides(3, (p, t) => {
            if (p === ATTACKER) attackers[t] = 1;
            else if (p === DEFENDER) defenders[t] = 1;
            else {
                king[t] = 1;
                defenders[t] = 1;
            }
        });
        return { attackers, defenders, king };
    }

    const PIECE_PLANES = { attackers: ATTACKER, defenders: DEFENDER, king: KING };
    const SIMPLE_PLANES = new Set(['player', 'ones', 'corners', 'throne', 'reach_attackers',
        'reach_defenders', 'reach_king', 'defender_region']);

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
     * start of the game they are zero. The corner plane is empty without corner squares, the throne
     * plane without a throne.
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
                    const code = PIECE_PLANES[plane.kind];
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
                    for (const sq of game.corners) out[off + sq] = 1;
                    break;
                case 'throne':
                    if (game.throneSq >= 0) out[off + game.throneSq] = 1;
                    break;
                case 'reach_attackers':
                case 'reach_defenders':
                case 'reach_king': {
                    reach = reach || reachPlanes(game);
                    const src = reach[plane.kind.slice(6)];
                    for (let sq = 0; sq < NN; sq++) if (src[sq]) out[off + sq] = 1;
                    break;
                }
                case 'defender_region':
                    region = region || defenderRegion(game);
                    for (let sq = 0; sq < NN; sq++) if (region[sq]) out[off + sq] = 1;
                    break;
            }
        });
        return out;
    }

    const Tafl = {
        EMPTY, ATTACKER, DEFENDER, KING, ATTACKER_PLAYER, DEFENDER_PLAYER,
        VARIANTS, RULESETS, KING_CAPTURE_RULES, REPETITION_RULES, TaflGame,
        makeRules, normalizeRules, rulesKey, rulesEqual, geometry,
        encodeMove, moveFrom, moveTo, policyIndex, squareName, moveName,
        parsePlanes, historyNeeded, buildFeatures, reachPlanes, defenderRegion,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = Tafl;
    else root.Tafl = Tafl;
})(typeof self !== 'undefined' ? self : this);
