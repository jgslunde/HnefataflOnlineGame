/**
 * The page: board display, input, game flow, AI players, evaluation bar and move suggestions.
 *
 * The game itself is a TaflGame (tafl.js); the DOM only shows it. The network and the tree search
 * run in a Web Worker (searchWorker.js, reached through searchClient.js). Which models exist, and
 * the rules and search settings each was trained with, comes from models.json and the models'
 * .json descriptions.
 */
'use strict';

const { TaflGame, RULESETS, ATTACKER, DEFENDER, KING, ATTACKER_PLAYER, encodeMove, moveFrom, moveTo } = Tafl;
const { chooseMove } = TaflMCTS;
const { modelSearchSettings, modelRules } = TaflNetwork;

const SIDES = ['attacker', 'defender'];
const SIDE_NAMES = ['Attacker', 'Defender'];
const PIECE_GLYPHS = { [ATTACKER]: '⚫', [DEFENDER]: '⚪', [KING]: '⬜' };
const PIECE_CLASSES = { [ATTACKER]: 'attacker', [DEFENDER]: 'defender', [KING]: 'king' };
// Previous positions a game keeps, for networks with history input planes
const KEEP_BOARDS = 32;
// The rule set a new game of each board size starts with: the most played rules of that size
const DEFAULT_RULESETS = { 7: 'brandubh', 9: 'sami_tablut', 11: 'copenhagen' };
// Display names of the rule sets, and the defenders' share of wins in human games on
// aagenielsen.dk (a draw counts half; RULESETS.md in the training code)
const RULESET_INFO = {
    brandubh: { title: 'Brandubh 2', defenders: '62 % of 2,318' },
    walker_brandub: { title: "Walker's Brandub", defenders: '55 % of 468' },
    brandubh_2_5w: { title: 'Brandubh 2.5W', defenders: '59 % of 354' },
    sami_tablut: { title: 'Sami Tablut', defenders: '49 % of 966' },
    sea_battle_9x9: { title: 'Sea Battle', defenders: '51 % of 352' },
    market_hnefatafl: { title: 'Market Hnefatafl', defenders: '46 % of 222' },
    copenhagen: { title: 'Copenhagen Hnefatafl', defenders: '58 % of 13,640 (52 % among top players)' },
    historical_lewis: { title: 'Historical Hnefatafl, Lewis cross', defenders: '52 % of 664' },
    historical_bell: { title: 'Historical Hnefatafl, Bell', defenders: '51 % of 314' },
    simple_tafl: { title: 'Simple Tafl', defenders: '50 % of 142' },
    fetlar: { title: 'Fetlar Hnefatafl', defenders: '59 % of 1,564' },
};
// Endless analysis stops here: the search tree grows with every simulation
const MAX_ANALYSIS_SIMS = { 7: 100000, 9: 50000, 11: 25000 };
const SLIDE_MS = 400;
const FADE_MS = 300;
const PREFS_KEY = 'tafl-prefs-v2';

const $ = (id) => document.getElementById(id);
const boardTable = $('board-table');
const boardEl = $('board');

const app = {
    size: 7,
    rules: RULESETS.brandubh,
    game: null,
    history: [],          // [{game, lastMove}] before each move, for undo
    lastMove: null,
    selected: -1,         // selected square, or -1
    cells: [],            // per square {td, piece}
    models: [],           // manifest entries with their description (desc), board size and rules
    defaults: {},         // default model id per rule set name
    modelBySize: {},      // the model last chosen for each board size
    model: null,          // the model of the current game (manifest entry) or null
    modelState: 'none',   // none, loading, ready, error
    modelError: null,
    msPerCall: null,
    searchParams: modelSearchSettings(null),
    players: {
        attacker: { type: 'human', sims: 200, depth: 4 },
        defender: { type: 'human', sims: 200, depth: 4 },
    },
    evalMode: 'nn-mcts',
    policyMode: 'off',
    temperature: 0.4,
    analysisSims: 200,
    continuous: false,
    token: 0,             // changes with every position change; async work checks it
    epoch: 0,             // changes when the game is replaced (undo, restart): stops animations
    animating: false,
    analysis: { stats: null, nn: null },
    analysisJobs: [],
};

let client = null;
try {
    client = new SearchClient('searchWorker.js');
} catch (error) {
    console.error('[Page] Cannot start the search worker:', error);
}

// The Minimax AI is C++ compiled to WebAssembly (Cpp_ai.js); it knows only 7x7 boards, and only the
// old Brandubh rules, so its moves are checked against the engine
let cppReady = false;
if (typeof Module !== 'undefined') {
    const previous = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = () => {
        cppReady = true;
        if (previous) previous();
    };
}

// ----------------------------------------------------------------------------------------------
// Rules in words
// ----------------------------------------------------------------------------------------------

const rulesetTitle = (rules) => (RULESET_INFO[rules.name] || { title: rules.name }).title;

const KING_CAPTURE_SHORT = {
    weak: 'weak king',
    weak_throne: 'weak king, strong on the throne',
    weak_near_throne: 'weak king, strong at the throne',
    strong: 'strong king',
};

const ordinal = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n] || 'th'}`;

/** The rules in a few words, for the line above the board. */
function rulesSummary(rules) {
    const parts = [];
    if (rules.first_player === 'defenders') parts.push('defenders start');
    parts.push(rules.king_goal === 'corner' ? 'corner escape' : 'edge escape');
    parts.push(KING_CAPTURE_SHORT[rules.king_capture]);
    if (!rules.king_armed) parts.push('unarmed king');
    if (!rules.throne) parts.push('no throne');
    else {
        parts.push(rules.throne_hostile ? 'hostile throne' : 'throne');
        if (!rules.throne_passable) parts.push('only the king crosses the throne');
    }
    for (const [field, text] of [['encirclement', 'encirclement'], ['shieldwall', 'shieldwall'], ['exit_fort', 'exit fort']]) {
        if (rules[field]) parts.push(text);
    }
    if (rules.repetition === 'draw') parts.push(`${ordinal(rules.repetition_count)} repetition draws`);
    else if (rules.repetition_count !== 3) parts.push(`${ordinal(rules.repetition_count)} repetition loses for the defenders`);
    return parts.join(' · ');
}

/** What differs between the game's rules and a model's training rules, in the model's terms. */
function rulesDifferences(rules, trained) {
    if (Tafl.rulesEqual(rules, trained)) return [];
    const out = [];
    if (rules.setup.join('') !== trained.setup.join('')) out.push('another starting position');
    if (rules.first_player !== trained.first_player) out.push(`${trained.first_player} start`);
    if (rules.king_goal !== trained.king_goal) out.push(`${trained.king_goal} escape`);
    if (rules.king_capture !== trained.king_capture) out.push(KING_CAPTURE_SHORT[trained.king_capture]);
    if (rules.king_armed !== trained.king_armed) out.push(trained.king_armed ? 'armed king' : 'unarmed king');
    if (rules.throne !== trained.throne) out.push(trained.throne ? 'a throne' : 'no throne');
    else if (trained.throne && rules.throne_hostile !== trained.throne_hostile) out.push(trained.throne_hostile ? 'hostile throne' : 'throne not hostile');
    if (trained.throne && rules.throne_passable !== trained.throne_passable) {
        out.push(trained.throne_passable ? 'every piece crosses the throne' : 'only the king crosses the throne');
    }
    for (const [field, text] of [['encirclement', 'encirclement'], ['shieldwall', 'shieldwall'], ['exit_fort', 'exit fort']]) {
        if (rules[field] !== trained[field]) out.push(trained[field] ? text : `no ${text}`);
    }
    if (rules.repetition !== trained.repetition || rules.repetition_count !== trained.repetition_count) {
        out.push(`${ordinal(trained.repetition_count)} repetition ${trained.repetition === 'draw' ? 'draws' : 'loses for the defenders'}`);
    }
    return out;
}

/** The rules in full sentences, for the help panel. */
function rulesList(rules) {
    const corners = rules.king_goal === 'corner';
    const items = [
        'All pieces, the king included, move like rooks in chess: any number of empty squares in a straight line.',
        `The ${rules.first_player} move first.`,
    ];
    if (rules.throne) {
        items.push(`Only the king may stop on ${corners ? 'a corner or ' : ''}the throne (the centre square). ` +
            (rules.throne_passable ? 'Other pieces may pass over the empty throne.' : 'Only the king may pass over the empty throne.'));
    } else {
        items.push(corners ? 'Only the king may stop on a corner. There is no throne: the centre is an ordinary square.'
            : 'There are no special squares: the centre is an ordinary square once the king has left it.');
    }
    items.push('A piece is captured when the opponent moves so that it is trapped between two enemies in a line ' +
        '(not diagonally). Only the moving piece captures, so a piece may safely move in between two enemies.');
    const hostile = [];
    if (corners) hostile.push('The corners count as enemies of every piece.');
    if (rules.throne && rules.throne_hostile) hostile.push('The throne counts as an enemy of attackers always, and of defenders when it is empty.');
    if (hostile.length) items.push(hostile.join(' '));
    items.push(rules.king_armed ? 'The king takes part in captures, both as the moving piece and as the second piece.'
        : 'The king is unarmed: he takes no part in captures.');
    const pair = corners ? 'between two attackers, or an attacker and a corner' : 'between two attackers';
    items.push({
        weak: `The king is captured like any other piece: ${pair}.`,
        weak_throne: `The king is captured like any other piece (${pair}), but on the throne only when attackers surround him on all four sides.`,
        weak_near_throne: `The king is captured like any other piece (${pair}), but on the throne only from all four sides, and next to the throne from the three other sides.`,
        strong: `The king is captured only when attackers surround him on all four sides${rules.throne ? ', or on the three other sides when he stands next to the throne' : ''}. He cannot be captured on the board edge.`,
    }[rules.king_capture]);
    if (rules.shieldwall) {
        items.push('Shieldwall: a row of two or more pieces along the board edge is captured at once when the opponent ' +
            'closes both ends (a corner can be one end) and has a piece in front of every piece of the row. A king in the row survives.');
    }
    items.push(corners ? 'The defenders win when the king reaches a corner.' : 'The defenders win when the king reaches any square on the board edge.');
    if (rules.exit_fort) {
        items.push('They also win with an exit fort: the king on the edge, able to move, walled in by defenders that the attackers can never capture.');
    }
    items.push('The attackers win when they capture the king.' +
        (rules.encirclement ? ' They also win by encirclement: when no defender can reach the board edge any more.' : ''));
    items.push(`When a position (with the same player to move) occurs for the ${ordinal(rules.repetition_count)} time, the game ends ` +
        `${rules.repetition === 'draw' ? 'in a draw' : 'with a win for the attackers'}, whoever made the move. A player who cannot move loses.`);
    return items;
}

// ----------------------------------------------------------------------------------------------
// Models
// ----------------------------------------------------------------------------------------------

async function loadManifest() {
    const response = await fetch('models.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`models.json: HTTP ${response.status}`);
    const manifest = await response.json();
    const entries = await Promise.all((manifest.models || []).map(async (entry) => {
        try {
            const r = await fetch(entry.info, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const desc = await r.json();
            Tafl.parsePlanes(desc.input.planes);  // throws on input planes this page cannot build
            const rules = modelRules(desc);       // throws for a model without a named rule set
            return { ...entry, desc, size: rules.board_size, rules };
        } catch (error) {
            console.warn(`[Models] Skipping ${entry.id} (${entry.info}): ${error.message}`);
            return null;
        }
    }));
    app.models = entries.filter(Boolean);
    app.defaults = manifest.defaults || {};
}

const modelsForSize = (size) => app.models.filter(m => m.size === size);
const findModel = (id) => app.models.find(m => m.id === id) || null;

/**
 * The model a new game under `rules` starts with: the default model of the rule set, else one
 * trained with these rules, else the model last chosen for this board size, else any of the size.
 */
function defaultModelFor(rules) {
    const size = rules.board_size;
    const preset = findModel(app.defaults[rules.name]);
    if (preset && preset.size === size) return preset;
    const trained = app.models.find(m => Tafl.rulesEqual(m.rules, rules));
    if (trained) return trained;
    const chosen = findModel(app.modelBySize[size]);
    if (chosen && chosen.size === size) return chosen;
    return modelsForSize(size)[0] || null;
}

function modelNote(model) {
    if (!model) return 'No network model exists for this board size yet; the "NN + MCTS" AI is not available.';
    const d = model.desc;
    const s = modelSearchSettings(d);
    const parts = [
        d.network_description || '',
        d.iteration !== undefined && d.iteration !== null ? `training iteration ${d.iteration}` : '',
        `trained with ${rulesetTitle(model.rules)}`,
        `search: c_puct ${s.cPuct}, FPU ${s.fpuReduction}, discount ${s.discount}`,
    ];
    let text = parts.filter(Boolean).join('; ') + '.';
    if (model.note) text += ' ' + model.note;
    return text;
}

/** Make a model the AI of the current game (null for none) and load it in the worker. */
function selectModel(model) {
    app.model = model;
    app.modelError = null;
    app.msPerCall = null;
    app.searchParams = modelSearchSettings(model && model.desc);
    updateSearchControls();
    if (model) app.modelBySize[model.size] = model.id;
    if (!model || !client) {
        app.modelState = model && !client ? 'error' : 'none';
        if (model && !client) app.modelError = 'the search worker could not start (open the page through a web server)';
        updateInfo();
        return;
    }
    app.modelState = 'loading';
    updateInfo();
    // Whatever the AI or the analysis was doing used the old model
    invalidate();
    client.loadModel(model.id, model.onnx, model.desc).then((result) => {
        if (app.model !== model) return;
        app.modelState = 'ready';
        app.msPerCall = result.msPerCall;
        console.log(`[Models] ${model.id}: inputs ${result.inputNames}, outputs ${result.outputNames}, ` +
            `${result.msPerCall.toFixed(2)} ms per network call`);
        updateInfo();
        onPositionChanged();
    }).catch((error) => {
        if (app.model !== model) return;
        app.modelState = 'error';
        app.modelError = error.message;
        console.error(`[Models] Loading ${model.id} failed:`, error);
        updateInfo();
        onPositionChanged();
    });
}

// ----------------------------------------------------------------------------------------------
// Game flow
// ----------------------------------------------------------------------------------------------

const currentSide = () => SIDES[app.game.currentPlayer];
const isAITurn = () => !app.game.gameOver && app.players[currentSide()].type !== 'human';
// Whether the player to move is the NN + MCTS AI, whose own search then feeds the eval bar and suggestions
const aiSearchesNow = () => isAITurn() && app.players[currentSide()].type === 'mcts' && app.modelState === 'ready';
const toAttackerView = (value) => (app.game.currentPlayer === ATTACKER_PLAYER ? value : -value);

function newGame(rules, model) {
    app.epoch++;
    app.animating = false;
    removeFloatingPieces();
    app.rules = Tafl.normalizeRules(rules);
    app.size = app.rules.board_size;
    app.game = new TaflGame(app.rules);
    app.game.keepBoards = KEEP_BOARDS;
    app.history = [];
    app.lastMove = null;
    app.selected = -1;
    document.title = rulesetTitle(app.rules);
    buildBoard();
    updatePlayerOptions();
    updateHelp();
    // A model that failed to load gets another try with every new game
    if (model !== app.model || app.modelState === 'error') selectModel(model);
    updateInfo();
    savePrefs();
    onPositionChanged();
}

/** Stop everything that works on the current position (AI search, analysis). */
function invalidate() {
    app.token++;
    if (client) client.cancel();
    app.analysisJobs = [];
    setThinking(false);
}

/** After every change of position (or of who plays): show it, then let the AI move or analyse. */
function onPositionChanged() {
    if (app.animating) return;  // playMove calls this when its animation is done
    invalidate();
    const token = app.token;
    app.selected = -1;
    app.analysis = { stats: null, nn: null };
    render();
    clearSuggestions();
    updateTurnLabels();
    updateButtons();
    if (app.game.gameOver) {
        showGameOver();
        return;
    }
    hideOverlay();
    resetEval();
    startAnalysis(token, aiSearchesNow());
    if (isAITurn()) {
        const bothAI = SIDES.every(s => app.players[s].type !== 'human');
        setTimeout(() => runAI(token), bothAI ? 300 : 30);
    }
}

async function runAI(token) {
    if (token !== app.token || app.animating || !isAITurn()) return;
    const config = app.players[currentSide()];
    let move = null;
    if (config.type === 'minimax' && app.size === 7) {
        if (!cppReady) {
            setTimeout(() => runAI(token), 200);
            return;
        }
        setThinking(true);
        await nextPaint();
        if (token !== app.token) return;
        move = runMinimax(app.game, config.depth).move;
        if (!app.game.isLegalMove(move)) {
            // It knows only the old Brandubh rules; this one is forbidden here (the throne, say)
            console.warn(`[AI] Minimax chose ${Tafl.moveName(app.size, move)}, which these rules forbid`);
            const legal = app.game.legalMoves();
            move = legal[Math.floor(Math.random() * legal.length)];
            showStatus('Minimax chose a move these rules forbid; it played a random move instead.', false, 5000);
        }
    } else if (config.type === 'mcts' && app.modelState === 'loading') {
        // The model's arrival calls onPositionChanged, which starts the AI again
        setThinking(true);
        return;
    } else if (config.type === 'mcts' && app.modelState === 'ready') {
        setThinking(true);
        const job = client.search(app.game, { ...app.searchParams, sims: config.sims, progressMs: 200 }, (stats) => {
            if (token === app.token) showSearchStats(stats);
        });
        let result = null;
        try {
            result = await job.promise;
        } catch (error) {
            console.error('[AI] Search failed:', error);
            showStatus(`The AI's search failed: ${error.message}`, true);
        }
        if (token !== app.token) return;
        if (result && (result.cancelled || result.stopped)) return;
        if (result) {
            showSearchStats(result.stats);
            move = chooseMove(result.stats.children, app.temperature);
        }
    }
    if (token !== app.token) return;
    setThinking(false);
    if (move === null) move = fallbackMove();
    if (move !== null) await playMove(move);
}

/** A move when the chosen AI cannot play: Minimax on 7x7 if it gives a legal move, else random. */
function fallbackMove() {
    const legal = app.game.legalMoves();
    if (legal.length === 0) return null;
    if (app.size === 7 && cppReady) {
        const { move } = runMinimax(app.game, 3);
        if (app.game.isLegalMove(move)) {
            showStatus('No network available: the AI plays with Minimax instead.', true);
            return move;
        }
    }
    showStatus('No network available: the AI plays random moves.', true);
    return legal[Math.floor(Math.random() * legal.length)];
}

/** Make a move on the board; `slide` animates the piece to its square (not after a drag and drop). */
async function playMove(move, { slide = true } = {}) {
    if (app.animating || app.game.gameOver) return;
    const epoch = app.epoch;
    app.animating = true;
    invalidate();
    app.selected = -1;
    clearSuggestions();
    render();
    const from = moveFrom(move), to = moveTo(move);
    if (slide) await slidePiece(from, to, PIECE_GLYPHS[app.game.board[from]]);
    if (epoch !== app.epoch) return;
    app.history.push({ game: app.game.clone(), lastMove: app.lastMove });
    const before = app.game.board.slice();
    const captured = app.game.makeMove(move);
    app.lastMove = move;
    render();
    flashLastMove();
    if (captured.length) {
        await fadeOutPieces(captured.map(sq => [sq, PIECE_GLYPHS[before[sq]]]));
        if (epoch !== app.epoch) return;
    }
    app.animating = false;
    onPositionChanged();
}

function undo() {
    if (app.history.length === 0) return;
    app.epoch++;
    app.animating = false;
    removeFloatingPieces();
    // Go back to the last position where a human was to move (unless nobody is human)
    const anyHuman = SIDES.some(s => app.players[s].type === 'human');
    do {
        const entry = app.history.pop();
        app.game = entry.game;
        app.lastMove = entry.lastMove;
    } while (app.history.length && anyHuman && app.players[currentSide()].type !== 'human');
    flashLastMove();
    onPositionChanged();
}

// ----------------------------------------------------------------------------------------------
// Board display and input
// ----------------------------------------------------------------------------------------------

function buildBoard() {
    const N = app.size;
    const { isCorner, throneSq } = app.game;  // corners only where the king escapes to one
    boardTable.style.setProperty('--n', N);
    boardEl.innerHTML = '';
    app.cells = [];
    for (let r = 0; r < N; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < N; c++) {
            const sq = r * N + c;
            const td = document.createElement('td');
            td.dataset.sq = sq;
            td.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');
            if (isCorner[sq]) td.classList.add('corner');
            if (sq === throneSq) td.classList.add('throne');
            td.title = Tafl.squareName(N, sq);
            const piece = document.createElement('span');
            piece.className = 'piece';
            td.appendChild(piece);
            tr.appendChild(td);
            app.cells.push({ td, piece });
        }
        boardEl.appendChild(tr);
    }
}

function render() {
    const g = app.game;
    const targets = new Set(app.selected >= 0 ? g.legalMovesFrom(app.selected).map(moveTo) : []);
    for (let sq = 0; sq < app.cells.length; sq++) {
        const { td, piece } = app.cells[sq];
        const p = g.board[sq];
        piece.textContent = PIECE_GLYPHS[p] || '';
        td.classList.toggle('attacker', p === ATTACKER);
        td.classList.toggle('defender', p === DEFENDER);
        td.classList.toggle('king', p === KING);
        td.classList.toggle('selected', sq === app.selected);
        td.classList.toggle('legal-move', targets.has(sq));
    }
    boardEl.className = currentSide() + (isAITurn() ? ' ai-turn' : '');
}

/** Light up the two squares of the last move; the highlight fades out by itself (styles.css). */
function flashLastMove() {
    for (const { td } of app.cells) td.classList.remove('last-move');
    if (app.lastMove === null) return;
    // Force a style recalculation, so a square that had the highlight already starts it again
    void boardEl.offsetWidth;
    app.cells[moveFrom(app.lastMove)].td.classList.add('last-move');
    app.cells[moveTo(app.lastMove)].td.classList.add('last-move');
}

function onCellClick(sq) {
    const g = app.game;
    if (app.animating || g.gameOver || isAITurn()) return;
    if (app.selected >= 0 && sq !== app.selected && !g.isOwnPiece(sq)) {
        const move = encodeMove(app.selected, sq);
        if (g.isLegalMove(move)) {
            playMove(move);
            return;
        }
    }
    app.selected = (sq !== app.selected && g.isOwnPiece(sq)) ? sq : -1;
    render();
    renderSuggestions();
}

// --- Board input through pointer events, the same for mouse, touch and pen. A press that moves
// less than a few pixels is a click (onCellClick); a press on an own piece that moves further drags
// it. The page does not rely on the browser's click events, which touch screens may delay or drop.

const DRAG_THRESHOLD_PX = 6;
let press = null;  // {pointerId, sq, x, y, token, canDrag, moved, dragging, ghost, size, over}

function squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const td = el && el.closest('#board td');
    return td ? Number(td.dataset.sq) : -1;
}

function onPointerDown(event) {
    if (press || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const td = event.target.closest('td');
    if (!td) return;
    const sq = Number(td.dataset.sq);
    press = {
        pointerId: event.pointerId, sq, x: event.clientX, y: event.clientY, token: app.token,
        canDrag: !app.animating && !app.game.gameOver && !isAITurn() && app.game.isOwnPiece(sq),
        moved: false, dragging: false, ghost: null, size: 0, over: -1,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (!press.dragging) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
        press.moved = true;
        if (!press.canDrag || press.token !== app.token || app.animating) return;
        startDrag(event);
    }
    press.ghost.style.left = `${event.clientX - press.size / 2}px`;
    press.ghost.style.top = `${event.clientY - press.size / 2}px`;
    // Mark the square under the pointer when the piece may go there
    const sq = squareAt(event.clientX, event.clientY);
    const over = sq >= 0 && app.game.isLegalMove(encodeMove(press.sq, sq)) ? sq : -1;
    if (over !== press.over) {
        if (press.over >= 0) app.cells[press.over].td.classList.remove('drag-over');
        if (over >= 0) app.cells[over].td.classList.add('drag-over');
        press.over = over;
    }
}

function startDrag(event) {
    press.dragging = true;
    const { td } = app.cells[press.sq];
    // Keep receiving this pointer's events wherever it goes
    try { td.setPointerCapture(event.pointerId); } catch (e) { /* the window listeners still work */ }
    app.selected = press.sq;
    render();
    renderSuggestions();
    td.classList.add('drag-source');
    document.body.classList.add('dragging');
    const rect = td.getBoundingClientRect();
    press.size = rect.width;
    const ghost = document.createElement('div');
    ghost.className = 'moving-piece dragged-piece';
    ghost.textContent = PIECE_GLYPHS[app.game.board[press.sq]];
    Object.assign(ghost.style, {
        width: `${rect.width}px`, height: `${rect.height}px`, fontSize: getComputedStyle(td).fontSize,
    });
    document.body.appendChild(ghost);
    press.ghost = ghost;
}

function onPointerUp(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    const { sq: from, moved, dragging, token } = press;
    const to = dragging ? squareAt(event.clientX, event.clientY) : -1;
    endPress();
    if (!dragging) {
        if (!moved) onCellClick(from);
        return;
    }
    const move = encodeMove(from, to);
    if (to >= 0 && token === app.token && !app.animating && app.game.isLegalMove(move)) {
        playMove(move, { slide: false });
        return;
    }
    // Dropped elsewhere: the piece goes back and stays selected, so a click can still move it
    render();
    renderSuggestions();
}

function onPointerCancel(event) {
    if (press && event.pointerId === press.pointerId) {
        endPress();
        render();
    }
}

function endPress() {
    if (!press) return;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (press.ghost) press.ghost.remove();
    boardEl.querySelectorAll('.drag-source, .drag-over').forEach(td => td.classList.remove('drag-source', 'drag-over'));
    document.body.classList.remove('dragging');
    press = null;
}

function cellRect(sq) {
    return app.cells[sq].td.getBoundingClientRect();
}

function slidePiece(from, to, glyph) {
    return new Promise((resolve) => {
        const a = cellRect(from), b = cellRect(to);
        const floating = document.createElement('div');
        floating.className = 'moving-piece';
        floating.textContent = glyph;
        Object.assign(floating.style, {
            left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`,
            fontSize: getComputedStyle(app.cells[from].td).fontSize,
        });
        document.body.appendChild(floating);
        app.cells[from].piece.textContent = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            floating.style.left = `${b.left}px`;
            floating.style.top = `${b.top}px`;
        }));
        setTimeout(() => {
            floating.remove();
            resolve();
        }, SLIDE_MS);
    });
}

function fadeOutPieces(list) {
    const spans = list.map(([sq, glyph]) => {
        const span = document.createElement('span');
        span.className = 'piece fading';
        span.textContent = glyph;
        app.cells[sq].td.appendChild(span);
        return span;
    });
    return new Promise((resolve) => setTimeout(() => {
        spans.forEach(s => s.remove());
        resolve();
    }, FADE_MS));
}

function removeFloatingPieces() {
    endPress();
    document.querySelectorAll('.moving-piece, #board .piece.fading').forEach(el => el.remove());
}

// Time for the browser to paint (a timer, not requestAnimationFrame, which stops in background tabs)
const nextPaint = () => new Promise(resolve => setTimeout(resolve, 30));

// ----------------------------------------------------------------------------------------------
// Evaluation and move suggestions
// ----------------------------------------------------------------------------------------------

/**
 * Start what the eval bar and the suggestions need for the current position. When the NN + MCTS
 * AI is to move (aiSearches), its own search feeds them, so no separate search is started.
 */
function startAnalysis(token, aiSearches) {
    const g = app.game;
    const wantNN = app.evalMode === 'nn' || app.policyMode === 'nn';
    const wantMCTS = !aiSearches && (app.evalMode === 'nn-mcts' || app.policyMode === 'nn-mcts');
    if (app.evalMode === 'heuristic') {
        setTimeout(() => {
            if (token === app.token && !app.animating) heuristicEval(token);
        }, 50);
    }
    const needsModel = wantNN || wantMCTS || (aiSearches && app.evalMode === 'nn-mcts');
    if (app.modelState !== 'ready') {
        if (needsModel && (app.evalMode === 'nn' || app.evalMode === 'nn-mcts')) {
            setEval(null, app.modelState === 'loading' ? 'loading the model…' : 'no network for this board');
        }
        return;
    }
    if (wantNN) {
        const job = client.evaluate(g);
        app.analysisJobs.push(job.id);
        job.promise.then((res) => {
            if (token !== app.token || res.cancelled) return;
            app.analysis.nn = res.result;
            if (app.evalMode === 'nn') setEval(toAttackerView(res.result.value), 'network');
            if (app.policyMode === 'nn') renderSuggestions();
        }).catch(error => console.error('[Analysis] Network evaluation failed:', error));
    }
    if (wantMCTS) {
        if (app.evalMode === 'nn-mcts') setEval(null, 'searching…');
        const params = {
            ...app.searchParams,
            sims: app.continuous ? 0 : app.analysisSims,
            maxSims: MAX_ANALYSIS_SIMS[app.size],
            progressMs: 250,
        };
        const job = client.search(g, params, (stats) => {
            if (token === app.token && app.analysisJobs.includes(job.id)) showSearchStats(stats);
        });
        app.analysisJobs.push(job.id);
        job.promise.then((res) => {
            if (token !== app.token || res.cancelled || !app.analysisJobs.includes(job.id)) return;
            showSearchStats(res.stats, res.limitReached ? ' (limit)' : '');
        }).catch(error => console.error('[Analysis] Search failed:', error));
    }
}

/** Restart the analysis after a display setting changed, without disturbing a thinking AI. */
function refreshAnalysis() {
    updateEvalVisibility();
    if (app.animating || app.game.gameOver) return;
    if (aiSearchesNow()) {
        if (app.evalMode === 'nn-mcts') {
            if (app.analysis.stats) showSearchStats(app.analysis.stats);
            else setEval(null, 'searching…');
        }
        startAnalysisExtras();
        renderSuggestions();
        return;
    }
    if (client && app.analysisJobs.length) client.cancel(app.analysisJobs);
    app.analysisJobs = [];
    app.analysis = { stats: null, nn: null };
    clearSuggestions();
    resetEval();
    startAnalysis(app.token, false);
}

/** On an AI's turn: the network or heuristic evaluation, if the eval bar or suggestions show one. */
function startAnalysisExtras() {
    const token = app.token;
    if (app.evalMode === 'heuristic') heuristicEval(token);
    if (app.evalMode !== 'nn' && app.policyMode !== 'nn') return;
    const show = (result) => {
        if (app.evalMode === 'nn') setEval(toAttackerView(result.value), 'network');
        if (app.policyMode === 'nn') renderSuggestions();
    };
    if (app.analysis.nn) {
        show(app.analysis.nn);
    } else if (app.modelState === 'ready') {
        const job = client.evaluate(app.game);
        app.analysisJobs.push(job.id);
        job.promise.then((res) => {
            if (token !== app.token || res.cancelled) return;
            app.analysis.nn = res.result;
            show(res.result);
        }).catch(error => console.error('[Analysis] Network evaluation failed:', error));
    }
}

function showSearchStats(stats, suffix = '') {
    app.analysis.stats = stats;
    if (app.evalMode === 'nn-mcts') setEval(toAttackerView(stats.value), `${stats.visits} visits${suffix}`);
    if (app.policyMode === 'nn-mcts') renderSuggestions();
}

function heuristicEval(token) {
    if (app.size !== 7) {
        setEval(null, 'heuristics: Brandubh only');
        return;
    }
    if (!cppReady) {
        setTimeout(() => token === app.token && heuristicEval(token), 200);
        return;
    }
    const { eval: value } = runMinimax(app.game, 4);
    if (token === app.token) setEval(toAttackerView(value), 'heuristics, depth 4');
}

function updateEvalVisibility() {
    $('AI-eval').classList.toggle('hidden', app.evalMode === 'off');
}

function resetEval() {
    setEval(null, '');
}

/** Show an evaluation from the attackers' side (+1 attackers win), or null for none. */
function setEval(value, detail) {
    updateEvalVisibility();
    const valueEl = $('eval-value');
    const bar = $('eval-bar');
    if (value === null || value === undefined || Number.isNaN(value)) {
        valueEl.textContent = '–';
        bar.style.left = '50%';
    } else {
        // The heuristics use a wider scale than the network's [-1, 1]
        valueEl.textContent = value > 5 ? 'attackers winning' : value < -5 ? 'defenders winning' : value.toFixed(2);
        bar.style.left = `${((Math.max(-1, Math.min(1, value)) + 1) / 2) * 100}%`;
    }
    $('eval-detail').textContent = detail || '';
}

function clearSuggestions() {
    boardEl.querySelectorAll('.policy-overlay').forEach(el => el.remove());
}

/**
 * Move suggestions: with a piece selected, the share of each of its moves; otherwise each piece's
 * share of all moves. With a search, also the best value for the side to move.
 */
function renderSuggestions() {
    clearSuggestions();
    if (app.policyMode === 'off' || app.game.gameOver) return;
    let entries;
    if (app.policyMode === 'nn-mcts') {
        if (!app.analysis.stats) return;
        entries = app.analysis.stats.children.map(c => ({ move: c.move, weight: c.visits, q: c.q }));
    } else {
        if (!app.analysis.nn) return;
        entries = app.analysis.nn.children.map(c => ({ move: c.move, weight: c.prior, q: null }));
    }
    const total = entries.reduce((sum, e) => sum + e.weight, 0);
    if (total <= 0) return;
    const shown = new Map();  // square -> {weight, q}
    for (const e of entries) {
        const from = moveFrom(e.move);
        let sq;
        if (app.selected >= 0) {
            if (from !== app.selected) continue;
            sq = moveTo(e.move);
        } else {
            sq = from;
        }
        const s = shown.get(sq) || { weight: 0, q: null };
        s.weight += e.weight;
        if (e.q !== null && e.weight > 0 && (s.q === null || e.q > s.q)) s.q = e.q;
        shown.set(sq, s);
    }
    for (const [sq, s] of shown) {
        const share = (s.weight / total) * 100;
        if (share < 0.5) continue;
        const overlay = document.createElement('div');
        overlay.className = 'policy-overlay';
        const q = s.q === null ? '' : `${s.q >= 0 ? '+' : ''}${s.q.toFixed(1)} `;
        overlay.textContent = q ? `${q}(${Math.round(share)}%)` : `${Math.round(share)}%`;
        app.cells[sq].td.appendChild(overlay);
    }
}

// ----------------------------------------------------------------------------------------------
// Minimax AI (C++/WebAssembly, Brandubh only)
// ----------------------------------------------------------------------------------------------

/**
 * Ask the C++ Minimax for a move and its evaluation (for the player to move). It knows only one
 * Brandubh rule set, so callers check its move against the engine.
 */
function runMinimax(game, depth) {
    const size = game.board.length;
    const pointers = Array.from({ length: 5 }, () => Module._malloc(4));
    const boardPtr = Module._malloc(size * 4);
    try {
        new Int32Array(Module.HEAP32.buffer, boardPtr, size).set(game.board);
        const player = game.currentPlayer === ATTACKER_PLAYER ? 1 : -1;
        Module._AI_web_get_move(...pointers, boardPtr, player, depth);
        // Read through fresh views: the call may have grown (and replaced) the memory buffer
        const value = new Float32Array(Module.HEAP32.buffer, pointers[0], 1)[0];
        const [fromX, fromY, toX, toY] = pointers.slice(1).map(p => new Int32Array(Module.HEAP32.buffer, p, 1)[0]);
        const N = game.N;
        return { move: encodeMove(fromY * N + fromX, toY * N + toX), eval: value };
    } finally {
        pointers.forEach(p => Module._free(p));
        Module._free(boardPtr);
    }
}

// ----------------------------------------------------------------------------------------------
// Labels, panels and controls
// ----------------------------------------------------------------------------------------------

let thinkingTimer = null;

function setSideLabel(i, type) {
    const label = $(`${SIDES[i]}-label`);
    label.querySelector('.side-name').textContent = `${SIDE_NAMES[i]}:`;
    label.querySelector('.side-type').textContent = type;
}

function updateTurnLabels() {
    SIDES.forEach((side, i) => {
        setSideLabel(i, app.players[side].type === 'human' ? 'Human' : 'AI');
        $(`${side}-label`).classList.toggle('active-player', !app.game.gameOver && app.game.currentPlayer === i);
    });
}

function setThinking(on) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    if (!app.game) return;
    updateTurnLabels();
    if (!on) return;
    const i = app.game.currentPlayer;
    let dots = 0;
    const draw = () => setSideLabel(i, `AI${'.'.repeat(1 + (dots++ % 3))}`);
    draw();
    thinkingTimer = setInterval(draw, 400);
}

function showGameOver() {
    const g = app.game;
    const winner = g.winner === null ? null : g.winner === ATTACKER_PLAYER ? 'Attackers' : 'Defenders';
    const loser = g.winner === ATTACKER_PLAYER ? 'defenders' : 'attackers';
    const count = app.rules.repetition_count;
    const reason = {
        escape: `The king escaped to ${app.rules.king_goal === 'corner' ? 'a corner' : 'the edge'}.`,
        capture: 'The king was captured.',
        exit_fort: 'The king is in an exit fort that cannot be broken.',
        encirclement: 'The attackers have encircled every defender.',
        repetition: `The same position occurred for the ${ordinal(count)} time.`,
        no_moves: `The ${loser} cannot move.`,
    }[g.endReason] || '';
    $('winMessage').innerHTML = `${winner ? `${winner} win!` : 'Draw!'}<small>${reason} Click to see the board.</small>`;
    $('overlay').classList.remove('hidden');
    setEval(g.winner === null ? 0 : g.winner === ATTACKER_PLAYER ? 1 : -1, 'game over');
}

function hideOverlay() {
    $('overlay').classList.add('hidden');
}

let statusTimer = null;

function showStatus(text, isError = false, ms = 8000) {
    const el = $('status-line');
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(statusTimer);
    if (ms) statusTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/** The line above the board: variant, rules, model, and a warning if the model's rules differ. */
function updateInfo() {
    $('variant-label').textContent = `${rulesetTitle(app.rules)} ${app.size}×${app.size}`;
    $('rules-label').textContent = rulesSummary(app.rules);
    let modelText;
    if (!app.model) modelText = 'no network model for this board size';
    else {
        modelText = `AI: ${app.model.name}`;
        if (app.modelState === 'loading') modelText += ' (loading…)';
        if (app.modelState === 'error') modelText += ' (failed to load)';
    }
    $('model-label').textContent = `· ${modelText}`;
    const warning = $('model-warning');
    const diffs = app.model ? rulesDifferences(app.rules, app.model.rules) : [];
    warning.classList.toggle('hidden', diffs.length === 0);
    warning.textContent = diffs.length
        ? `⚠ The model was trained with ${rulesetTitle(app.model.rules)}: ${diffs.join(', ')}.` : '';
    if (app.modelState === 'error') showStatus(`The model failed to load: ${app.modelError}`, true, 0);
    else if (app.modelState === 'ready' && $('status-line').classList.contains('error')) $('status-line').classList.add('hidden');
    fillModelSelect($('model-select'), app.size, app.model);
    const note = modelNote(app.model) + (app.msPerCall ? ` One network call takes ${app.msPerCall.toFixed(1)} ms here.` : '');
    $('model-note').textContent = note;
}

function updateHelp() {
    const list = $('rules-text');
    list.innerHTML = '';
    for (const text of rulesList(app.rules)) {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
    }
}

function updateButtons() {
    $('undo-btn').disabled = app.history.length === 0;
}

function fillModelSelect(select, size, selected) {
    const models = modelsForSize(size);
    select.innerHTML = '';
    if (models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No model for this board size';
        select.appendChild(option);
        select.disabled = true;
        return;
    }
    select.disabled = false;
    for (const m of models) {
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = `${m.name} (${rulesetTitle(m.rules)})`;
        select.appendChild(option);
    }
    select.value = selected && selected.size === size ? selected.id : models[0].id;
}

function updatePlayerOptions() {
    const hasModel = modelsForSize(app.size).length > 0 && client !== null;
    for (const side of SIDES) {
        const select = $(`${side}-type`);
        const config = app.players[side];
        const mcts = select.querySelector('option[value="mcts"]');
        const minimax = select.querySelector('option[value="minimax"]');
        mcts.disabled = !hasModel;
        mcts.textContent = hasModel ? 'AI: NN + MCTS' : 'AI: NN + MCTS (no model)';
        minimax.disabled = app.size !== 7;
        minimax.textContent = app.size === 7 ? 'AI: Minimax' : 'AI: Minimax (7×7 only)';
        if (config.type === 'minimax' && app.size !== 7) config.type = hasModel ? 'mcts' : 'human';
        if (config.type === 'mcts' && !hasModel) config.type = 'human';
        select.value = config.type;
        updateDifficultyVisibility(side);
    }
    const heuristic = $('eval-mode-select').querySelector('option[value="heuristic"]');
    heuristic.disabled = app.size !== 7;
    heuristic.textContent = app.size === 7 ? 'Heuristics' : 'Heuristics (7×7 only)';
    if (app.evalMode === 'heuristic' && app.size !== 7) app.evalMode = 'nn-mcts';
    $('eval-mode-select').value = app.evalMode;
}

function updateDifficultyVisibility(side) {
    const type = app.players[side].type;
    $(`${side}-mcts-difficulty-container`).classList.toggle('hidden', type !== 'mcts');
    $(`${side}-minimax-difficulty-container`).classList.toggle('hidden', type !== 'minimax');
}

function updateSearchControls() {
    const p = app.searchParams;
    $('cpuct-slider').value = p.cPuct;
    $('cpuct-value').textContent = p.cPuct.toFixed(2);
    $('fpu-reduction-slider').value = p.fpuReduction;
    $('fpu-reduction-value').textContent = p.fpuReduction.toFixed(2);
    $('discount-slider').value = p.discount;
    $('discount-value').textContent = p.discount.toFixed(3);
}

function openPanel(id) {
    for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('hidden', panel.id !== id || !panel.classList.contains('hidden'));
    }
}

function closePanels() {
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
}

// --- New game panel ---

const newGameForm = {
    size: () => Number($('ng-variant').value),
    rules: () => RULESETS[$('ng-ruleset').value],
    model: () => findModel($('ng-model').value),
};

function fillRulesetSelect(size, selected) {
    const select = $('ng-ruleset');
    select.innerHTML = '';
    for (const rules of Object.values(RULESETS)) {
        if (rules.board_size !== size) continue;
        const option = document.createElement('option');
        option.value = rules.name;
        option.textContent = rulesetTitle(rules);
        select.appendChild(option);
    }
    select.value = selected && selected.board_size === size ? selected.name : DEFAULT_RULESETS[size];
}

function openNewGamePanel() {
    $('ng-variant').value = String(app.size);
    fillRulesetSelect(app.size, app.rules);
    fillModelSelect($('ng-model'), app.size, app.model);
    updateNewGamePanel();
    openPanel('newGameText');
}

function updateNewGamePanel() {
    const rules = newGameForm.rules();
    const model = newGameForm.model();
    const info = RULESET_INFO[rules.name];
    $('ng-ruleset-note').textContent = `${rules.description}: ${rulesSummary(rules)}.` +
        (info ? ` Defenders win ${info.defenders} human games.` : '');
    $('ng-model-note').textContent = modelNote(model);
    const diffs = model ? rulesDifferences(rules, model.rules) : [];
    const warning = $('ng-warning');
    warning.classList.toggle('hidden', diffs.length === 0);
    warning.textContent = diffs.length
        ? `This model was trained with ${rulesetTitle(model.rules)} (${diffs.join(', ')}). It will play, but not as well.` : '';
}

// On phones the player and analysis menus move into the Settings panel, so the board, the players
// and one row of buttons fit on the screen. The same elements move, so their handlers stay.
const phoneLayout = window.matchMedia('(max-width: 768px)');

function placePlayOptions() {
    const options = $('play-options');
    if (phoneLayout.matches) $('settings-play-slot').appendChild(options);
    else $('buttons-container').insertBefore(options, $('help-container'));
}

// ----------------------------------------------------------------------------------------------
// Preferences (kept in this browser only)
// ----------------------------------------------------------------------------------------------

function loadPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function savePrefs() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            ruleset: app.rules.name,
            modelBySize: app.modelBySize,
            players: app.players,
            evalMode: app.evalMode,
            policyMode: app.policyMode,
            temperature: app.temperature,
            analysisSims: app.analysisSims,
            continuous: app.continuous,
        }));
    } catch (e) {
        // Private windows and blocked storage: nothing is remembered, which is fine
    }
}

function applyPrefs(prefs) {
    for (const side of SIDES) {
        const p = prefs.players && prefs.players[side];
        if (!p) continue;
        if (['human', 'mcts', 'minimax'].includes(p.type)) app.players[side].type = p.type;
        if (Number.isFinite(p.sims)) app.players[side].sims = p.sims;
        if (Number.isFinite(p.depth)) app.players[side].depth = p.depth;
    }
    if (['off', 'heuristic', 'nn', 'nn-mcts'].includes(prefs.evalMode)) app.evalMode = prefs.evalMode;
    if (['off', 'nn', 'nn-mcts'].includes(prefs.policyMode)) app.policyMode = prefs.policyMode;
    if (Number.isFinite(prefs.temperature)) app.temperature = prefs.temperature;
    if (Number.isFinite(prefs.analysisSims)) app.analysisSims = prefs.analysisSims;
    app.continuous = Boolean(prefs.continuous);
    if (prefs.modelBySize && typeof prefs.modelBySize === 'object') app.modelBySize = { ...prefs.modelBySize };

    for (const side of SIDES) {
        const p = app.players[side];
        $(`${side}-type`).value = p.type;
        $(`${side}-mcts-difficulty`).value = p.sims;
        $(`${side}-mcts-value`).textContent = p.sims;
        $(`${side}-minimax-difficulty`).value = p.depth;
        $(`${side}-minimax-value`).textContent = p.depth;
    }
    $('eval-mode-select').value = app.evalMode;
    $('policy-mode-select').value = app.policyMode;
    $('temperature-slider').value = app.temperature;
    $('temperature-value').textContent = app.temperature.toFixed(2);
    $('mcts-simulations-slider').value = app.analysisSims;
    $('mcts-simulations-value').textContent = app.analysisSims;
    $('continuous-eval-toggle').checked = app.continuous;
}

// ----------------------------------------------------------------------------------------------
// Event handlers
// ----------------------------------------------------------------------------------------------

function bindEvents() {
    // Presses are handled as pointer events (onPointerDown). Clicks without a pointer behind them
    // (detail 0: from scripts or assistive technology) still work.
    boardEl.addEventListener('click', (event) => {
        const td = event.target.closest('td');
        if (td && event.detail === 0) onCellClick(Number(td.dataset.sq));
    });
    boardEl.addEventListener('pointerdown', onPointerDown);
    boardEl.addEventListener('mousedown', (event) => event.preventDefault());

    for (const side of SIDES) {
        $(`${side}-type`).addEventListener('change', (event) => {
            app.players[side].type = event.target.value;
            updateDifficultyVisibility(side);
            savePrefs();
            onPositionChanged();
        });
        $(`${side}-mcts-difficulty`).addEventListener('input', (event) => {
            app.players[side].sims = Number(event.target.value);
            $(`${side}-mcts-value`).textContent = event.target.value;
            savePrefs();
        });
        $(`${side}-minimax-difficulty`).addEventListener('input', (event) => {
            app.players[side].depth = Number(event.target.value);
            $(`${side}-minimax-value`).textContent = event.target.value;
            savePrefs();
        });
    }

    $('eval-mode-select').addEventListener('change', (event) => {
        app.evalMode = event.target.value;
        savePrefs();
        resetEval();
        refreshAnalysis();
    });
    $('policy-mode-select').addEventListener('change', (event) => {
        app.policyMode = event.target.value;
        savePrefs();
        if (app.policyMode === 'off') clearSuggestions();
        refreshAnalysis();
    });

    $('undo-btn').addEventListener('click', undo);
    $('restart-btn').addEventListener('click', () => newGame(app.rules, app.model));
    $('new-game-btn').addEventListener('click', openNewGamePanel);
    $('help-btn').addEventListener('click', () => openPanel('helpText'));
    $('settings-btn').addEventListener('click', () => openPanel('settingsText'));
    document.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', () => $(el.dataset.close).classList.add('hidden'));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePanels();
    });
    $('overlay').addEventListener('click', hideOverlay);

    // New game panel
    $('ng-variant').addEventListener('change', () => {
        const size = newGameForm.size();
        fillRulesetSelect(size, null);
        fillModelSelect($('ng-model'), size, defaultModelFor(newGameForm.rules()));
        updateNewGamePanel();
    });
    $('ng-ruleset').addEventListener('change', () => {
        // Switch to a model trained with these rules if there is one; else keep the chosen model
        const rules = newGameForm.rules();
        const model = defaultModelFor(rules);
        if (model && Tafl.rulesEqual(model.rules, rules)) $('ng-model').value = model.id;
        updateNewGamePanel();
    });
    $('ng-model').addEventListener('change', updateNewGamePanel);
    $('ng-start').addEventListener('click', () => {
        closePanels();
        newGame(newGameForm.rules(), newGameForm.model());
    });

    // Settings panel
    $('model-select').addEventListener('change', (event) => {
        const model = findModel(event.target.value);
        if (model && model !== app.model) {
            selectModel(model);
            savePrefs();
        }
    });
    $('temperature-slider').addEventListener('input', (event) => {
        app.temperature = Number(event.target.value);
        $('temperature-value').textContent = app.temperature.toFixed(2);
        savePrefs();
    });
    $('mcts-simulations-slider').addEventListener('input', (event) => {
        $('mcts-simulations-value').textContent = event.target.value;
    });
    $('mcts-simulations-slider').addEventListener('change', (event) => {
        app.analysisSims = Number(event.target.value);
        savePrefs();
        refreshAnalysis();
    });
    $('continuous-eval-toggle').addEventListener('change', (event) => {
        app.continuous = event.target.checked;
        savePrefs();
        refreshAnalysis();
    });
    const searchSlider = (id, key, digits) => {
        $(`${id}-slider`).addEventListener('input', (event) => {
            app.searchParams[key] = Number(event.target.value);
            $(`${id}-value`).textContent = app.searchParams[key].toFixed(digits);
        });
        $(`${id}-slider`).addEventListener('change', refreshAnalysis);
    };
    searchSlider('cpuct', 'cPuct', 2);
    searchSlider('fpu-reduction', 'fpuReduction', 2);
    searchSlider('discount', 'discount', 3);
    $('reset-search').addEventListener('click', () => {
        app.searchParams = modelSearchSettings(app.model && app.model.desc);
        updateSearchControls();
        refreshAnalysis();
    });
}

// ----------------------------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------------------------

async function init() {
    placePlayOptions();
    phoneLayout.addEventListener('change', placePlayOptions);
    const prefs = loadPrefs();
    applyPrefs(prefs);
    bindEvents();
    if (!client) showStatus('The search worker could not start; open the page through a web server (python3 serve.py).', true, 0);
    try {
        await loadManifest();
    } catch (error) {
        console.error('[Models]', error);
        showStatus(`Could not load the model list: ${error.message}`, true, 0);
    }
    const rules = RULESETS[prefs.ruleset] || RULESETS[DEFAULT_RULESETS[7]];
    newGame(rules, defaultModelFor(rules));
}

init();
