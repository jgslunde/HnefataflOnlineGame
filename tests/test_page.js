#!/usr/bin/env node
/**
 * End-to-end test of the page in headless Chrome: serves the repository, opens index.html and
 * plays through the main features on all three boards (human moves, the NN + MCTS AI, Minimax,
 * undo, new games with other rules, eval bar and suggestions), failing on any error in the page or
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

        // --- Load: 7x7 with the default model ---
        await evaluate('localStorage.clear()');
        await browser.send('Page.reload', {}, page);
        await waitFor('typeof app !== "undefined" && app.game && app.modelState === "ready"', 'the default model', 60000);
        check(await evaluate('app.cells.length') === 49, 'the 7x7 board has 49 squares');
        check(await evaluate('app.model.id') === 'brandubh_littleboy_decay_fixed_210', 'the default 7x7 model is loaded');
        check(await evaluate('document.getElementById("model-warning").classList.contains("hidden")'), 'no rules warning with the model\'s own rules');
        await waitFor('app.analysis.stats && app.analysis.stats.visits >= 200', 'the eval bar analysis');
        console.log(`     analysis: ${await evaluate('document.getElementById("eval-value").textContent')} (${await evaluate('document.getElementById("eval-detail").textContent')})`);

        // --- A human move by clicks: attacker d7 (square 3) to c7 (square 2) ---
        await click('#board td[data-sq="3"]');
        check(await evaluate('app.selected') === 3, 'clicking an attacker selects it');
        check(await evaluate('document.querySelectorAll("#board td.legal-move").length') > 0, 'its legal moves are marked');
        await click('#board td[data-sq="2"]');
        await idle();
        check(await evaluate('app.game.moveCount') === 1, 'clicking a target square makes the move');
        const highlight = (sq) => evaluate(`getComputedStyle(document.querySelector('#board td[data-sq="${sq}"]'), '::before').opacity`);
        check(await evaluate('document.querySelectorAll("#board td.last-move").length') === 2 &&
            Number(await highlight(2)) > 0.5 && Number(await highlight(3)) > 0.5, 'the move\'s two squares light up');
        await screenshot('last_move.png');
        await sleep(1200);
        check(Number(await highlight(2)) === 0 && Number(await highlight(3)) === 0, 'the highlight is gone after a second');

        // --- The defender as NN + MCTS AI ---
        await setRange('defender-mcts-difficulty', 100);
        await setSelect('defender-type', 'mcts');
        await waitFor('app.game.moveCount === 2 && !app.animating', 'the AI defender to move');
        check(true, 'the NN + MCTS defender answers');

        // --- Suggestions and the raw network ---
        await setSelect('policy-mode-select', 'nn-mcts');
        await waitFor('document.querySelectorAll(".policy-overlay").length > 0', 'MCTS suggestions');
        check(true, 'MCTS move suggestions are shown');
        await setSelect('eval-mode-select', 'nn');
        await setSelect('policy-mode-select', 'nn');
        await waitFor('app.analysis.nn && document.querySelectorAll(".policy-overlay").length > 0', 'network suggestions');
        check(true, 'network evaluation and policy suggestions are shown');
        await screenshot('brandubh.png');

        // --- Undo goes back to the human's turn (two plies) ---
        await click('#undo-btn');
        await idle();
        check(await evaluate('app.game.moveCount') === 0 && await evaluate('app.game.currentPlayer') === 0, 'undo returns to the human attacker\'s turn');

        // --- Minimax on 7x7 ---
        await setSelect('eval-mode-select', 'heuristic');
        await setRange('attacker-minimax-difficulty', 2);
        await setSelect('attacker-type', 'minimax');
        await waitFor('app.game.moveCount >= 2', 'Minimax and the AI defender to move', 60000);
        check(true, 'Minimax plays as attacker');
        await setSelect('attacker-type', 'human');
        await setSelect('defender-type', 'human');
        await setSelect('eval-mode-select', 'nn-mcts');
        await setSelect('policy-mode-select', 'off');
        await idle();

        // --- Tablut and Hnefatafl: new games through the panel, AI against AI ---
        for (const [size, variant, minMoves] of [[9, 'tablut', 6], [11, 'hnefatafl', 6]]) {
            await click('#new-game-btn');
            await setSelect('ng-variant', String(size));
            check(await evaluate('document.getElementById("ng-model").options.length') >= 1, `the new-game panel lists a ${size}x${size} model`);
            await click('#ng-start');
            await waitFor(`app.size === ${size} && app.modelState === "ready"`, `the ${size}x${size} model`, 60000);
            check(await evaluate('app.cells.length') === size * size, `the ${variant} board has ${size * size} squares`);
            const msPerCall = await evaluate('app.msPerCall');
            await setRange('attacker-mcts-difficulty', 60);
            await setRange('defender-mcts-difficulty', 60);
            await setSelect('attacker-type', 'mcts');
            await setSelect('defender-type', 'mcts');
            await waitFor(`app.game.moveCount >= ${minMoves} || app.game.gameOver`, `${minMoves} AI moves on ${variant}`, 120000);
            check(true, `AI against AI plays on ${variant} (${msPerCall.toFixed(2)} ms per network call)`);
            await setSelect('attacker-type', 'human');
            await setSelect('defender-type', 'human');
            await idle();
            await waitFor('app.analysis.stats && app.analysis.stats.visits >= 200', `the ${variant} analysis`, 60000);
            console.log(`     ${variant} analysis: ${await evaluate('document.getElementById("eval-detail").textContent')}`);
            await screenshot(`${variant}.png`);
        }

        // --- Other rules than the model's: the warning appears; throne marked ---
        await click('#new-game-btn');
        await setSelect('ng-variant', '7');
        await evaluate('document.getElementById("ng-model-rules").click()');
        await setSelect('ng-kcp', '4');
        await evaluate('(() => { const t = document.getElementById("ng-throne"); if (!t.checked) t.click(); })()');
        check(!(await evaluate('document.getElementById("ng-warning").classList.contains("hidden")')), 'the panel warns about rules the model was not trained with');
        await screenshot('new_game_panel.png');
        await click('#ng-start');
        await waitFor('app.size === 7 && app.modelState === "ready"', 'the 7x7 model again', 60000);
        check(await evaluate('app.rules.kingCapturePieces') === 4 && await evaluate('app.rules.throneEnabled'), 'the new game uses the chosen rules');
        check(!(await evaluate('document.getElementById("model-warning").classList.contains("hidden")')), 'the line above the board warns about the rules');
        check(await evaluate('document.querySelectorAll("#board td.throne").length') === 1, 'the throne square is marked');
        await screenshot('brandubh_custom_rules.png');
        await click('#help-btn');
        check((await evaluate('document.getElementById("rules-text").textContent')).includes('four sides'), 'the help lists the game\'s own rules');
        await screenshot('help.png');
        await click('[data-close="helpText"]');

        // --- Drag and drop, and clicks, with real mouse events ---
        await mouseDrag(3, 10);
        check(await evaluate('app.game.moveCount') === 0 && await evaluate('app.selected') === 3 &&
            await evaluate('document.querySelectorAll(".dragged-piece, #board td.drag-source").length') === 0,
            'a piece dropped on an occupied square goes back and stays selected');
        await mouseDrag(3, 2, async () => {
            check(await evaluate('document.querySelectorAll(".dragged-piece").length') === 1 &&
                await evaluate('document.querySelector("#board td.drag-over") === document.querySelector(\'#board td[data-sq="2"]\')'),
                'while dragging, the piece follows the pointer and the target square is marked');
            await screenshot('dragging.png');
        });
        await idle();
        check(await evaluate('app.game.moveCount') === 1 && await evaluate('app.lastMove') === ((3 << 8) | 2), 'dragging a piece with the mouse moves it');
        await mouseClick(17);
        await waitFor('app.selected === 17', 'the click to select the piece', 3000);
        check(true, 'a real mouse click selects a piece');
        await mouseClick(15);
        await idle();
        check(await evaluate('app.game.moveCount') === 2 && await evaluate('app.lastMove') === ((17 << 8) | 15), 'a second click moves it');

        // --- Settings: another model mid-game ---
        await click('#settings-btn');
        await setSelect('model-select', 'brandubh_SE_32x6_204');
        await waitFor('app.model.id === "brandubh_SE_32x6_204" && app.modelState === "ready"', 'the old default model', 60000);
        check(await evaluate('app.searchParams.discount') === 0.98, 'its search settings come from its description');
        await click('[data-close="settingsText"]');

        // --- Continuous analysis keeps going ---
        await click('#settings-btn');
        await evaluate('document.getElementById("continuous-eval-toggle").click()');
        await click('[data-close="settingsText"]');
        await waitFor('app.analysis.stats && app.analysis.stats.visits > 1000', 'continuous analysis past 1000 visits', 60000);
        check(true, `continuous analysis runs (${await evaluate('document.getElementById("eval-detail").textContent')})`);
        await evaluate('document.getElementById("continuous-eval-toggle").click()');

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
        await touchDrag(21, 14);
        await idle();
        check(await evaluate('app.game.moveCount') === 3 && await evaluate('app.lastMove') === ((21 << 8) | 14) &&
            await evaluate('window.scrollY') === scrollBefore, 'a finger drags a piece without scrolling the page');
        await touchTap(31);
        await waitFor('app.selected === 31', 'the tap to select the piece', 3000);
        check(true, 'a tap selects a piece');
        // The rules warning is showing: the longest top line there is
        for (const [width, height] of [[390, 844], [375, 667], [360, 640]]) {
            await phone(width, height);
            check(await fits(), `everything fits on a ${width}x${height} screen without scrolling`);
        }
        await screenshot('phone_small.png');
        await click('#new-game-btn');
        await setSelect('ng-variant', '11');
        await click('#ng-start');
        await waitFor('app.size === 11 && app.modelState === "ready"', 'the 11x11 model', 60000);
        check(await fits(), 'an 11x11 game fits on a 360x640 screen too');
        await screenshot('phone_small_hnefatafl.png');
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
