#!/usr/bin/env python3
"""
Write reference games from the Python engines, for tests/test_engine.js.

The JavaScript engine (tafl.js) must play exactly the game the networks were trained on. This
script plays games with the Python engines of the training code (github.com/jgslunde/Games, folder
Hnefatafl_RL/) under every rule combination and records, for every ply: the board, the player to
move, all legal moves in engine order, the move played, the game result after it, and for some
games all input planes (history of 3 positions, constant, reach and king-region planes).

The moves are random but biased towards what random play rarely reaches: captures, king moves,
attackers next to the king, and replaying one's own previous move backwards (to reach the
repetition rule). A few games start from set-up positions for encirclement and blocked kings.

Usage (needs the training code's Python environment, with scipy):
    python tests/make_reference_games.py /path/to/Hnefatafl_RL [--out tests/reference] [--seed 0]
Then run:  node tests/test_engine.js
"""

import argparse
import gzip
import itertools
import json
import os
import sys

import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('training_dir', help='Path of the Hnefatafl_RL folder of the training code')
    parser.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reference'))
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--games', type=int, nargs=3, default=[8, 5, 4],
                        help='Games per rule combination for 7x7, 9x9 and 11x11 (default: 8 5 4)')
    parser.add_argument('--max-plies', type=int, default=250)
    return parser.parse_args()


args = parse_args()
sys.path.insert(0, os.path.abspath(args.training_dir))
from games import game_spec  # noqa: E402
from features import FeatureSpec, build_features  # noqa: E402

EMPTY, ATTACKER, DEFENDER, KING = 0, 1, 2, 3
PLANES = FeatureSpec(history_length=3, constant_planes=True, mobility_planes=True, region_plane=True)


def pack(move, n):
    fr, fc, tr, tc = (int(x) for x in move)
    return ((fr * n + fc) << 8) | (tr * n + tc)


def board_string(board):
    return ''.join(str(int(x)) for x in board.ravel())


def captures_something(game, move):
    """Whether a move captures, without making it (the trick of _would_cause_repetition)."""
    fr, fc, tr, tc = move
    piece = game.board[fr, fc]
    saved, game_over, winner = game.board.copy(), game.game_over, game.winner
    game.board[fr, fc] = EMPTY
    game.board[tr, tc] = piece
    before = np.count_nonzero(game.board)
    game._check_captures(tr, tc)
    captured = np.count_nonzero(game.board) < before
    game.board[:] = saved
    game.game_over, game.winner = game_over, winner
    return captured


def choose_move(game, moves, rng, history):
    n = game.board.shape[0]
    r = rng.random()
    if r < 0.2 and len(history) >= 2:
        # Play this player's previous move backwards: this reaches repeated positions
        fr, fc, tr, tc = history[-2]
        back = (tr, tc, fr, fc)
        if back in moves:
            return back
    if r < 0.55:
        capturing = [m for m in moves if captures_something(game, m)]
        if capturing:
            return capturing[rng.integers(len(capturing))]
    if r < 0.75:
        if game.current_player == 1:
            king_moves = [m for m in moves if game.board[m[0], m[1]] == KING]
            if king_moves:
                return king_moves[rng.integers(len(king_moves))]
        else:
            kr, kc = np.argwhere(game.board == KING)[0]
            near = [m for m in moves if abs(m[2] - kr) + abs(m[3] - kc) == 1]
            if near:
                return near[rng.integers(len(near))]
    return moves[rng.integers(len(moves))]


def play(spec, rules, rng, with_planes, start=None, max_plies=250):
    game = spec.game_class(**rules)
    n = game.board.shape[0]
    forced = []
    if start is not None:
        board, player, forced = start
        forced = list(forced)
        game.board[:] = np.array(board, dtype=np.int8).reshape(n, n)
        game.current_player = player
        game.position_history = []
        game._legal_moves_key = None
        game._record_position()
    record = {'rules': rules, 'size': n, 'start_board': board_string(game.board),
              'start_player': int(game.current_player), 'custom_start': start is not None, 'plies': []}
    history = []
    while not game.game_over and game.move_count < max_plies:
        moves = game.get_legal_moves()
        move = forced.pop(0) if forced and forced[0] in moves else choose_move(game, moves, rng, history)
        ply = {'board': board_string(game.board), 'player': int(game.current_player),
               'legal': [pack(m, n) for m in moves], 'move': pack(move, n)}
        if with_planes:
            planes = build_features(game, PLANES).astype(np.int8)
            ply['planes'] = [''.join(str(int(x)) for x in plane.ravel()) for plane in planes]
        game.make_move(move)
        history.append(move)
        ply['game_over'] = bool(game.game_over)
        ply['winner'] = None if game.winner is None else int(game.winner)
        record['plies'].append(ply)
    record['final_board'] = board_string(game.board)
    record['final_player'] = int(game.current_player)
    record['game_over'] = bool(game.game_over)
    record['winner'] = None if game.winner is None else int(game.winner)
    if game.game_over:
        # Planes of the final position too (it is never evaluated, but costs nothing to check)
        record['final_legal'] = [pack(m, n) for m in game.get_legal_moves()]
    return record


def set_up_positions(name):
    """Start positions that random play rarely reaches: (board, player to move, forced first moves)."""
    positions = []
    if name == 'hnefatafl':
        # A ring of attackers around the king with a gap at (2,5); the attacker at (0,5) closes it,
        # which encircles the king. Also played without the forced move.
        b = np.zeros((11, 11), dtype=int)
        b[5, 5] = KING
        b[4, 5] = DEFENDER
        ring = [(2, 4), (3, 3), (4, 2), (5, 2), (6, 2), (7, 3), (8, 4), (8, 5), (8, 6), (7, 7), (6, 8),
                (5, 8), (4, 8), (3, 7), (2, 6)]
        for r, c in ring:
            b[r, c] = ATTACKER
        b[0, 5] = ATTACKER  # closes the ring by moving to (2,5)
        b[1, 2] = DEFENDER  # a defender outside the ring
        positions.append((b.ravel().tolist(), 0, [(0, 5, 2, 5)]))
        positions.append((b.ravel().tolist(), 0, []))
    # A king boxed in by its own defenders and attackers, defenders to move, few pieces left
    n = game_spec(name).board_size
    b = np.zeros((n, n), dtype=int)
    b[0, 1] = KING
    b[0, 2] = ATTACKER
    b[1, 1] = ATTACKER
    b[n - 1, n - 3] = ATTACKER
    b[n - 2, n - 1] = DEFENDER
    positions.append((b.ravel().tolist(), 1, []))
    # The king one step from a corner, attackers to move
    b = np.zeros((n, n), dtype=int)
    b[1, 0] = KING
    b[2, 0] = DEFENDER
    b[n // 2, n // 2 + 1] = ATTACKER
    b[n - 1, 2] = ATTACKER
    b[2, 2] = ATTACKER
    positions.append((b.ravel().tolist(), 0, []))
    return positions


def main():
    os.makedirs(args.out, exist_ok=True)
    rng = np.random.default_rng(args.seed)
    for (name, games_per_combo) in zip(['brandubh', 'tablut', 'hnefatafl'], args.games):
        spec = game_spec(name)
        games = []
        for kcp, kcc, thi, te in itertools.product([2, 3, 4], [True, False], [True, False], [True, False]):
            rules = dict(king_capture_pieces=kcp, king_can_capture=kcc, throne_is_hostile=thi, throne_enabled=te)
            for i in range(games_per_combo):
                games.append(play(spec, rules, rng, with_planes=(i < 2), max_plies=args.max_plies))
            for start in set_up_positions(name):
                games.append(play(spec, rules, rng, with_planes=True, start=start, max_plies=args.max_plies))
        path = os.path.join(args.out, f'reference_{name}.json.gz')
        with gzip.open(path, 'wt') as f:
            json.dump({'game': name, 'planes': PLANES.plane_names(), 'games': games}, f)
        plies = sum(len(g['plies']) for g in games)
        ended = sum(g['game_over'] for g in games)
        print(f'{name}: {len(games)} games, {plies} plies, {ended} finished -> {path}')


if __name__ == '__main__':
    main()
