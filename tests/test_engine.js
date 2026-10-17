#!/usr/bin/env node
/**
 * Replays the reference games of tests/make_reference_games.py in tafl.js and requires, for every
 * ply, the same board, player to move, legal moves (in the same order), input planes, and game
 * result as the Python engines.
 *
 * Usage: node tests/test_engine.js [reference files...]   (default: tests/reference/*.json.gz)
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
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.json.gz')) files.push(path.join(dir, f));
}

const boardString = (board) => Array.from(board).join('');
let failures = 0;
const MAX_REPORTS = 20;

function fail(where, message) {
    failures++;
    if (failures <= MAX_REPORTS) console.log(`FAIL ${where}: ${message}`);
}

function pseudoLegalCount(game) {
    // Legal moves ignoring the repetition rule (to count how often the rule removed moves)
    const g = game.clone();
    g.repHasDuplicate = false;
    g._legal = null;
    return g.legalMoves().length;
}

for (const file of files) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    const planes = Tafl.parsePlanes(data.planes);
    const stats = { games: 0, plies: 0, planeChecks: 0, captures: 0, repetitionPlies: 0, reasons: {} };
    const failuresBefore = failures;

    data.games.forEach((rec, gi) => {
        stats.games++;
        let game;
        if (rec.custom_start) {
            game = Tafl.TaflGame.fromBoard(rec.size, rec.rules, rec.start_board.split('').map(Number), rec.start_player);
        } else {
            game = new Tafl.TaflGame(rec.size, rec.rules);
            if (boardString(game.board) !== rec.start_board) fail(`${data.game} game ${gi}`, 'start position differs');
        }
        game.keepBoards = Tafl.historyNeeded(planes);

        for (let pi = 0; pi < rec.plies.length; pi++) {
            const ply = rec.plies[pi];
            const where = `${data.game} game ${gi} ply ${pi} rules ${JSON.stringify(rec.rules)}`;
            stats.plies++;
            if (boardString(game.board) !== ply.board) { fail(where, 'board differs'); break; }
            if (game.currentPlayer !== ply.player) { fail(where, 'player differs'); break; }
            if (game.gameOver) { fail(where, `JS says the game is over (winner ${game.winner})`); break; }

            const legal = game.legalMoves();
            if (legal.join(',') !== ply.legal.join(',')) {
                const js = new Set(legal), py = new Set(ply.legal);
                const missing = ply.legal.filter(m => !js.has(m)).map(m => Tafl.moveName(game.N, m));
                const extra = legal.filter(m => !py.has(m)).map(m => Tafl.moveName(game.N, m));
                fail(where, missing.length || extra.length
                    ? `legal moves differ: missing ${missing.join(' ')} extra ${extra.join(' ')}`
                    : 'legal moves in a different order');
                break;
            }
            if (pseudoLegalCount(game) > legal.length) stats.repetitionPlies++;

            if (ply.planes) {
                stats.planeChecks++;
                const x = Tafl.buildFeatures(game, planes);
                const NN = game.N * game.N;
                for (let p = 0; p < planes.length; p++) {
                    let s = '';
                    for (let sq = 0; sq < NN; sq++) s += x[p * NN + sq];
                    if (s !== ply.planes[p]) { fail(where, `plane ${planes[p].name} differs`); break; }
                }
            }

            const captured = game.makeMove(ply.move);
            stats.captures += captured.length;
            if (game.gameOver !== ply.game_over || game.winner !== ply.winner) {
                fail(where, `after the move: JS game_over=${game.gameOver} winner=${game.winner}, ` +
                    `Python game_over=${ply.game_over} winner=${ply.winner}`);
                break;
            }
        }

        const where = `${data.game} game ${gi} (final position)`;
        if (boardString(game.board) !== rec.final_board) fail(where, 'board differs');
        if (game.gameOver !== rec.game_over || game.winner !== rec.winner) {
            fail(where, `JS game_over=${game.gameOver} winner=${game.winner}, Python ${rec.game_over} ${rec.winner}`);
        }
        if (rec.final_legal && game.legalMoves().join(',') !== rec.final_legal.join(',')) {
            fail(where, 'legal moves of the final position differ');
        }
        const reason = game.endReason() || 'unfinished';
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    });

    const ok = failures === failuresBefore;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${data.game}: ${stats.games} games, ${stats.plies} plies, ` +
        `${stats.planeChecks} plane checks, ${stats.captures} captures, ` +
        `${stats.repetitionPlies} plies with moves removed by the repetition rule, ` +
        `endings ${JSON.stringify(stats.reasons)}`);
}

if (failures > MAX_REPORTS) console.log(`... ${failures - MAX_REPORTS} more failures`);
console.log(failures === 0 ? 'All reference games match.' : `${failures} failures.`);
process.exit(failures === 0 ? 0 : 1);
