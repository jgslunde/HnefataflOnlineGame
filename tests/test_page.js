#!/usr/bin/env node
/**
 * End-to-end test of the page in headless Chrome: serves the repository, opens index.html and
 * plays through the main features on all three boards (the main menu, human moves, the NN + MCTS
 * AI, Minimax, undo, new games with other rules, eval bar and suggestions), failing on any error in the page or
 * the search worker. Screenshots go to tests/screenshots/.
 *
 * Needs Node 22 or newer (built-in WebSocket) and Chrome or Chromium; the page loads
 * onnxruntime-web from the jsdelivr CDN, so it needs internet access too.
 *
 * Usage: node tests/test_page.js   (CHROME=/path/to/chrome to pick the browser)
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const CHROME = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser']
    .map(name => process.env.PATH.split(':').map(dir => path.join(dir, name)).find(p => fs.existsSync(p)))
    .find(Boolean);

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serve() {
    const server = http.createServer((req, res) => {
        const file = path.join(REPO, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Browser {
    async launch() {
        this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tafl-chrome-'));
        this.proc = spawn(CHROME, [
            '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
            `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--window-size=1400,1000',
            'about:blank',
        ], { stdio: 'ignore' });
        const portFile = path.join(this.profile, 'DevToolsActivePort');
        for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
        const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        this.ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
        await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = [];
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            } else if (msg.method) {
                for (const listener of this.listeners) listener(msg);
            }
        };
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
    }

    close() {
        try { this.ws.close(); } catch (e) { /* closed */ }
        this.proc.kill();
        try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) { /* in use */ }
    }
}

async function main() {
    if (!CHROME) throw new Error('No Chrome found; set CHROME=/path/to/chrome');
    fs.mkdirSync(SHOTS, { recursive: true });
    const server = await serve();
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const browser = new Browser();
    await browser.launch();
    const errors = [];
    const logs = [];
    let page;
    try {
        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
        page = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
        browser.listeners.push((msg) => {
            if (msg.method === 'Target.attachedToTarget') {
                // The search worker: collect its console and errors too
                browser.send('Runtime.enable', {}, msg.params.sessionId).catch(() => {});
                browser.send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId).catch(() => {});
            } else if (msg.method === 'Runtime.consoleAPICalled') {
                const text = msg.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ');
                logs.push(`[${msg.params.type}] ${text}`);
                if (msg.params.type === 'error') errors.push(text);
            } else if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                errors.push(`${d.text} ${d.exception ? d.exception.description : ''}`);
            } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
                errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
            }
        });
        await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
        await browser.send('Runtime.enable', {}, page);
        await browser.send('Log.enable', {}, page);
        await browser.send('Page.enable', {}, page);
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, page);
        await browser.send('Page.navigate', { url }, page);

        const evaluate = async (expression) => {
            const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page);
            if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
            return r.result.value;
        };
        const waitFor = async (expression, what, timeout = 30000) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeout) {
                try { if (await evaluate(expression)) return; } catch (e) { /* not there yet */ }
                await sleep(100);
            }
            throw new Error(`Timed out waiting for ${what} (${expression})`);
        };
        const screenshot = async (name) => {
            const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
            fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
        };
        const check = (condition, message) => {
            if (!condition) throw new Error(`Check failed: ${message}`);
            console.log(`ok   ${message}`);
        };
        const setSelect = (id, value) => evaluate(`(() => { const s = document.getElementById('${id}'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`);
        const setRange = (id, value) => evaluate(`(() => { const s = document.getElementById('${id}'); s.value = '${value}'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
        const click = (selector) => evaluate(`document.querySelector('${selector}').click()`);
        const idle = () => waitFor('!app.animating', 'the animation to end');
        // Real input events (pointer events in the page), at the centre of a square
        const center = (sq) => evaluate(`(() => { const r = document.querySelector('#board td[data-sq="${sq}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        const mouse = (type, x, y, buttons) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, page);
        const mouseClick = async (sq) => {
            const [x, y] = await center(sq);
            await mouse('mousePressed', x, y, 1);
            await mouse('mouseReleased', x, y, 0);
        };
        const mouseDrag = async (from, to, beforeRelease) => {
            const [x0, y0] = await center(from), [x1, y1] = await center(to);
            await mouse('mousePressed', x0, y0, 1);
            for (let i = 1; i <= 8; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, 1);
            if (beforeRelease) await beforeRelease();
            await mouse('mouseReleased', x1, y1, 0);
        };
        const touch = (type, touchPoints) => browser.send('Input.dispatchTouchEvent', { type, touchPoints }, page);
        const touchTap = async (sq) => {
            const [x, y] = await center(sq);
            await touch('touchStart', [{ x, y }]);
            await touch('touchEnd', []);
        };
        const touchDrag = async (from, to) => {
            const [x0, y0] = await center(from), [x1, y1] = await center(to);
            await touch('touchStart', [{ x: x0, y: y0 }]);
            for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8 }]);
            await touch('touchEnd', []);
        };

        const hidden = (id) => evaluate(`document.getElementById('${id}').classList.contains('hidden')`);
        const count = (selector) => evaluate(`document.querySelectorAll('${selector}').length`);
        const highlight = (sq) => evaluate(`getComputedStyle(document.querySelector('#board td[data-sq="${sq}"]'), '::before').opacity`);

        // --- Load: the main menu, set to Brandubh 2 (7x7) ---
        const menuOpen = () => evaluate('!document.getElementById("menuText").classList.contains("hidden")');
        const escape = () => evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
        const offered = (id, value) => evaluate(`!document.querySelector('#${id} option[value="${value}"]').disabled`);
        await evaluate('localStorage.clear()');
        await browser.send('Page.reload', {}, page);
        await waitFor('typeof app !== "undefined" && app.models.length > 0 && !document.querySelector("#menuText .panel-content.pending")',
            'the page, the model list and the menu', 60000);
        check(await menuOpen() && !(await evaluate('app.started')) && await hidden('menu-back') && await hidden('menu-close'),
            'the page opens at the main menu, with no game to go back to');
        await screenshot('start_menu.png');
        await escape();
        check(await menuOpen(), 'Escape does not close it before the first game');
        check(await evaluate('document.getElementById("ng-variant").value') === '7' && await evaluate('document.getElementById("ng-ruleset").value') === 'brandubh',
            'it offers Brandubh 2 on a 7x7 board first');
        check(await offered('ng-defender-type', 'mcts') && await offered('ng-defender-type', 'minimax') &&
            await evaluate('document.getElementById("ng-model").value') === 'brandubh_baseline_25',
            'on 7x7 it offers both AIs, with the Brandubh network');
        await setSelect('ng-variant', '11');
        check(await offered('ng-defender-type', 'mcts') && !(await offered('ng-defender-type', 'minimax')) && !(await offered('ng-eval-mode', 'heuristic')),
            'on 11x11 it offers the NN + MCTS player, and neither Minimax nor the heuristics');
        await setSelect('ng-variant', '7');
        await click('#ng-start');
        await waitFor('app.started && app.rules.name === "brandubh"', 'the Brandubh game');
        check(!(await menuOpen()) && await evaluate('app.cells.length') === 49,
            '"Start game" starts Brandubh 2 on a 7x7 board');
        check(await count('#board td.corner') === 4 && await count('#board td.throne') === 1, 'its corners and throne are marked');
        await waitFor('app.modelState === "ready" && app.analysis.stats && app.analysis.stats.visits >= 200', 'the Brandubh model and its analysis', 60000);
        check(true, `the Brandubh network evaluates the position (${await evaluate('document.getElementById("eval-value").textContent')})`);

        // --- The network's outlook: hidden until the pointer is on the eval bar ---
        const outlookShown = () => evaluate('getComputedStyle(document.getElementById("eval-outlook")).display !== "none"');
        await waitFor('app.analysis.nn && app.analysis.nn.ending', 'the network\'s outlook');
        check(!(await outlookShown()), 'the outlook is hidden at first');
        const [ex, ey] = await evaluate('(() => { const r = document.getElementById("eval-bar-container").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()');
        await mouse('mouseMoved', ex, ey, 0);
        const outlook = await evaluate('document.getElementById("eval-outlook").innerText');
        check(await outlookShown() && /Moves left\s+about \d+/.test(outlook) && await count('#outlook-endings li') >= 2 && outlook.includes('%'),
            `pointing at the eval bar shows it: ${outlook.replace(/\s+/g, ' ')}`);
        check(!outlook.includes('Exit fort') && !outlook.includes('Encirclement'), 'it leaves out the endings Brandubh does not have');
        await screenshot('outlook.png');
        await mouse('mouseMoved', 5, 5, 0);
        check(!(await outlookShown()), 'it hides again when the pointer leaves');
        await click('#help-btn');
        check((await evaluate('document.getElementById("rules-text").textContent')).includes('on the throne only when attackers surround him on all four sides'),
            'the help lists the rules of Brandubh 2');
        await screenshot('help.png');
        await click('[data-close="helpText"]');

        // --- Clicks: attacker d7 (square 3) to c7 (square 2) ---
        await click('#board td[data-sq="3"]');
        check(await evaluate('app.selected') === 3, 'clicking an attacker selects it');
        check(await count('#board td.legal-move') > 0, 'its legal moves are marked');
        await click('#board td[data-sq="2"]');
        await idle();
        check(await evaluate('app.game.moveCount') === 1, 'clicking a target square makes the move');
        check(await count('#board td.last-move') === 2 && Number(await highlight(2)) > 0.5 && Number(await highlight(3)) > 0.5,
            'the move\'s two squares light up');
        await screenshot('last_move.png');
        await sleep(1200);
        check(Number(await highlight(2)) === 0 && Number(await highlight(3)) === 0, 'the highlight is gone after a second');

        // --- Drag and drop and clicks with real mouse events (defender c5, square 17) ---
        await mouseDrag(17, 10);
        check(await evaluate('app.game.moveCount') === 1 && await evaluate('app.selected') === 17 &&
            await count('.dragged-piece, #board td.drag-source') === 0, 'a piece dropped on an occupied square goes back and stays selected');
        await mouseDrag(17, 15, async () => {
            check(await count('.dragged-piece') === 1 &&
                await evaluate('document.querySelector("#board td.drag-over") === document.querySelector(\'#board td[data-sq="15"]\')'),
                'while dragging, the piece follows the pointer and the target square is marked');
            await screenshot('dragging.png');
        });
        await idle();
        check(await evaluate('app.game.moveCount') === 2 && await evaluate('app.lastMove') === ((17 << 8) | 15), 'dragging a piece with the mouse moves it');
        await mouseClick(21);
        await waitFor('app.selected === 21', 'the click to select the piece', 3000);
        check(true, 'a real mouse click selects a piece');
        await mouseClick(14);
        await idle();
        check(await evaluate('app.game.moveCount') === 3 && await evaluate('app.lastMove') === ((21 << 8) | 14), 'a second click moves it');

        // --- Minimax (7x7 only) as the defender; undo ---
        await setSelect('eval-mode-select', 'heuristic');
        await setRange('defender-minimax-difficulty', 2);
        await setSelect('defender-type', 'minimax');
        await waitFor('app.game.moveCount === 4 && !app.animating', 'Minimax to move', 60000);
        check(true, 'Minimax plays as defender (its moves are checked against these rules)');
        await setSelect('defender-type', 'human');
        await setSelect('eval-mode-select', 'nn-mcts');
        await click('#undo-btn');
        await idle();
        check(await evaluate('app.game.moveCount') === 3, 'undo takes back a move');
        await screenshot('brandubh.png');

        // --- Sami Tablut (9x9): defenders first, the king escapes to the edge ---
        await click('#menu-btn');
        await setSelect('ng-variant', '9');
        check(await evaluate('[...document.getElementById("ng-ruleset").options].map(o => o.value).join()') === 'sami_tablut,sea_battle_9x9,market_hnefatafl',
            'the panel offers the three 9x9 rule sets');
        await click('#ng-start');
        await waitFor('app.rules.name === "sami_tablut"', 'the Sami Tablut game');
        check(await evaluate('app.game.currentPlayer') === 1 && await evaluate('app.cells.length') === 81, 'in Sami Tablut the defenders move first');
        check(await count('#board td.corner') === 0 && await count('#board td.throne') === 1, 'an edge-escape game has no corner squares');
        await screenshot('sami_tablut.png');

        // --- Copenhagen (11x11) with its network ---
        await click('#menu-btn');
        await setSelect('ng-variant', '11');
        check(await evaluate('document.getElementById("ng-ruleset").value') === 'copenhagen' &&
            await evaluate('document.getElementById("ng-model").value') === 'copenhagen_baseline_5', 'an 11x11 game defaults to Copenhagen and its model');
        // The players are chosen in the menu too: a human attacker against the network
        await setSelect('ng-defender-type', 'mcts');
        check(!(await hidden('ng-defender-mcts')) && await hidden('ng-attacker-mcts'), 'the menu shows the strength of an AI player');
        await setRange('ng-defender-sims', 100);
        await click('#ng-start');
        await waitFor('app.rules.name === "copenhagen" && app.modelState === "ready"', 'the Copenhagen model', 60000);
        check(await evaluate('app.players.defender.type') === 'mcts' && await evaluate('app.players.defender.sims') === 100 &&
            await evaluate('document.getElementById("defender-type").value') === 'mcts' &&
            await evaluate('document.getElementById("defender-mcts-difficulty").value') === '100',
            'the game gets the players of the menu, and the menus below the board show them');
        check(await hidden('model-warning'), 'no rules warning when the model plays its own rules');
        check(await count('#board td.corner') === 4 && await count('#board td.throne') === 1, 'Copenhagen has corners and a throne');
        await waitFor('app.analysis.stats && app.analysis.stats.visits >= 200', 'the eval bar analysis', 60000);
        console.log(`     analysis: ${await evaluate('document.getElementById("eval-value").textContent')} (${await evaluate('document.getElementById("eval-detail").textContent')})`);
        await click('#board td[data-sq="3"]');
        await click('#board td[data-sq="14"]');
        await waitFor('app.game.moveCount === 2 && !app.animating', 'the AI defender to answer', 60000);
        check(true, 'the NN + MCTS defender answers');
        await setSelect('policy-mode-select', 'nn-mcts');
        await waitFor('document.querySelectorAll(".policy-overlay").length > 0', 'MCTS suggestions');
        check(true, 'MCTS move suggestions are shown');
        await setSelect('eval-mode-select', 'nn');
        await setSelect('policy-mode-select', 'nn');
        await waitFor('app.analysis.nn && document.querySelectorAll(".policy-overlay").length > 0', 'network suggestions');
        check(true, 'network evaluation and policy suggestions are shown');
        await screenshot('copenhagen.png');
        await click('#undo-btn');
        await idle();
        check(await evaluate('app.game.moveCount') === 0, 'undo returns to the human attacker\'s turn');
        await setSelect('eval-mode-select', 'nn-mcts');
        await setSelect('policy-mode-select', 'off');
        await setRange('attacker-mcts-difficulty', 60);
        await setRange('defender-mcts-difficulty', 60);
        await setSelect('attacker-type', 'mcts');
        await setSelect('defender-type', 'mcts');
        await waitFor('app.game.moveCount >= 6 || app.game.gameOver', '6 AI moves', 120000);
        check(true, `AI against AI plays (${(await evaluate('app.msPerCall')).toFixed(2)} ms per network call)`);
        await click('#menu-btn');
        await idle();
        const pausedAt = await evaluate('app.game.moveCount');
        await sleep(2000);
        check(await evaluate('app.game.moveCount') === pausedAt && await evaluate('app.analysisJobs.length') === 0 &&
            !(await hidden('menu-back')), 'the game waits while the menu is open');
        await click('#menu-back');
        await waitFor(`app.game.moveCount > ${pausedAt} || app.game.gameOver`, 'the game to go on', 60000);
        check(!(await menuOpen()), '"Back to game" goes on with it');
        await setSelect('attacker-type', 'human');
        await setSelect('defender-type', 'human');
        await idle();
        await click('#settings-btn');
        check(await evaluate('app.searchParams.discount') === 0.995, 'the search settings come from the model description');
        await evaluate('document.getElementById("continuous-eval-toggle").click()');
        await click('[data-close="settingsText"]');
        await waitFor('app.analysis.stats && app.analysis.stats.visits > 1000', 'continuous analysis past 1000 visits', 90000);
        check(true, `continuous analysis runs (${await evaluate('document.getElementById("eval-detail").textContent')})`);
        await evaluate('document.getElementById("continuous-eval-toggle").click()');

        // --- Fetlar with the Copenhagen model: the rules differ, so both places warn ---
        await click('#menu-btn');
        await setSelect('ng-ruleset', 'fetlar');
        const warning = await evaluate('document.getElementById("ng-warning").textContent');
        check(!(await hidden('ng-warning')) && warning.includes('shieldwall') && warning.includes('exit fort'),
            'the panel warns that the model was trained with other rules');
        await screenshot('menu.png');
        await click('#ng-start');
        await waitFor('app.rules.name === "fetlar" && app.modelState === "ready"', 'the Fetlar game', 60000);
        check(!(await hidden('model-warning')), 'the line above the board warns about the rules');

        // --- Phone layout: everything fits on the screen, the menus are in the Settings panel ---
        const phone = async (width, height) => {
            await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true }, page);
            await sleep(400);
        };
        const fits = () => evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1');
        check(await evaluate('document.getElementById("play-options").parentElement.id') === 'buttons-container', 'on desktop the player menus are below the board');
        await phone(390, 844);
        check(await evaluate('document.getElementById("play-options").parentElement.id') === 'settings-play-slot', 'on a phone they are in the Settings panel');
        await screenshot('phone.png');
        await click('#settings-btn');
        await screenshot('phone_settings.png');
        await click('[data-close="settingsText"]');
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, page);
        const scrollBefore = await evaluate('window.scrollY');
        await touchDrag(3, 14);
        await idle();
        check(await evaluate('app.game.moveCount') === 1 && await evaluate('app.lastMove') === ((3 << 8) | 14) &&
            await evaluate('window.scrollY') === scrollBefore, 'a finger drags a piece without scrolling the page');
        await touchTap(38);
        await waitFor('app.selected === 38', 'the tap to select the piece', 3000);
        check(true, 'a tap selects a piece');
        // A tap on the eval bar shows the outlook (no hover on a touch screen), inside the screen
        await waitFor('app.analysis.nn && app.analysis.nn.ending', 'the network\'s outlook');
        const [tx, ty] = await evaluate('(() => { const r = document.getElementById("AI-eval").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()');
        await touch('touchStart', [{ x: tx, y: ty }]);
        await touch('touchEnd', []);
        await waitFor('document.getElementById("AI-eval").classList.contains("show-outlook")', 'the tap on the eval bar', 3000);
        check(await outlookShown() && await evaluate('(() => { const r = document.getElementById("eval-outlook").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()'),
            'on a phone a tap on the eval bar shows the outlook, inside the screen');
        await screenshot('phone_outlook.png');
        await touch('touchStart', [{ x: 10, y: 10 }]);
        await touch('touchEnd', []);
        await waitFor('!document.getElementById("AI-eval").classList.contains("show-outlook")', 'the tap elsewhere', 3000);
        check(!(await outlookShown()), 'a tap elsewhere hides it');
        // The rules warning is showing: the longest top line there is
        for (const [width, height] of [[390, 844], [375, 667], [360, 640]]) {
            await phone(width, height);
            check(await fits(), `everything fits on a ${width}x${height} screen without scrolling`);
        }
        await screenshot('phone_small.png');
        // The menu fits too, with an AI's strength showing; "Back to game" leaves the game as it was
        await click('#menu-btn');
        await setSelect('ng-attacker-type', 'mcts');
        for (const [width, height] of [[390, 844], [375, 667], [360, 640]]) {
            await phone(width, height);
            check(await evaluate('(() => { const m = document.getElementById("menuText"); return m.scrollHeight <= m.clientHeight + 1; })()'),
                `the menu fits on a ${width}x${height} screen without scrolling`);
        }
        await screenshot('phone_menu.png');
        await escape();
        check(!(await menuOpen()) && await evaluate('app.players.attacker.type') === 'human' && await evaluate('app.rules.name') === 'fetlar',
            'Escape goes back to the game, without the menu\'s changes');
    } finally {
        browser.close();
        server.close();
        fs.writeFileSync(path.join(SHOTS, 'console.log'), logs.join('\n'));
    }
    if (errors.length) {
        console.log(`FAIL ${errors.length} errors in the page or the worker:`);
        for (const e of errors.slice(0, 20)) console.log('  ' + e);
        process.exit(1);
    }
    console.log('Page test passed; screenshots in tests/screenshots/.');
}

main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
});
