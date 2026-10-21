#!/usr/bin/env python3
"""
Write reference games from the Python engine (tafl.py), for tests/test_engine.js.

The JavaScript engine (tafl.js) must play exactly the game the networks were trained on. This
script records, for every move: the position before it (board, player to move, earlier positions),
all legal moves in engine order, all input planes (history of 3 positions, constant, reach and
defender-region planes), the move, and the position and result after it. Two sources:

- games under each of the eleven named rule sets, from the start, with random moves biased towards
  what random play rarely reaches: captures, king moves, attackers next to the king, moves along the
  edge (shieldwalls), and replaying one's own previous move backwards (repetitions);
- every move made by the hand-made rule positions of test_rules.py in the training code, one
  position per rule (king captures, hostile squares, shieldwall, exit fort, encirclement,
  repetition counts, ...). The script runs those tests with a recording Tafl class;
- random positions for the rules random games almost never reach, with Python's verdict: exit forts
  (a king on the edge among many defenders) and captures, shieldwalls among them.

Usage (needs the training code's Python environment, with scipy):
    python tests/make_reference_games.py /path/to/Hnefatafl_RL [--out tests/reference] [--seed 0]
Then run:  node tests/test_engine.js
"""

import argparse
import contextlib
import gzip
import io
import json
import os
import sys

import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('training_dir', help='Path of the Hnefatafl_RL folder of the training code')
    parser.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reference'))
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--games', type=int, default=24, help='Games per rule set (default: 24)')
    parser.add_argument('--max-plies', type=int, default=300)
    return parser.parse_args()


args = parse_args()
sys.path.insert(0, os.path.abspath(args.training_dir))
import tafl  # noqa: E402
from features import FeatureSpec, build_features  # noqa: E402
from tafl import KING, RULESETS, Tafl  # noqa: E402

PLANES = FeatureSpec(history_length=3, constant_planes=True, mobility_planes=True, region_plane=True)


def pack(move, n):
    fr, fc, tr, tc = (int(x) for x in move)
    return ((fr * n + fc) << 8) | (tr * n + tc)


def board_string(board):
    return ''.join(str(int(x)) for x in board.ravel())


def snapshot(game, with_history):
    """The position before a move. With the earlier positions too, if the JavaScript engine has to
    rebuild it on its own (the random games are replayed from the start instead)."""
    n = game.size
    ply = {
        'board': board_string(game.board), 'player': int(game.current_player),
        'legal': [pack(m, n) for m in game.get_legal_moves()],
        'planes': [''.join(str(int(x)) for x in plane.ravel()) for plane in build_features(game, PLANES).astype(np.int8)],
    }
    if with_history:
        ply['history'] = [[board_string(np.frombuffer(b, dtype=np.int8)), int(p)] for b, p in game.position_history[:-1]]
    return ply


def result(game):
    return {'board_after': board_string(game.board), 'player_after': int(game.current_player),
            'game_over': bool(game.game_over), 'winner': None if game.winner is None else int(game.winner),
            'end_reason': game.end_reason}


def captures_something(game, move):
    """Whether a move captures, without making it."""
    fr, fc, tr, tc = move
    board = game.board.copy()
    board[tr, tc], board[fr, fc] = board[fr, fc], 0
    captured, king_captured = game._find_captures(board, tr, tc)
    return bool(captured) or king_captured


def choose_move(game, moves, rng, history):
    n = game.size
    r = rng.random()
    if r < 0.15 and len(history) >= 2:
        fr, fc, tr, tc = history[-2]  # this player's previous move, backwards: repetitions
        if (tr, tc, fr, fc) in moves:
            return (tr, tc, fr, fc)
    if r < 0.5:
        capturing = [m for m in moves if captures_something(game, m)]
        if capturing:
            return capturing[rng.integers(len(capturing))]
    if r < 0.62:
        on_edge = [m for m in moves if m[2] in (0, n - 1) or m[3] in (0, n - 1)]
        if on_edge:
            return on_edge[rng.integers(len(on_edge))]
    if r < 0.8:
        kings = np.argwhere(game.board == KING)
        if game.current_player == 1:
            king_moves = [m for m in moves if game.board[m[0], m[1]] == KING]
            if king_moves:
                return king_moves[rng.integers(len(king_moves))]
        elif len(kings):
            kr, kc = kings[0]
            near = [m for m in moves if abs(m[2] - kr) + abs(m[3] - kc) == 1]
            if near:
                return near[rng.integers(len(near))]
    return moves[rng.integers(len(moves))]


def play(name, rng):
    game = Tafl(name)
    record = {'rules': game.rules.to_dict(), 'source': f'random {name}', 'start': board_string(game.board),
              'start_player': int(game.current_player), 'plies': []}
    history = []
    while not game.game_over and game.move_count < args.max_plies:
        moves = game.get_legal_moves()
        move = choose_move(game, moves, rng, history)
        ply = snapshot(game, False)
        ply['move'] = pack(move, game.size)
        assert game.make_move(move)
        ply.update(result(game))
        record['plies'].append(ply)
        history.append(move)
    return record


class RecordingTafl(Tafl):
    """A Tafl that records every move as a one-move game, from the position before it."""
    records = []
    current_test = ''

    def make_move(self, move):
        legal = move in self.get_legal_moves() and not self.game_over
        ply = snapshot(self, True) if legal else None
        played = super().make_move(move)
        if ply is not None and played:
            ply['move'] = pack(move, self.size)
            ply.update(result(self))
            RecordingTafl.records.append({'rules': self.rules.to_dict(), 'source': RecordingTafl.current_test,
                                          'plies': [ply]})
        return played


def rule_positions():
    """Run test_rules.py with the recording Tafl and return the recorded moves."""
    import test_rules
    test_rules.Tafl = RecordingTafl
    tests = [test_rules.test_movement, test_rules.test_king_goal, test_rules.test_king_capture,
             test_rules.test_hostile_squares, test_rules.test_shieldwall, test_rules.test_exit_fort,
             test_rules.test_encirclement, test_rules.test_repetition]
    for test in tests:
        RecordingTafl.current_test = f'test_rules.{test.__name__}'
        with contextlib.redirect_stdout(io.StringIO()):
            assert test(), f'{test.__name__} failed in the training code'
    return RecordingTafl.records


def fuzz_cases(rng, count=4000):
    """
    Random positions for the two rules random games almost never reach: exit forts (a king on the
    edge among many defenders) and shieldwalls (crowded edges). For each, Python's verdict: whether
    the king is in an exit fort, and the captures of a random legal move.
    """
    from dataclasses import replace
    copenhagen = RULESETS['copenhagen']
    rule_sets = [copenhagen, replace(copenhagen, shieldwall=False), replace(copenhagen, king_armed=False)]
    forts, captures = [], []
    n = 11
    for i in range(count):
        rules = rule_sets[i % len(rule_sets)]
        game = Tafl(rules)
        board = np.zeros((n, n), dtype=np.int8)
        # A king on the edge (not a corner), defenders crowded around him, attackers further away
        kc = int(rng.integers(1, n - 1))
        board[n - 1, kc] = KING
        for r in range(n):
            for c in range(n):
                if board[r, c] or (r in (0, n - 1) and c in (0, n - 1)):
                    continue
                dist = max(abs(r - (n - 1)), abs(c - kc))
                if dist <= 3 and rng.random() < 0.5:
                    board[r, c] = 2
                elif dist >= 2 and rng.random() < (0.25 if r in (0, n - 1) or c in (0, n - 1) else 0.07):
                    board[r, c] = 1
        board = np.rot90(board, int(rng.integers(4))).copy()
        game.board[:] = board
        game.current_player = int(rng.integers(2))
        game.position_history = [game._position_key()]
        forts.append({'rules': rules.to_dict(), 'board': board_string(board), 'fort': bool(game._king_in_exit_fort())})
        moves = game.get_legal_moves()
        if moves:
            fr, fc, tr, tc = moves[rng.integers(len(moves))]
            after = board.copy()
            after[tr, tc], after[fr, fc] = after[fr, fc], 0
            captures.append(capture_case(game, rules, after, tr, tc))
    for i in range(count):
        rules = rule_sets[i % len(rule_sets)]
        after, tr, tc = shieldwall_position(rng, n)
        captures.append(capture_case(Tafl(rules), rules, after, tr, tc))
    return forts, captures


def capture_case(game, rules, after, tr, tc):
    """Python's captures by the piece that has just moved to (tr, tc) on board `after`."""
    n = game.size
    captured, king_captured = game._find_captures(after, tr, tc)
    return {'rules': rules.to_dict(), 'board_after': board_string(after), 'to': int(tr * n + tc),
            'captured': sorted({int(r * n + c) for r, c in captured}), 'king_captured': bool(king_captured)}


def shieldwall_position(rng, n):
    """
    A position where the piece that just moved may close a shieldwall: a row of 2-4 enemy pieces
    along the bottom edge (the king among them now and then), mostly with the mover's pieces in
    front of them, a bracket of the mover's side (or the corner) at one end and the moved piece at
    the other; a few more pieces at random; then turned to a random edge.
    """
    board = np.zeros((n, n), dtype=np.int8)
    attackers_move = rng.random() < 0.5
    kings = [0]

    def pick(side_attackers):
        if side_attackers:
            return 1
        if kings[0] == 0 and rng.random() < 0.2:
            kings[0] = 1
            return KING
        return 2

    k = int(rng.integers(2, 5))
    start = int(rng.integers(1, n - k))  # the row is start .. start+k-1; its far end start+k
    for c in range(start, start + k):
        board[n - 1, c] = pick(not attackers_move)
        if rng.random() < 0.88:
            board[n - 2, c] = pick(attackers_move)
    if start - 1 > 0 and rng.random() < 0.9:
        board[n - 1, start - 1] = pick(attackers_move)  # the bracket (start - 1 == 0 is the corner)
    end = start + k
    if end == n - 1:  # the moved piece cannot stand on the corner; bracket that end by it instead
        board[n - 1, start - 1] = 0
        board[n - 1, :] = board[n - 1, ::-1].copy()
        board[n - 2, :] = board[n - 2, ::-1].copy()
        end = n - 1 - end
    board[n - 1, end] = pick(attackers_move)
    for r in range(n - 2):
        for c in range(n):
            if board[r, c] == 0 and rng.random() < 0.06:
                board[r, c] = pick(rng.random() < 0.5)
    if kings[0] == 0:
        empty = np.argwhere(board[:n - 2] == 0)
        r, c = empty[rng.integers(len(empty))]
        board[r, c] = KING
    for corner in ((0, 0), (0, n - 1), (n - 1, 0), (n - 1, n - 1)):
        if board[corner] != KING:
            board[corner] = 0
    turns = int(rng.integers(4))
    board = np.rot90(board, turns).copy()
    tr, tc = n - 1, end
    for _ in range(turns):  # where the moved piece went under the rotation
        tr, tc = n - 1 - tc, tr
    return board, tr, tc


def main():
    os.makedirs(args.out, exist_ok=True)
    rng = np.random.default_rng(args.seed)
    forts, captures = fuzz_cases(rng)
    path = os.path.join(args.out, 'fuzz_forts_and_captures.json.gz')
    with gzip.open(path, 'wt') as f:
        json.dump({'forts': forts, 'captures': captures}, f)
    walls = sum(1 for c in captures if len(c['captured']) >= 2 and c['rules']['shieldwall'])
    print(f'fuzz: {len(forts)} fort positions ({sum(f["fort"] for f in forts)} forts), '
          f'{len(captures)} captures ({walls} with two or more pieces) -> {path}')
    for old in ('reference_brandubh.json.gz', 'reference_tablut.json.gz', 'reference_hnefatafl.json.gz'):
        path = os.path.join(args.out, old)
        if os.path.exists(path):
            os.remove(path)  # from before the named rule sets
    for name in RULESETS:
        games = [play(name, rng) for _ in range(args.games)]
        path = os.path.join(args.out, f'reference_{name}.json.gz')
        with gzip.open(path, 'wt') as f:
            json.dump({'planes': PLANES.plane_names(), 'games': games}, f)
        plies = sum(len(g['plies']) for g in games)
        endings = {}
        for g in games:
            last = g['plies'][-1]
            key = 'unfinished' if not last['game_over'] else {None: 'draw', 0: 'attackers', 1: 'defenders'}[last['winner']]
            endings[key] = endings.get(key, 0) + 1
        print(f'{name}: {len(games)} games, {plies} plies, results {endings} -> {path}')
    records = rule_positions()
    path = os.path.join(args.out, 'reference_rule_positions.json.gz')
    with gzip.open(path, 'wt') as f:
        json.dump({'planes': PLANES.plane_names(), 'games': records}, f)
    print(f'test_rules.py: {len(records)} recorded moves -> {path}')


if __name__ == '__main__':
    main()
