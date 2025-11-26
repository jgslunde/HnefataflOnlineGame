/**
 * Monte Carlo Tree Search for Brandubh with Neural Network evaluation
 * Based on AlphaZero MCTS algorithm
 * 
 * The MCTS maintains a search tree where each node represents a game state.
 * Each node stores statistics:
 * - N(s,a): visit count
 * - W(s,a): total action value
 * - Q(s,a): mean action value
 * - P(s,a): prior probability from neural network
 */

class MCTSNode {
    /**
     * Node in the MCTS tree
     * @param {Object} gameState - snapshot of the game board
     * @param {string} player - 'attacker' or 'defender'
     * @param {MCTSNode} parent - parent node
     * @param {Object} parentAction - the move that led to this node
     * @param {number} prior - prior probability from neural network
     */
    constructor(gameState, player, parent = null, parentAction = null, prior = 0.0) {
        this.gameState = gameState;  // {board: [...], player: '...'}
        this.player = player;
        this.parent = parent;
        this.parentAction = parentAction;
        this.prior = prior;
        
        // Children: Map from move key to MCTSNode
        this.children = new Map();
        
        // Statistics
        this.visitCount = 0;
        this.totalValue = 0.0;
        this.meanValue = 0.0;
        
        // Flags
        this.isExpanded = false;
        this.isTerminal = false;
        this.terminalValue = null;
    }
    
    /**
     * Check if this is a leaf node (not expanded)
     */
    isLeaf() {
        return !this.isExpanded;
    }
    
    /**
     * Expand this node by creating children for all legal moves
     * @param {Array} legalMoves - array of {fromRow, fromCol, toRow, toCol, policyIndex}
     * @param {Float32Array} policyProbs - probability distribution from neural network
     */
    expand(legalMoves, policyProbs) {
        if (this.isExpanded) {
            // Already expanded - this is a safety guard and is normal during MCTS
            return;
        }
        
        // Extract probabilities for legal moves and normalize
        const probs = new Float32Array(legalMoves.length);
        let probSum = 0;
        
        for (let i = 0; i < legalMoves.length; i++) {
            probs[i] = policyProbs[legalMoves[i].policyIndex];
            probSum += probs[i];
        }
        
        // Normalize (if sum is 0, use uniform distribution)
        if (probSum > 0) {
            for (let i = 0; i < probs.length; i++) {
                probs[i] /= probSum;
            }
        } else {
            const uniform = 1.0 / legalMoves.length;
            probs.fill(uniform);
        }
        
        // Create child nodes (lazy - don't compute game states yet)
        for (let i = 0; i < legalMoves.length; i++) {
            const move = legalMoves[i];
            const moveKey = `${move.fromRow},${move.fromCol},${move.toRow},${move.toCol}`;
            const nextPlayer = this.player === 'attacker' ? 'defender' : 'attacker';
            
            this.children.set(moveKey, new MCTSNode(
                null,  // Lazy initialization
                nextPlayer,
                this,
                move,
                probs[i]
            ));
        }
        
        this.isExpanded = true;
    }
    
    /**
     * Select best child using PUCT algorithm with FPU (First Play Urgency)
     * PUCT = Q(s,a) + c_puct * P(s,a) * sqrt(N(s)) / (1 + N(s,a))
     * 
     * For unvisited nodes, uses relative FPU:
     * Q_unvisited = -(parent.meanValue - fpuReduction)
     * 
     * @param {number} cPuct - exploration constant
     * @param {number} fpuReduction - FPU reduction relative to parent value
     * @returns {Object} {moveKey, child}
     */
    selectChild(cPuct = 1.4, fpuReduction = 0.5) {
        let bestScore = -Infinity;
        let bestMoveKey = null;
        let bestChild = null;
        
        const sqrtParentVisits = Math.sqrt(this.visitCount);
        
        for (let [moveKey, child] of this.children) {
            // Q value (from child's perspective, so negate for parent)
            let qValue;
            if (child.visitCount > 0) {
                // Visited: use actual mean value
                qValue = -child.meanValue;
            } else {
                // Unvisited: use FPU (First Play Urgency)
                // Relative to parent: assume child is slightly worse than parent
                qValue = -(this.meanValue - fpuReduction);
            }
            
            // U value (exploration bonus)
            const uValue = cPuct * child.prior * sqrtParentVisits / (1 + child.visitCount);
            
            const score = qValue + uValue;
            
            if (score > bestScore) {
                bestScore = score;
                bestMoveKey = moveKey;
                bestChild = child;
            }
        }
        
        return { moveKey: bestMoveKey, child: bestChild };
    }
    
    /**
     * Update node statistics after a simulation
     * @param {number} value - value from the perspective of the player at this node
     */
    update(value) {
        this.visitCount++;
        this.totalValue += value;
        this.meanValue = this.totalValue / this.visitCount;
    }
    
    /**
     * Get probability distribution over actions based on visit counts
     * @param {number} temperature - sampling temperature
     * @returns {Map} map from moveKey to probability
     */
    getVisitDistribution(temperature = 1.0) {
        if (this.children.size === 0) {
            return new Map();
        }
        
        const moves = Array.from(this.children.keys());
        const visits = moves.map(key => this.children.get(key).visitCount);
        
        let probs;
        if (temperature === 0) {
            // Deterministic: choose most visited
            probs = new Float32Array(visits.length);
            const maxVisits = Math.max(...visits);
            const maxIndex = visits.indexOf(maxVisits);
            probs[maxIndex] = 1.0;
        } else {
            // Apply temperature
            probs = new Float32Array(visits.length);
            for (let i = 0; i < visits.length; i++) {
                probs[i] = Math.pow(visits[i], 1.0 / temperature);
            }
            const sum = probs.reduce((a, b) => a + b, 0);
            for (let i = 0; i < probs.length; i++) {
                probs[i] /= sum;
            }
        }
        
        const distribution = new Map();
        for (let i = 0; i < moves.length; i++) {
            distribution.set(moves[i], probs[i]);
        }
        
        return distribution;
    }
}


class MCTS {
    /**
     * Monte Carlo Tree Search with neural network evaluation
     * @param {Object} network - ONNX neural network session
     * @param {MoveEncoder} moveEncoder - move encoder instance
     * @param {number} numSimulations - number of simulations per search
     * @param {number} cPuct - exploration constant
     * @param {number} fpuReduction - First Play Urgency reduction (relative to parent)
     */
    constructor(network, moveEncoder, numSimulations = 100, cPuct = 1.2, fpuReduction = 0.5) {
        this.network = network;
        this.moveEncoder = moveEncoder;
        this.numSimulations = numSimulations;
        this.cPuct = cPuct;
        this.fpuReduction = fpuReduction;
        this.root = null;
        this.lastRawPolicy = null; // Store last raw policy output for visualization
    }
    
    /**
     * Run MCTS search from the given game state
     * @param {HTMLTableElement} boardElement - current game board
     * @param {string} player - 'attacker' or 'defender'
     * @returns {Map} map from moveKey to visit probability
     */
    async search(boardElement, player) {
        // Validate board state before starting search
        if (!boardElement || !boardElement.rows || boardElement.rows.length !== 7) {
            console.error('[MCTS] Invalid board element');
            throw new Error('Invalid board state for MCTS search');
        }
        
        // Check for animated spans (capture in progress)
        for (let r = 0; r < 7; r++) {
            if (!boardElement.rows[r] || !boardElement.rows[r].cells || boardElement.rows[r].cells.length !== 7) {
                console.error(`[MCTS] Invalid board row ${r}`);
                throw new Error(`Invalid board row ${r}`);
            }
            for (let c = 0; c < 7; c++) {
                const cell = boardElement.rows[r].cells[c];
                if (cell.querySelector('span')) {
                    console.error(`[MCTS] Cell (${r},${c}) has animated span - board state invalid for search`);
                    throw new Error('Cannot start MCTS search while capture animations are in progress');
                }
            }
        }
        
        console.log(`[MCTS] Starting search for ${player} with ${this.numSimulations} simulations`);
        console.log(`[MCTS] Search parameters: c_puct=${this.cPuct}, fpuReduction=${this.fpuReduction}`);
        const startTime = performance.now();
        
        // Capture current game state
        const rootState = this.captureGameState(boardElement, player);
        
        // Check if we can reuse the existing root
        // This is important for continuous eval - don't destroy the tree between searches
        const canReuseRoot = this.root && 
                            this.root.player === player && 
                            this.statesEqual(this.root.gameState, rootState);
        
        if (canReuseRoot) {
            console.log(`[MCTS] Reusing existing root (${this.root.visitCount} visits)`);
        } else {
            console.log(`[MCTS] Creating new root node`);
            this.root = new MCTSNode(rootState, player);
        }
        
        // Check if game is already over
        const gameOver = this.checkGameOver(boardElement);
        if (gameOver.isOver) {
            console.log(`[MCTS] Game is already over, winner: ${gameOver.winner}`);
            this.root.isTerminal = true;
            this.root.terminalValue = gameOver.value;
            return new Map();
        }
        
        // Run simulations in batches to avoid freezing the UI
        const batchSize = 10; // Process 10 simulations at a time
        for (let sim = 0; sim < this.numSimulations; sim += batchSize) {
            const batchEnd = Math.min(sim + batchSize, this.numSimulations);
            
            // Run a batch of simulations
            for (let i = sim; i < batchEnd; i++) {
                await this.runSimulation(boardElement);
            }
            
            // Yield control to browser to keep UI responsive
            if (batchEnd < this.numSimulations) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        
        const elapsedTime = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`[MCTS] Search completed in ${elapsedTime}s`);
        console.log(`[MCTS] Root visits: ${this.root.visitCount}, Mean value: ${this.root.meanValue.toFixed(3)}`);
        
        // Get visit distribution
        const distribution = this.root.getVisitDistribution();
        
        if (distribution.size === 0) {
            console.error("[MCTS] ERROR: Distribution is empty despite having children!");
        }
        
        // Log top moves
        const sortedMoves = Array.from(distribution.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        console.log("[MCTS] Top 5 moves:");
        for (let [moveKey, prob] of sortedMoves) {
            const child = this.root.children.get(moveKey);
            console.log(`  ${moveKey}: visits=${child.visitCount}, prob=${(prob * 100).toFixed(1)}%, Q=${child.meanValue.toFixed(3)}`);
        }
        
        return distribution;
    }
    
    /**
     * Run a single MCTS simulation
     * @param {HTMLTableElement} originalBoard - original game board (not modified)
     */
    async runSimulation(originalBoard) {
        let node = this.root;
        const searchPath = [node];
        
        // Create a clone of the board for this simulation
        let boardClone = this.cloneBoard(originalBoard);
        
        // Selection: traverse tree until leaf
        while (!node.isLeaf() && !node.isTerminal) {
            const { moveKey, child } = node.selectChild(this.cPuct, this.fpuReduction);
            
            // Lazy initialization: apply move to board clone if child state not yet computed
            if (child.gameState === null) {
                this.applyMove(boardClone, child.parentAction, node.player);
                child.gameState = this.captureGameState(boardClone, child.player);
            } else {
                // Restore board state from child
                this.restoreGameState(boardClone, child.gameState);
            }
            
            node = child;
            searchPath.push(node);
        }
        
        // Evaluate leaf node
        let value = 0;
        
        if (node.isTerminal) {
            // Terminal node: use game result
            value = node.terminalValue;
        } else {
            // Non-terminal leaf: evaluate with network and expand
            const gameOver = this.checkGameOver(boardClone);
            
            if (gameOver.isOver) {
                node.isTerminal = true;
                // Convert terminal value from attacker's perspective to current player's perspective
                const valueFromAttackerPerspective = gameOver.value;
                const valueFromCurrentPlayerPerspective = node.player === 'attacker' ? valueFromAttackerPerspective : -valueFromAttackerPerspective;
                node.terminalValue = valueFromCurrentPlayerPerspective;
                value = valueFromCurrentPlayerPerspective;
            } else {
                const { policyProbs, value: networkValue } = await this.evaluate(boardClone, node.player);
                value = networkValue;
                
                // Expand node
                const legalMoves = this.moveEncoder.getAllLegalMoves(boardClone, node.player);
                if (legalMoves.length > 0) {
                    node.expand(legalMoves, policyProbs);
                } else {
                    // No legal moves - game over (stalemate)
                    node.isTerminal = true;
                    node.terminalValue = -1.0;  // Loss for current player
                    value = -1.0;
                }
            }
        }
        
        // Backup: propagate value up the tree
        for (let i = searchPath.length - 1; i >= 0; i--) {
            searchPath[i].update(value);
            value = -value;  // Flip value for opponent
        }
    }
    
    /**
     * Evaluate a game state with the neural network
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Object} {policyProbs, value}
     */
    async evaluate(boardElement, player) {
        // Get state representation (4 planes: attackers, defenders, king, current_player)
        const state = this.getStateRepresentation(boardElement, player);
        
        // Validate state tensor
        if (!state || state.length !== 196) {
            console.error(`[MCTS] Invalid state tensor! Length: ${state?.length}`);
            throw new Error('Invalid state tensor for neural network');
        }
        
        // Check for NaN or Infinity
        for (let i = 0; i < state.length; i++) {
            if (!isFinite(state[i])) {
                console.error(`[MCTS] Invalid value in state tensor at index ${i}: ${state[i]}`);
                throw new Error('State tensor contains invalid values');
            }
        }
        
        // CRITICAL FIX: Create a defensive copy to avoid buffer issues
        // ONNX.js may be mutating or detaching the buffer internally
        const stateCopy = new Float32Array(state);
        
        // WORKAROUND: Add tiny delay to let ONNX.js WebAssembly backend clean up between calls
        // This prevents internal state corruption in rapid successive inference calls
        await new Promise(resolve => setTimeout(resolve, 1));
        
        // Run neural network inference with the copy
        const feeds = { input: new ort.Tensor('float32', stateCopy, [1, 4, 7, 7]) };
        const results = await this.network.run(feeds);
        
        // Extract policy and value
        const policyLogits = results.policy.data;  // Shape: (1, 1176)
        const value = results.value.data[0];  // Shape: (1, 1)
        
        // Store raw policy for visualization
        this.lastRawPolicy = new Float32Array(policyLogits);
        
        // Mask illegal moves
        const legalMask = this.moveEncoder.getLegalMoveMask(boardElement, player);
        const maskedLogits = new Float32Array(1176);
        for (let i = 0; i < 1176; i++) {
            maskedLogits[i] = legalMask[i] > 0 ? policyLogits[i] : -1e8;
        }
        
        // Convert to probabilities (softmax)
        const policyProbs = this.softmax(maskedLogits);
        
        return { policyProbs, value };
    }
    
    /**
     * Get state representation for neural network
     * Returns 4 planes: [attackers, defenders, king, current_player_plane]
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Float32Array} array of shape (4, 7, 7) = 196 elements
     */
    getStateRepresentation(boardElement, player) {
        const state = new Float32Array(4 * 7 * 7);
        
        const attackersPlane = 0;
        const defendersPlane = 49;
        const kingPlane = 98;
        const playerPlane = 147;
        
        const playerValue = player === 'attacker' ? 0.0 : 1.0;
        
        // Helper function to extract piece from cell
        const getPiece = (cell) => {
            for (let node of cell.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    return node.textContent.trim();
                }
            }
            return '';
        };
        
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const cell = boardElement.rows[r]?.cells?.[c];
                if (!cell) {
                    console.warn(`[MCTS] Cell at (${r},${c}) is undefined!`);
                    continue;
                }
                
                const idx = r * 7 + c;
                
                // Get piece from cell
                const piece = getPiece(cell);
                
                if (piece === '⚫') {
                    state[attackersPlane + idx] = 1.0;
                } else if (piece === '⚪') {
                    state[defendersPlane + idx] = 1.0;
                } else if (piece === '⬜') {
                    state[kingPlane + idx] = 1.0;
                }
                
                state[playerPlane + idx] = playerValue;
            }
        }
        
        return state;
    }
    
    /**
     * Softmax function
     * @param {Float32Array} logits 
     * @returns {Float32Array} probabilities
     */
    softmax(logits) {
        const maxLogit = Math.max(...logits);
        const expLogits = new Float32Array(logits.length);
        let sum = 0;
        
        for (let i = 0; i < logits.length; i++) {
            expLogits[i] = Math.exp(logits[i] - maxLogit);
            sum += expLogits[i];
        }
        
        const probs = new Float32Array(logits.length);
        for (let i = 0; i < logits.length; i++) {
            probs[i] = expLogits[i] / sum;
        }
        
        return probs;
    }
    
    /**
     * Select a move using MCTS
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @param {number} temperature 
     * @returns {Object} {piece, target} - cells to move from/to
     */
    async selectMove(boardElement, player, temperature = 0.0) {
        console.log(`[MCTS] selectMove called for ${player}, temperature=${temperature}`);
        
        const visitProbs = await this.search(boardElement, player);
        
        if (visitProbs.size === 0) {
            console.error("[MCTS] No legal moves available!");
            return null;
        }
        
        // Select move based on visit probabilities
        let selectedMoveKey;
        
        if (temperature === 0) {
            // Choose most visited move
            let maxProb = -1;
            for (let [moveKey, prob] of visitProbs) {
                if (prob > maxProb) {
                    maxProb = prob;
                    selectedMoveKey = moveKey;
                }
            }
        } else {
            // Sample from distribution
            const moves = Array.from(visitProbs.keys());
            const probs = Array.from(visitProbs.values());
            selectedMoveKey = this.sampleFromDistribution(moves, probs);
        }
        
        console.log(`[MCTS] Selected move: ${selectedMoveKey}`);
        
        // Parse move key
        const [fromRow, fromCol, toRow, toCol] = selectedMoveKey.split(',').map(Number);
        
        // Return as piece and target cells
        return {
            piece: boardElement.rows[fromRow].cells[fromCol],
            target: boardElement.rows[toRow].cells[toCol]
        };
    }
    
    /**
     * Sample from a probability distribution
     * @param {Array} items 
     * @param {Array} probs 
     * @returns {*} sampled item
     */
    sampleFromDistribution(items, probs) {
        const rand = Math.random();
        let cumSum = 0;
        
        for (let i = 0; i < items.length; i++) {
            cumSum += probs[i];
            if (rand < cumSum) {
                return items[i];
            }
        }
        
        return items[items.length - 1];
    }
    
    /**
     * Capture current game state as a snapshot
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Object} {board, player}
     */
    captureGameState(boardElement, player) {
        const board = [];
        for (let r = 0; r < 7; r++) {
            const row = [];
            for (let c = 0; c < 7; c++) {
                // Use helper to get piece text (ignores policy overlay divs)
                let piece = '';
                const cell = boardElement.rows[r].cells[c];
                for (let node of cell.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        piece = node.textContent.trim();
                        break;
                    }
                }
                row.push(piece);
            }
            board.push(row);
        }
        return { board, player };
    }
    
    /**
     * Restore game state to board
     * @param {HTMLTableElement} boardElement 
     * @param {Object} gameState 
     */
    restoreGameState(boardElement, gameState) {
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const cell = boardElement.rows[r].cells[c];
                const piece = gameState.board[r][c];
                
                // Find or create text node to set piece (preserves policy overlay divs)
                let textNode = null;
                for (let node of cell.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        textNode = node;
                        break;
                    }
                }
                
                if (textNode) {
                    textNode.textContent = piece;
                } else {
                    // No text node exists, create one
                    cell.insertBefore(document.createTextNode(piece), cell.firstChild);
                }
            }
        }
    }
    
    /**
     * Check if two game states are equal
     * @param {Object} state1 
     * @param {Object} state2 
     * @returns {boolean}
     */
    statesEqual(state1, state2) {
        if (!state1 || !state2) return false;
        if (state1.player !== state2.player) return false;
        
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                if (state1.board[r][c] !== state2.board[r][c]) {
                    return false;
                }
            }
        }
        
        return true;
    }
    
    /**
     * Clone board element (for simulation)
     * @param {HTMLTableElement} boardElement 
     * @returns {HTMLTableElement}
     */
    cloneBoard(boardElement) {
        const clone = document.createElement('table');
        for (let r = 0; r < 7; r++) {
            const rowClone = document.createElement('tr');
            for (let c = 0; c < 7; c++) {
                const cellClone = document.createElement('td');
                
                // Only copy the piece text, not policy overlay divs or animated spans
                const originalCell = boardElement.rows[r].cells[c];
                
                // Skip cells with animated spans (capture in progress)
                if (originalCell.querySelector('span')) {
                    console.warn(`[MCTS] Cell (${r},${c}) has animated span during clone, treating as empty`);
                    cellClone.textContent = '';
                } else {
                    let piece = '';
                    for (let node of originalCell.childNodes) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            piece = node.textContent.trim();
                            break;
                        }
                    }
                    cellClone.textContent = piece;
                }
                
                rowClone.appendChild(cellClone);
            }
            clone.appendChild(rowClone);
        }
        return clone;
    }
    
    /**
     * Apply a move to the board (modifies board in place)
     * @param {HTMLTableElement} boardElement 
     * @param {Object} move - {fromRow, fromCol, toRow, toCol}
     * @param {string} player 
     */
    applyMove(boardElement, move, player) {
        const { fromRow, fromCol, toRow, toCol } = move;
        const piece = boardElement.rows[fromRow].cells[fromCol].innerText;
        
        boardElement.rows[fromRow].cells[fromCol].innerText = '';
        boardElement.rows[toRow].cells[toCol].innerText = piece;
        
        // Apply captures (simplified - doesn't change game outcome for value estimation)
        this.applyCaptures(boardElement, toRow, toCol, piece);
    }
    
    /**
     * Apply captures after a move
     * @param {HTMLTableElement} boardElement 
     * @param {number} r 
     * @param {number} c 
     * @param {string} piece 
     */
    applyCaptures(boardElement, r, c, piece) {
        // Check all 4 directions for captures
        const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        
        for (let [dr, dc] of directions) {
            const nr = r + dr;
            const nc = c + dc;
            
            if (nr < 0 || nr >= 7 || nc < 0 || nc >= 7) continue;
            
            const enemy = boardElement.rows[nr].cells[nc].innerText;
            if (enemy === '' || this.isFriendly(piece, enemy)) continue;
            
            // Check opposite side
            const nr2 = nr + dr;
            const nc2 = nc + dc;
            
            if (nr2 < 0 || nr2 >= 7 || nc2 < 0 || nc2 >= 7) continue;
            
            const opposite = boardElement.rows[nr2].cells[nc2].innerText;
            const isHostileSquare = this.isHostileSquare(nr2, nc2);
            
            if (this.isFriendly(piece, opposite) || isHostileSquare) {
                // Capture!
                boardElement.rows[nr].cells[nc].innerText = '';
            }
        }
    }
    
    /**
     * Check if two pieces are friendly
     * @param {string} piece1 
     * @param {string} piece2 
     * @returns {boolean}
     */
    isFriendly(piece1, piece2) {
        if (piece1 === '' || piece2 === '') return false;
        if (piece1 === '⚫') return piece2 === '⚫';
        return (piece1 === '⚪' || piece1 === '⬜') && (piece2 === '⚪' || piece2 === '⬜');
    }
    
    /**
     * Check if a square is hostile (corner)
     * @param {number} r 
     * @param {number} c 
     * @returns {boolean}
     */
    isHostileSquare(r, c) {
        return (r === 0 || r === 6) && (c === 0 || c === 6);
    }
    
    /**
     * Check if game is over
     * @param {HTMLTableElement} boardElement 
     * @returns {Object} {isOver, winner, value}
     */
    checkGameOver(boardElement) {
        let kingPresent = false;
        let attackerCount = 0;
        
        for (let row of boardElement.rows) {
            for (let cell of row.cells) {
                // Get the first text node (ignore policy overlay divs)
                let piece = '';
                for (let node of cell.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        piece = node.textContent.trim();
                        break;
                    }
                }
                
                if (piece === '⬜') {
                    kingPresent = true;
                    
                    // Check if king is on a corner
                    const r = cell.parentNode.rowIndex;
                    const c = cell.cellIndex;
                    if ((r === 0 || r === 6) && (c === 0 || c === 6)) {
                        // Defenders win: return value from attacker's perspective
                        return { isOver: true, winner: 'defender', value: -1.0 };
                    }
                } else if (piece === '⚫') {
                    attackerCount++;
                }
            }
        }
        
        if (!kingPresent) {
            // Attackers win: return value from attacker's perspective
            return { isOver: true, winner: 'attacker', value: 1.0 };
        }
        
        if (attackerCount === 0) {
            // Defenders win: return value from attacker's perspective
            return { isOver: true, winner: 'defender', value: -1.0 };
        }
        
        return { isOver: false, winner: null, value: 0 };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MCTSNode, MCTS };
}
