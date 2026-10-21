#!/usr/bin/env node
/**
 * Repeats the reference searches of tests/make_mcts_reference.py with mcts.js and the same ONNX
 * models (through onnxruntime-web, as in the browser), and compares the visit counts of every root
 * move with those of the Python MCTS.
 *
 * The two network runtimes differ in the last bits of float32, and Python computes the PUCT score
 * partly in float32, so a near-tie can now and then go the other way; a search counts as matching
 * when every visit count is within 2% of the simulations of Python's.
 *
 * It also compares the outputs only the page shows: the probabilities of the endings the rules
 * allow, and the plies left (NetworkEvaluator.evaluateAll).
 *
 * Usage: (cd tests && npm install) && node tests/test_mcts.js [tests/reference/mcts.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-web');
const Tafl = require('../tafl.js');
const { MCTS } = require('../mcts.js');
const { NetworkEvaluator, modelSearchSettings } = require('../network.js');

const REPO = path.join(__dirname, '..');
const file = process.argv[2] || path.join(__dirname, 'reference', 'mcts.json');

async function main() {
    ort.env.wasm.numThreads = 1;
    const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
    const evaluators = {};
    let exact = 0, close = 0, failed = 0;
    for (const c of cases) {
        if (!evaluators[c.model]) {
            const info = JSON.parse(fs.readFileSync(path.join(REPO, c.model + '.json'), 'utf8'));
            const session = await ort.InferenceSession.create(fs.readFileSync(path.join(REPO, c.model + '.onnx')));
            evaluators[c.model] = { info, evaluator: new NetworkEvaluator(ort, session, info, { cacheSize: 0 }) };
        }
        const { info, evaluator } = evaluators[c.model];
        const game = new Tafl.TaflGame(c.rules);
        for (const m of c.moves) game.makeMove(m);

        const params = modelSearchSettings(info);
        const mcts = new MCTS(evaluator.evaluate, params);
        mcts.reset(game);
        for (let i = 0; i < c.sims; i++) await mcts.simulate();
        const stats = mcts.stats();

        const where = `${c.model} after ${c.moves.length} moves`;
        const all = await evaluator.evaluateAll(game, game.legalMoves());
        const endingDiff = Math.max(...all.ending.map(e => Math.abs(e.p - c.ending[e.ending])));
        if (all.ending.map(e => e.ending).join() !== Object.keys(c.ending).join() || !(endingDiff < 1e-4) ||
            !(Math.abs(all.movesLeft - c.moves_left) < 1e-3 * Math.max(1, c.moves_left))) {
            console.log(`FAIL ${where}: endings ${JSON.stringify(all.ending)} moves left ${all.movesLeft}, ` +
                `Python ${JSON.stringify(c.ending)} ${c.moves_left}`);
            failed++;
            continue;
        }
        if (stats.children.map(ch => ch.move).join(',') !== c.children.join(',')) {
            console.log(`FAIL ${where}: root moves differ`);
            failed++;
            continue;
        }
        const visits = stats.children.map(ch => ch.visits);
        const maxDiff = Math.max(...visits.map((v, i) => Math.abs(v - c.visits[i])));
        const priorDiff = Math.max(...stats.children.map((ch, i) => Math.abs(ch.prior - c.priors[i])));
        const valueDiff = Math.abs(stats.value - c.root_value);
        if (maxDiff === 0) exact++;
        else if (maxDiff <= 0.02 * c.sims) close++;
        else failed++;
        const verdict = maxDiff === 0 ? 'same' : maxDiff <= 0.02 * c.sims ? 'close' : 'FAIL';
        console.log(`${verdict.padEnd(5)} ${where}: max visit difference ${maxDiff}, ` +
            `max prior difference ${priorDiff.toExponential(1)}, root value ${stats.value.toFixed(4)} ` +
            `(Python ${c.root_value.toFixed(4)}, difference ${valueDiff.toExponential(1)}), ` +
            `${all.movesLeft.toFixed(1)} plies left, endings within ${endingDiff.toExponential(1)}`);
    }
    console.log(`${cases.length} searches: ${exact} identical, ${close} within 2%, ${failed} different.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
