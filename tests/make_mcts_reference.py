#!/usr/bin/env python3
"""
Write reference searches of the Python MCTS (mcts.py of the training code), for tests/test_mcts.js.

For each model in the list, plays a few random games and, at some plies, runs mcts.py's search
with the model's own search settings (from its .json). The network is the same .onnx file the
browser uses, run with onnxruntime. The visit counts of every root move are recorded; mcts.js run
on the same positions with onnxruntime-web should give the same counts.

Usage (needs the training code's Python environment, with scipy and onnxruntime):
    python tests/make_mcts_reference.py /path/to/Hnefatafl_RL [--sims 200] [--out tests/reference/mcts.json]
"""

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('training_dir')
parser.add_argument('--sims', type=int, default=200)
parser.add_argument('--out', default=os.path.join(HERE, 'reference', 'mcts.json'))
parser.add_argument('--models', nargs='*', default=[
    'checkpoints/brandubh_littleboy_decay_fixed_iter_210',
    'checkpoints/tablut_test_6x48_iter_150',
    'checkpoints/hnefatafl_baseline_iter_1',
])
args = parser.parse_args()
sys.path.insert(0, os.path.abspath(args.training_dir))

import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
from features import FeatureSpec  # noqa: E402
from games import game_spec_for_board  # noqa: E402
from mcts import MCTS  # noqa: E402


class OnnxNetwork:
    """Stands in for the torch network in mcts.py: same call signature, outputs from onnxruntime."""

    def __init__(self, path):
        self.session = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def eval(self):
        return self

    def __call__(self, x):
        policy, value = self.session.run(None, {self.input_name: x.numpy()})
        return torch.from_numpy(policy), torch.from_numpy(value)


def feature_spec(planes):
    history = sum(1 for p in planes if p.startswith('attackers_t'))
    return FeatureSpec(history_length=history, constant_planes='ones' in planes,
                       mobility_planes='reach_attackers' in planes, region_plane='king_region' in planes)


def pack(move, n):
    fr, fc, tr, tc = (int(x) for x in move)
    return ((fr * n + fc) << 8) | (tr * n + tc)


def main():
    rng = np.random.default_rng(1)
    cases = []
    for base in args.models:
        info = json.load(open(os.path.join(REPO, base + '.json')))
        n = info['board_size']
        spec = game_spec_for_board(n)
        search = info.get('search') or {}
        params = dict(c_puct=search.get('c_puct') or 1.5,
                      fpu_reduction=search.get('fpu_reduction') if search.get('fpu_reduction') is not None else -0.25,
                      search_discount=search.get('discount') or 1.0)
        mcts = MCTS(OnnxNetwork(os.path.join(REPO, base + '.onnx')), num_simulations=args.sims,
                    feature_spec=feature_spec(info['input']['planes']), **params)
        for game_index in range(3):
            game = spec.game_class(**info['rules'])
            played = []
            for stop in (0, 7, 20, 40):
                while game.move_count < stop and not game.game_over:
                    moves = game.get_legal_moves()
                    move = moves[rng.integers(len(moves))]
                    game.make_move(move)
                    played.append(pack(move, n))
                if game.game_over:
                    break
                mcts.search(game)
                root = mcts.root
                cases.append({
                    'model': base, 'rules': info['rules'], 'size': n, 'moves': list(played),
                    'sims': args.sims, 'params': params,
                    'children': [pack(m, n) for m in root.children],
                    'visits': [c.visit_count for c in root.children.values()],
                    'priors': [float(c.prior) for c in root.children.values()],
                    'root_value': root.mean_value,
                })
                print(f'{base} game {game_index} ply {game.move_count}: top visits '
                      f'{sorted(cases[-1]["visits"], reverse=True)[:5]}')
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(cases, open(args.out, 'w'))
    print(f'{len(cases)} searches -> {args.out}')


if __name__ == '__main__':
    main()
