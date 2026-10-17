# HnefataflOnlineGame

Tafl in the browser (Brandubh 7×7, Tablut 9×9, Hnefatafl 11×11) against AIs trained with
reinforcement learning in [jgslunde/Games](https://github.com/jgslunde/Games) (`Hnefatafl_RL/`).
A static site: open `index.html` through any web server (`python3 serve.py`, then
http://localhost:8000). It does not work from `file://`, because it uses a Web Worker.

## How it fits together

| File | What it does |
|---|---|
| `tafl.js` | Rules engine: board as an `Int8Array`, all rule switches, repetition rule, network input planes, policy index. A port of `brandubh.py`, `tablut.py`, `hnefatafl.py` and `features.py`. |
| `mcts.js` | Tree search guided by the network, a port of `mcts.py` (FPU, discount, temperature as in Python). |
| `network.js` | Runs an ONNX model for the search, building its input from the model's `.json` description. |
| `searchWorker.js`, `searchClient.js` | The network and the search run in a Web Worker; the client wraps it in promises. |
| `script.js`, `index.html`, `styles.css` | The page: board, input, game set-up, AI players, eval bar, move suggestions. |
| `Cpp_ai.js`, `Cpp_ai.wasm` | The Minimax AI (C++), which knows only 7×7 Brandubh with the default rules. |
| `models.json` | The models the page offers, and the default model for each board size. |

A network only knows the game as the Python engine plays it, so the rules, input planes and
search settings must match the training code exactly. Where they differ, the Python code is right.

## Adding a model

1. In the training repository, export the checkpoint with
   `python convert_to_onnx.py <checkpoint.pth> --output <this repo>/checkpoints/<name>.onnx`.
   This writes `<name>.json` next to it: board size, input planes, the rules it was trained with
   and its search settings. Do not use other export scripts: they changed the network.
2. Add an entry to `models.json` with an `id`, a display `name`, the `onnx` and `info` paths and an
   optional `note`. To make it the default for its board size, put its id under `defaults`.

The board size, input planes, training rules and search settings all come from the `.json` file.
When a game uses other rules than a model was trained with, the page still lets it play, but warns.

## Tests

The tests compare the JavaScript with the Python training code, so they need it (and its Python
environment, with `scipy` and `onnxruntime`) to write reference data:

```
python tests/make_reference_games.py /path/to/Hnefatafl_RL   # games under all rule switches
python tests/make_mcts_reference.py /path/to/Hnefatafl_RL    # searches with the bundled models
cd tests && npm install && cd ..                              # onnxruntime-web for Node
node tests/test_engine.js   # boards, legal moves, input planes and results, ply by ply
node tests/test_mcts.js     # visit counts of the JS search against the Python search
node tests/test_page.js     # the page in headless Chrome (needs Chrome and internet access)
```

## TODO (frontend)
- Display number of lost pieces.
