# HnefataflOnlineGame

## Known bugs
- It sometimes takes an additional turn of play before the win screen pops up after a win.
- The enemies pieces sometimes appear clickable during their turn when playing against an AI.

## TODO (frontend)
- Display number of lost pieces.
- Display whose turn it is.
- Display current evaluation according to computer (with on/off toggle).
- Make moves (especially the AI ones) more obvious, and the "move and capture" more smooth. Maybe flash the move-from, move-to, and capture squares for a second.

## TODO (AI)
- Get OpenMP to work with WebAssembly, for faster AI evaluations.
- Get the Zobrist hash table implementation up and running.
