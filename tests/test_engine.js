#!/usr/bin/env node
/**
 * Replays the reference games of tests/make_reference_games.py in tafl.js and requires, for every
 * move, the same board, player to move, legal moves (in the same order), input planes, and the
 * same position and result after the move as the Python engine.
 *
 * Random games are replayed from the start, so the incremental parts of the engine (position keys,
 * repetition counts, history planes) are checked too. The recorded moves of the rule positions of
 * test_rules.py are each rebuilt from the position before them, with its earlier positions. The
 * fuzz file has random positions for the exit fort test and for captures (shieldwalls among them),
 * with Python's verdict for each.
 *
 * Usage: node tests/test_engine.js [reference files...]   (default: all of tests/reference/)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Tafl = require('../tafl.js');

const files = process.argv.slice(2);
if (files.length === 0) {
    const dir = path.join(__dirname, 'reference');
    if (!fs.existsSync(dir)) {
        console.error('No reference games. Run tests/make_reference_games.py first.');
        process.exit(2);
    }
    for (const f of fs.readdirSync(dir).sort()) if (/^(reference|fuzz)_.*\.json\.gz$/.test(f)) files.push(path.join(dir, f));
}

const boardString = (board) => Array.from(board).join('');
const digits = (s) => s.split('').map(Number);
let failures = 0;
const MAX_REPORTS = 20;

function fail(where, message) {
    failures++;
    if (failures <= MAX_REPORTS) console.log(`FAIL ${where}: ${message}`);
    return false;
}

/** Compare the position before a move with the recorded one; false (and a report) on a difference. */
function checkBefore(game, ply, planes, where, stats) {
    if (boardString(game.board) !== ply.board) return fail(where, 'board differs');
    if (game.currentPlayer !== ply.player) return fail(where, 'player to move differs');
    if (game.gameOver) return fail(where, `JS says the game is over (${game.endReason})`);
    const legal = game.legalMoves();
    if (legal.join(',') !== ply.legal.join(',')) {
        const js = new Set(legal), py = new Set(ply.legal);
        const missing = ply.legal.filter(m => !js.has(m)).map(m => Tafl.moveName(game.N, m));
        const extra = legal.filter(m => !py.has(m)).map(m => Tafl.moveName(game.N, m));
        return fail(where, missing.length || extra.length
            ? `legal moves differ: missing ${missing.join(' ')} extra ${extra.join(' ')}`
            : 'legal moves in a different order');
    }
    stats.planeChecks++;
    const x = Tafl.buildFeatures(game, planes);
    const NN = game.N * game.N;
    for (let p = 0; p < planes.length; p++) {
        let s = '';
        for (let sq = 0; sq < NN; sq++) s += x[p * NN + sq];
        if (s !== ply.planes[p]) return fail(where, `plane ${planes[p].name} differs`);
    }
    return true;
}

function checkAfter(game, ply, where) {
    if (boardString(game.board) !== ply.board_after) return fail(where, 'board after the move differs');
    if (game.gameOver !== ply.game_over || game.winner !== ply.winner) {
        return fail(where, `after the move: JS game_over=${game.gameOver} winner=${game.winner} (${game.endReason}), ` +
            `Python game_over=${ply.game_over} winner=${ply.winner}`);
    }
    if (!game.gameOver && game.currentPlayer !== ply.player_after) return fail(where, 'player to move after the move differs');
    return true;
}

function checkFuzz(data, label) {
    const failuresBefore = failures;
    data.forts.forEach((rec, i) => {
        const game = Tafl.TaflGame.fromPosition(rec.rules, digits(rec.board), 1);
        if (game.isKingInExitFort() !== rec.fort) fail(`${label} fort ${i} (${rec.rules.name})`, `JS says ${!rec.fort}, Python ${rec.fort}`);
    });
    let walls = 0;
    data.captures.forEach((rec, i) => {
        const game = Tafl.TaflGame.fromPosition(rec.rules, digits(rec.board_after), 0);
        const { captured, kingCaptured } = game._findCaptures(rec.to);
        const js = [...new Set(captured)].sort((a, b) => a - b);
        if (js.join(',') !== rec.captured.join(',') || kingCaptured !== rec.king_captured) {
            fail(`${label} capture ${i} (${rec.rules.name}, to ${Tafl.squareName(game.N, rec.to)})`,
                `JS captures ${js.map(sq => Tafl.squareName(game.N, sq))} king ${kingCaptured}, ` +
                `Python ${rec.captured.map(sq => Tafl.squareName(game.N, sq))} king ${rec.king_captured}`);
        }
        if (rec.captured.length >= 2 && rec.rules.shieldwall) walls++;
    });
    const ok = failures === failuresBefore;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${data.forts.length} exit fort tests ` +
        `(${data.forts.filter(f => f.fort).length} forts), ${data.captures.length} capture tests (${walls} shieldwalls)`);
}

for (const file of files) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    if (data.forts) {
        checkFuzz(data, path.basename(file).replace(/\.json\.gz$/, ''));
        continue;
    }
    const planes = Tafl.parsePlanes(data.planes);
    const stats = { games: 0, plies: 0, planeChecks: 0, captures: 0, reasons: {} };
    const failuresBefore = failures;
    const label = path.basename(file).replace(/^reference_|\.json\.gz$/g, '');

    data.games.forEach((rec, gi) => {
        stats.games++;
        let game;
        if (rec.start !== undefined) {
            // A random game: replay it from the start
            game = new Tafl.TaflGame(rec.rules);
            if (boardString(game.board) !== rec.start || game.currentPlayer !== rec.start_player) {
                fail(`${label} game ${gi}`, 'start position or first player differs');
                return;
            }
            game.keepBoards = Tafl.historyNeeded(planes);
        }
        for (let pi = 0; pi < rec.plies.length; pi++) {
            const ply = rec.plies[pi];
            const where = `${label} game ${gi} (${rec.source}) ply ${pi}`;
            if (ply.history !== undefined) {
                // A recorded rule position: rebuild it with its earlier positions
                const history = ply.history.map(([b, player]) => ({ board: digits(b), player }));
                game = Tafl.TaflGame.fromPosition(rec.rules, digits(ply.board), ply.player, history);
            }
            stats.plies++;
            if (!checkBefore(game, ply, planes, where, stats)) return;
            stats.captures += game.makeMove(ply.move).length;
            if (!checkAfter(game, ply, where)) return;
        }
        if (game && game.gameOver) stats.reasons[game.endReason] = (stats.reasons[game.endReason] || 0) + 1;
    });

    const ok = failures === failuresBefore;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${stats.games} games, ${stats.plies} moves, ` +
        `${stats.planeChecks} plane checks, ${stats.captures} pieces captured, endings ${JSON.stringify(stats.reasons)}`);
}

if (failures > MAX_REPORTS) console.log(`... ${failures - MAX_REPORTS} more failures`);
console.log(failures === 0 ? 'All reference games match.' : `${failures} failures.`);
process.exit(failures === 0 ? 0 : 1);
