Module['onRuntimeInitialized'] = function() {
    // Now you can safely call functions from your WebAssembly module
    console.log("Emscripten module loaded.")
};

// Helper function to get the piece character from a cell, ignoring policy overlay
function getPieceFromCell(cell) {
    for (let node of cell.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.trim();
        }
    }
    return '';
}

// Helper function to set the piece character in a cell, preserving policy overlay
function setPieceInCell(cell, piece) {
    for (let node of cell.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            node.textContent = piece;
            return;
        }
    }
    // If no text node exists, create one
    const textNode = document.createTextNode(piece);
    cell.insertBefore(textNode, cell.firstChild);
}

function isDefender(piece) {
    return ['⚪', '⬜'].includes(piece);
}

/**
 * Get a hash string representing the current board position and player
 */
function getPositionHash(boardElement, player) {
    let hash = '';
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            const piece = getPieceFromCell(cell);
            hash += piece || '.';
        }
    }
    hash += '|' + player;
    return hash;
}

/**
 * Check if a move would cause three-fold repetition
 * Returns true if the resulting position would be the third occurrence
 */
function wouldCauseThreefoldRepetition(sourceCell, targetCell, boardElement, player) {
    // Simulate the move
    const piece = getPieceFromCell(sourceCell);
    const originalTargetPiece = getPieceFromCell(targetCell);
    
    setPieceInCell(targetCell, piece);
    setPieceInCell(sourceCell, '');
    
    // Simulate captures
    const targetRow = targetCell.parentNode.rowIndex;
    const targetCol = targetCell.cellIndex;
    const directions = [
        { dr: -1, dc: 0 },  // up
        { dr: 1, dc: 0 },   // down
        { dr: 0, dc: -1 },  // left
        { dr: 0, dc: 1 }    // right
    ];
    
    const capturedPieces = []; // Store original pieces to restore
    
    for (let dir of directions) {
        const enemyRow = targetRow + dir.dr;
        const enemyCol = targetCol + dir.dc;
        const allyRow = enemyRow + dir.dr;
        const allyCol = enemyCol + dir.dc;

        if (enemyRow < 0 || enemyRow >= 7 || enemyCol < 0 || enemyCol >= 7) continue;
        if (allyRow < 0 || allyRow >= 7 || allyCol < 0 || allyCol >= 7) continue;

        const enemyCell = boardElement.rows[enemyRow].cells[enemyCol];
        const allyCell = boardElement.rows[allyRow].cells[allyCol];
        
        const targetPiece = getPieceFromCell(targetCell);
        const enemyPiece = getPieceFromCell(enemyCell);
        const allyPiece = getPieceFromCell(allyCell);

        if (targetPiece === '⚫' && enemyPiece === '⚪' && (allyPiece === '⚫' || isRestrictedSquare(allyRow, allyCol))) {
            capturedPieces.push({ cell: enemyCell, piece: enemyPiece });
            setPieceInCell(enemyCell, '');
        } else if ((targetPiece === '⚪' || targetPiece === '⬜') && enemyPiece === '⚫' && (isDefender(allyPiece) || isRestrictedSquare(allyRow, allyCol))) {
            capturedPieces.push({ cell: enemyCell, piece: enemyPiece });
            setPieceInCell(enemyCell, '');
        } else if (targetPiece === '⚫' && enemyPiece === '⬜' && (allyPiece === '⚫' || isRestrictedSquare(allyRow, allyCol))) {
            capturedPieces.push({ cell: enemyCell, piece: enemyPiece });
            setPieceInCell(enemyCell, '');
        }
    }
    
    // Get the position hash after the simulated move (note: player is still the current player after their move)
    const positionHash = getPositionHash(boardElement, player);
    
    // Undo the simulation - restore captured pieces
    for (let captured of capturedPieces) {
        setPieceInCell(captured.cell, captured.piece);
    }
    
    // Undo the move
    setPieceInCell(sourceCell, piece);
    setPieceInCell(targetCell, originalTargetPiece);
    
    // Count occurrences of this position in history
    const occurrences = positionHistory.filter(hash => hash === positionHash).length;
    
    // Debug logging
    if (occurrences >= 2) {
        console.log(`THREE-FOLD REPETITION BLOCKED! This position has occurred ${occurrences} times already.`);
        console.log(`Position hash: ${positionHash.substring(0, 30)}...`);
    }
    
    // If this would be the third occurrence, it's illegal
    return occurrences >= 2;
}

/**
 * Record the current position in history
 */
function recordPosition(boardElement, player) {
    const positionHash = getPositionHash(boardElement, player);
    positionHistory.push(positionHash);
    
    // Debug: Count occurrences
    const count = positionHistory.filter(h => h === positionHash).length;
    if (count > 1) {
        console.log(`Position occurred ${count} times. Hash: ${positionHash.substring(0, 20)}...`);
    }
}

function squaresBetweenAreEmpty(source, target, boardElement) {
    const sourceRow = source.parentNode.rowIndex;
    const sourceCol = source.cellIndex;
    const targetRow = target.parentNode.rowIndex;
    const targetCol = target.cellIndex;

    if (sourceRow === targetRow) {  // Moving horizontally
        const startCol = Math.min(sourceCol, targetCol);
        const endCol = Math.max(sourceCol, targetCol);

        for (let col = startCol + 1; col < endCol; col++) {
            if (getPieceFromCell(boardElement.rows[sourceRow].cells[col]) !== '') {
                return false;
            }
        }
    } else if (sourceCol === targetCol) {  // Moving vertically
        const startRow = Math.min(sourceRow, targetRow);
        const endRow = Math.max(sourceRow, targetRow);

        for (let row = startRow + 1; row < endRow; row++) {
            if (getPieceFromCell(boardElement.rows[row].cells[sourceCol]) !== '') {
                return false;
            }
        }
    }

    return true;
}

function isValidMove(source, target, boardElement) {
    // Check if moving onto another piece
    const targetPiece = getPieceFromCell(target);
    if (['⚫', '⚪', '⬜'].includes(targetPiece)) {
        return false;
    }

    // Ensure the move is horizontal or vertical
    const sourceRow = source.parentNode.rowIndex;
    const sourceCol = source.cellIndex;
    const targetRow = target.parentNode.rowIndex;
    const targetCol = target.cellIndex;

    const isHorizontalMove = sourceRow === targetRow;
    const isVerticalMove = sourceCol === targetCol;

    if (!isHorizontalMove && !isVerticalMove) {
        return false;
    }
    
    if (!squaresBetweenAreEmpty(source, target, boardElement)) {
        return false;
    }

    // Check for restricted corner squares
    const isCornerSquare = (row, col) => (row === 0 || row === 6) && (col === 0 || col === 6);
    const sourcePiece = getPieceFromCell(source);
    if (isCornerSquare(targetRow, targetCol) && sourcePiece !== '⬜') {
        return false;
    }

    // Check for three-fold repetition
    if (wouldCauseThreefoldRepetition(source, target, boardElement, currentPlayer)) {
        return false;
    }

    // All checks passed
    return true;
}

function isRestrictedSquare(row, col) {
    return (row === 0 || row === 6) && (col === 0 || col === 6);
}

function capturePieces(source, target, boardElement, callback) {
    const targetRow = target.parentNode.rowIndex;
    const targetCol = target.cellIndex;
    const directions = [
        { dr: -1, dc: 0 },  // up
        { dr: 1, dc: 0 },   // down
        { dr: 0, dc: -1 },  // left
        { dr: 0, dc: 1 }    // right
    ];

    const capturedCells = [];

    for (let dir of directions) {
        const enemyRow = targetRow + dir.dr;
        const enemyCol = targetCol + dir.dc;
        const allyRow = enemyRow + dir.dr;
        const allyCol = enemyCol + dir.dc;

        if (enemyRow < 0 || enemyRow >= 7 || enemyCol < 0 || enemyCol >= 7) continue;  // Out of board bounds
        if (allyRow < 0 || allyRow >= 7 || allyCol < 0 || allyCol >= 7) continue;      // Out of board bounds

        const enemyCell = boardElement.rows[enemyRow].cells[enemyCol];
        const allyCell = boardElement.rows[allyRow].cells[allyCol];
        
        const targetPiece = getPieceFromCell(target);
        const enemyPiece = getPieceFromCell(enemyCell);
        const allyPiece = getPieceFromCell(allyCell);

        if (targetPiece === '⚫' && enemyPiece === '⚪' && (allyPiece === '⚫' || isRestrictedSquare(allyRow, allyCol))) {
            capturedCells.push(enemyCell);
        } else if ((targetPiece === '⚪' || targetPiece === '⬜') && enemyPiece === '⚫' && (isDefender(allyPiece) || isRestrictedSquare(allyRow, allyCol))) {
            capturedCells.push(enemyCell);
        } else if (targetPiece === '⚫' && enemyPiece === '⬜' && (allyPiece === '⚫' || isRestrictedSquare(allyRow, allyCol))) {
            capturedCells.push(enemyCell);
        }
    }

    // Animate captures if any
    if (capturedCells.length > 0) {
        capturedCells.forEach(cell => {
            cell.classList.add('fade-out-animation');
        });
        
        // Remove pieces after animation completes
        setTimeout(() => {
            capturedCells.forEach(cell => {
                setPieceInCell(cell, '');
                cell.classList.remove('fade-out-animation');
            });
            
            // Call callback after captures are complete
            if (callback) callback();
        }, 400); // Match fadeOut animation duration
    } else {
        // No captures, call callback immediately
        if (callback) callback();
    }
}


function showWinner(win_text) {
    const overlay = document.getElementById('overlay');
    const winMessage = document.getElementById('winMessage');

    winMessage.textContent = `${win_text}`; // Set the message
    overlay.classList.remove('hidden'); // Show the overlay
}


function checkForVictory(boardElement) {
    let kingPresent = false;
    let attackerCount = 0;

    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            const piece = getPieceFromCell(cell);
            
            if (piece === '⬜') {
                kingPresent = true;

                // Check if king is on a corner
                if (
                    (cell.cellIndex === 0 && (row.rowIndex === 0 || row.rowIndex === 6)) ||
                    (cell.cellIndex === 6 && (row.rowIndex === 0 || row.rowIndex === 6))
                ) {
                    gameOver=true;
                    showWinner("Defenders Win! The king has reached a corner.");
                    return -1;
                }
            } else if (piece === '⚫') {
                attackerCount++;
            }
        }
    }

    if (!kingPresent) {
        gameOver=true;
        showWinner("Attackers Win! The king has been captured.");
        return 1;
    } else if (attackerCount === 0) {
        gameOver=true;
        showWinner("Defenders Win! All attackers have been captured.");
        return -1;
    }
    return 0;
}


function getRandomLegalMove(boardElement, player) {
    const pieces = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            const piece = getPieceFromCell(cell);
            if ((player === 'attacker' && piece === '⚫') || 
                (player === 'defender' && (piece === '⚪' || piece === '⬜'))) {
                pieces.push(cell);
            }
        }
    }
    const randomPiece = pieces[Math.floor(Math.random() * pieces.length)];

    const legalMoves = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            if (isValidMove(randomPiece, cell, boardElement)) {
                legalMoves.push(cell);
            }
        }
    }

    if (legalMoves.length === 0) return null;  // No legal moves available
    return {
        piece: randomPiece,
        target: legalMoves[Math.floor(Math.random() * legalMoves.length)]
    };
}

const aiDifficultyRadioButtons = document.querySelectorAll('input[name="ai-difficulty"]');
const aiTypeRadioButtons = document.querySelectorAll('input[name="ai-type"]');

// Player configuration dropdowns
const attackerTypeSelect = document.getElementById('attacker-type');
const defenderTypeSelect = document.getElementById('defender-type');
const attackerDifficultyContainer = document.getElementById('attacker-difficulty-container');
const defenderDifficultyContainer = document.getElementById('defender-difficulty-container');
const attackerDifficultySelect = document.getElementById('attacker-difficulty');
const defenderDifficultySelect = document.getElementById('defender-difficulty');

// Player configuration (stores type and difficulty for each player)
const playerConfig = {
    attacker: { type: 'human', difficulty: 'medium' },
    defender: { type: 'human', difficulty: 'medium' }
};

// Show/hide difficulty dropdown based on player type
function updateDifficultyVisibility(player) {
    const container = player === 'attacker' ? attackerDifficultyContainer : defenderDifficultyContainer;
    const type = playerConfig[player].type;
    
    if (type === 'human') {
        container.classList.add('hidden');
    } else {
        container.classList.remove('hidden');
    }
}

// Handle attacker type change
attackerTypeSelect.addEventListener('change', function() {
    playerConfig.attacker.type = this.value;
    updateDifficultyVisibility('attacker');
    updateGameMode();
});

// Handle defender type change
defenderTypeSelect.addEventListener('change', function() {
    playerConfig.defender.type = this.value;
    updateDifficultyVisibility('defender');
    updateGameMode();
});

// Handle attacker difficulty change
attackerDifficultySelect.addEventListener('change', function() {
    playerConfig.attacker.difficulty = this.value;
});

// Handle defender difficulty change
defenderDifficultySelect.addEventListener('change', function() {
    playerConfig.defender.difficulty = this.value;
});

// Update game mode based on current selections
function updateGameMode() {
    gameMode.attacker = playerConfig.attacker.type === 'human' ? 'Human' : 'AI';
    gameMode.defender = playerConfig.defender.type === 'human' ? 'Human' : 'AI';
    updatePlayerRoles(gameMode.attacker, gameMode.defender);
    
    // If it's an AI's turn and the game is active, make the move
    if (!gameOver && gameMode[currentPlayer] === 'AI') {
        makeAIMove();
    }
}

// Initialize visibility
updateDifficultyVisibility('attacker');
updateDifficultyVisibility('defender');

function getAIType(player = null) {
    // If player is specified, get their specific AI type
    if (player) {
        return playerConfig[player].type;
    }
    // Otherwise, get current player's type
    return playerConfig[currentPlayer].type;
}

function getAIDifficulty(player = null) {
    // If player is specified, get their specific difficulty
    if (player) {
        return playerConfig[player].difficulty;
    }
    // Otherwise, get current player's difficulty
    return playerConfig[currentPlayer].difficulty;
}

function getAIBestMove(boardElement, player_str) {
    const difficulty = getAIDifficulty();
    let max_depth = 4;
    if(difficulty == "easy")
        max_depth = 3
    if(difficulty == "medium")
        max_depth = 4
    if(difficulty == "hard")
        max_depth = 5
    if(difficulty == "veryhard")
        max_depth = 6

    let player = player_str === 'attacker'? 1 : -1;
    let board_arr = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            const piece = getPieceFromCell(cell);
            if(piece === '⚫')
                board_arr.push(1);
            else if(piece === '⚪')
                board_arr.push(2);
            else if(piece === '⬜')
                board_arr.push(3);
            else
                board_arr.push(0);
        }
    }
    let size = board_arr.length;

    let ptr_eval = Module._malloc(4);
    let ptr_movefrom_x = Module._malloc(4);
    let ptr_movefrom_y = Module._malloc(4);
    let ptr_moveto_x = Module._malloc(4);
    let ptr_moveto_y = Module._malloc(4);
    let board_ptr = Module._malloc(size * 4);
    let board_dataHeap = new Int32Array(Module.HEAP32.buffer, board_ptr, size);
    board_dataHeap.set(board_arr);

    // Call the C++ function
    Module._AI_web_get_move(ptr_eval, ptr_movefrom_x, ptr_movefrom_y, ptr_moveto_x, ptr_moveto_y, board_ptr, player, max_depth);
    computer_eval = new Float32Array(Module.HEAP32.buffer, ptr_eval, 1)[0];
    let movefrom_x = new Int32Array(Module.HEAP32.buffer, ptr_movefrom_x, 1)[0];
    let movefrom_y = new Int32Array(Module.HEAP32.buffer, ptr_movefrom_y, 1)[0];
    let moveto_x = new Int32Array(Module.HEAP32.buffer, ptr_moveto_x, 1)[0];
    let moveto_y = new Int32Array(Module.HEAP32.buffer, ptr_moveto_y, 1)[0];

    console.log(computer_eval);
    if(computer_eval > 500){
        document.getElementById('AI-eval').innerHTML = `AI eval:<br>black<br>winning`;
    }else if(computer_eval < -500){
        document.getElementById('AI-eval').innerHTML = `AI eval:<br>white<br>winning`;
    }else{
        document.getElementById('AI-eval').innerHTML = `AI eval:<br>${computer_eval.toFixed(2)}`;
    }

    return {
        piece: boardElement.rows[movefrom_y].cells[movefrom_x],
        target: boardElement.rows[moveto_y].cells[moveto_x]
    };
}

async function getMCTSBestMove(boardElement, player_str) {
    console.log(`[Script] getMCTSBestMove called for ${player_str}`);
    
    const difficulty = getAIDifficulty();
    
    // Map difficulty to simulation count
    const simCount = { easy: 50, medium: 100, hard: 200, veryhard: 400 }[difficulty] || 100;
    
    console.log(`[Script] MCTS difficulty: ${difficulty}, simulations: ${simCount}, temperature: ${mctsTemperature}`);
    
    const agent = getMCTSAgent();
    
    if (!agent.isReady) {
        console.error("[Script] MCTS agent not ready!");
        // Fall back to tree search AI
        console.log("[Script] Falling back to tree-search AI");
        return getAIBestMove(boardElement, player_str);
    }
    
    try {
        // Always do a fresh search for AI moves (don't use cache)
        console.log("[Script] Running fresh MCTS search for AI move");
        const move = await agent.getBestMove(boardElement, player_str, simCount, mctsTemperature);
        
        if (move && move.piece && move.target) {
            console.log("[Script] MCTS returned move:", move);
            return move;
        } else {
            console.error("[Script] MCTS returned invalid move");
            return getAIBestMove(boardElement, player_str);
        }
    } catch (error) {
        console.error("[Script] Error in getMCTSBestMove:", error);
        // Fall back to tree search AI
        return getAIBestMove(boardElement, player_str);
    }
}

function highlightLegalMoves(source, boardElement) {
    // Reset all highlights
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            cell.classList.remove('legal-move');
        }
    }

    const sourceRow = source.parentNode.rowIndex;
    const sourceCol = source.cellIndex;

    // Check horizontally and vertically
    for (let i = 0; i < 7; i++) {
        let hCell = boardElement.rows[sourceRow].cells[i];
        let vCell = boardElement.rows[i].cells[sourceCol];
        if (isValidMove(source, hCell, boardElement)) {
            hCell.classList.add('legal-move');
        }

        if (isValidMove(source, vCell, boardElement)) {
            vCell.classList.add('legal-move');
        }
    }
}

function deselectAll(boardElement) {
    const cells = boardElement.querySelectorAll('td');
    cells.forEach(cell => cell.classList.remove('selected'));
}

function resetBoard() {
    gameOver = false;
    
    // Reset position history
    positionHistory = [];
    
    // Reset move history
    moveHistory = [];

    // Remove the "win" overlay.
    const overlay = document.getElementById('overlay');
    overlay.classList.add('hidden'); // Show the overlay


    // Clear the current board content
    boardElement.innerHTML = '';

    const initialSetup = [
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['⚫', '⚫', '⚪', '⬜', '⚪', '⚫', '⚫'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0']
    ];

    for (let row of initialSetup) {
        const tr = document.createElement('tr');
        for (let cell of row) {
            const td = document.createElement('td');
            if (cell !== '0') {
                td.innerText = cell;
                td.classList.add(cell); // Add class to td (e.g., "A", "D", "K")
            }
            // Attach the click event to the cell
            td.addEventListener('click', handleCellClick);

            tr.appendChild(td);
        }
        boardElement.appendChild(tr);
    }

    boardElement.className = "attacker";
    
    // Record the initial position
    recordPosition(boardElement, 'attacker');
    
    // Save initial board state for undo
    saveBoardState();
    
    // Refresh eval and policy visualizations if they were active
    if (evalMode !== 'off') {
        updateEvaluation();
    }
    if (policyMode !== 'off') {
        updatePolicyVisualization();
    }
}

function movePiece(sourceCell, targetCell) {
    // Get the piece before we start animations
    const piece = getPieceFromCell(sourceCell);
    
    // Flash both cells
    sourceCell.classList.add('flash-animation');
    targetCell.classList.add('flash-animation');
    
    // Create a floating piece element for animation
    const sourceRect = sourceCell.getBoundingClientRect();
    const targetRect = targetCell.getBoundingClientRect();
    
    const floatingPiece = document.createElement('div');
    floatingPiece.textContent = piece;
    floatingPiece.style.position = 'fixed';
    floatingPiece.style.left = sourceRect.left + 'px';
    floatingPiece.style.top = sourceRect.top + 'px';
    floatingPiece.style.width = sourceRect.width + 'px';
    floatingPiece.style.height = sourceRect.height + 'px';
    floatingPiece.style.fontSize = window.getComputedStyle(sourceCell).fontSize;
    floatingPiece.style.display = 'flex';
    floatingPiece.style.alignItems = 'center';
    floatingPiece.style.justifyContent = 'center';
    floatingPiece.style.pointerEvents = 'none';
    floatingPiece.style.zIndex = '1000';
    floatingPiece.style.transition = 'all 0.4s ease-in-out';
    
    document.body.appendChild(floatingPiece);
    
    // Clear the source cell immediately (but keep the class for background highlighting)
    setPieceInCell(sourceCell, '');
    
    // Trigger animation on next frame
    requestAnimationFrame(() => {
        floatingPiece.style.left = targetRect.left + 'px';
        floatingPiece.style.top = targetRect.top + 'px';
    });
    
    // After animation completes
    setTimeout(() => {
        // Remove floating piece
        floatingPiece.remove();
        
        // Move the piece to the new cell
        setPieceInCell(targetCell, piece);
        
        // Clear class of source and destination
        sourceCell.className = '';
        targetCell.className = '';
        
        // Add appropriate class to the destination
        targetCell.classList.add(piece);
        
        // Remove flash animation
        sourceCell.classList.remove('flash-animation');
        targetCell.classList.remove('flash-animation');
        
        // Capture pieces (with their own animations)
        // Use callback to record position after captures are complete
        capturePieces(sourceCell, targetCell, boardElement, () => {
            // Record the position after the move and captures are complete
            recordPosition(boardElement, currentPlayer);
        });
        
        // Clear legal move highlights
        for (let row of boardElement.rows) {
            for (let cell of row.cells) {
                cell.classList.remove('legal-move');
            }
        }
        
        let win = checkForVictory(boardElement);
        if(win !== 0){
            return;
        }

        // Switch turns
        togglePlayer();
        
        // Save board state after turn has switched (for undo)
        // This saves the board with the next player's turn
        saveBoardState();
        
        if ((gameMode[currentPlayer] === 'AI') && (!gameOver)) {
            makeAIMove();
        }else if(!document.getElementById("AI-eval").classList.contains('hidden')){
            getAIBestMove(boardElement, currentPlayer);
        }
    }, 400); // Match transition duration
}


function makeAIMove() {
    if (gameOver || gameMode[currentPlayer] !== 'AI') {
        return;
    }
    // clearTimeout(aiMoveTimeout); // Clear any existing scheduled AI move
    // aiMoveTimeout = setTimeout(() => {  // Add a delay for better user experience
    //     const move = getRandomLegalMove(boardElement, currentPlayer);
    //     if (move) {
        //         movePiece(move.piece, move.target);
    //     }
    // }, 500);

    clearTimeout(aiMoveTimeout); // Clear any existing scheduled AI move
    
    const aiType = getAIType();
    console.log(`[Script] makeAIMove called, AI type: ${aiType}, player: ${currentPlayer}`);
    
    if (aiType === 'mcts') {
        // Use MCTS AI (async)
        aiMoveTimeout = setTimeout(async () => {
            console.log("[Script] Making MCTS move...");
            const move = await getMCTSBestMove(boardElement, currentPlayer);
            if (move) {
                console.log("[Script] Executing MCTS move");
                movePiece(move.piece, move.target);
            } else {
                console.error("[Script] No move returned from MCTS");
            }
        }, 600);
    } else {
        // Use tree-search AI (original)
        aiMoveTimeout = setTimeout(() => {
            console.log("[Script] Making tree-search move...");
            const move = getAIBestMove(boardElement, currentPlayer);
            if (move) {
                console.log("[Script] Executing tree-search move");
                movePiece(move.piece, move.target);
            }
        }, 600);
    }
}

function togglePlayer() {
    if (currentPlayer === 'attacker') {
        currentPlayer = 'defender';
        boardElement.className = 'defender';
    } else {
        currentPlayer = 'attacker';
        boardElement.className = 'attacker';
    }

    // Highlight the text of whoever has the turn:
    const attackerLabel = document.getElementById("attacker-label");
    const defenderLabel = document.getElementById("defender-label");
    
    if (currentPlayer === 'attacker') {
        attackerLabel.classList.add('active-player');
        defenderLabel.classList.remove('active-player');
    } else {
        defenderLabel.classList.add('active-player');
        attackerLabel.classList.remove('active-player');
    }
    
    // Clear cache for new position
    clearMCTSCache();
    
    // Refresh visualizations for new player
    if (policyMode !== 'off') {
        updatePolicyVisualization();
    }
    if (evalMode !== 'off') {
        updateEvaluation();
    }
}

let gameOver = false;
let currentPlayer = 'attacker';
const gameMode = {
    attacker: 'Human',
    defender: 'Human'
};
let aiMoveTimeout = null;
let selectedPiece = null;
let computer_eval = 0.0;
let positionHistory = []; // Track position history for three-fold repetition
let moveHistory = []; // Track moves for undo functionality

/**
 * Save current board state for undo
 */
function saveBoardState() {
    const state = {
        board: [],
        player: currentPlayer,
        positionHistoryLength: positionHistory.length
    };
    
    for (let row of boardElement.rows) {
        const rowData = [];
        for (let cell of row.cells) {
            rowData.push(getPieceFromCell(cell));
        }
        state.board.push(rowData);
    }
    
    moveHistory.push(state);
}

/**
 * Restore board state from history
 */
function restoreBoardState(state) {
    // Restore board
    for (let i = 0; i < state.board.length; i++) {
        for (let j = 0; j < state.board[i].length; j++) {
            const cell = boardElement.rows[i].cells[j];
            const piece = state.board[i][j];
            setPieceInCell(cell, piece);
            
            // Update cell class
            cell.className = '';
            if (piece) {
                cell.classList.add(piece);
            }
        }
    }
    
    // Restore player
    currentPlayer = state.player;
    boardElement.className = currentPlayer;
    
    // Update player labels
    const attackerLabel = document.getElementById("attacker-label");
    const defenderLabel = document.getElementById("defender-label");
    
    if (currentPlayer === 'attacker') {
        attackerLabel.classList.add('active-player');
        defenderLabel.classList.remove('active-player');
    } else {
        defenderLabel.classList.add('active-player');
        attackerLabel.classList.remove('active-player');
    }
    
    // Restore position history
    positionHistory = positionHistory.slice(0, state.positionHistoryLength);
    
    // Clear any selections
    if (selectedPiece) {
        selectedPiece.classList.remove('selected');
        selectedPiece = null;
    }
    removeHighlights(boardElement);
    
    // Clear cache
    clearMCTSCache();
    
    // Refresh visualizations
    if (policyMode !== 'off') {
        updatePolicyVisualization();
    }
    if (evalMode !== 'off') {
        updateEvaluation();
    }
}

function startGame(attackerMode, defenderMode) {
    resetBoard();
    currentPlayer = 'attacker';
    gameMode = { attacker: attackerMode, defender: defenderMode };
    positionHistory = []; // Reset position history
    moveHistory = []; // Reset move history
    if (gameMode[currentPlayer] === 'AI') {
        makeAIMove();
    }
}

// Event listener for piece selection or movement
function handleCellClick(event) {
    if (gameOver) return;
    
    // Get the td cell, even if clicking on child elements (like policy overlay)
    let cell = event.target;
    if (cell.tagName !== 'TD') {
        cell = cell.closest('td');
    }
    if (!cell) return;
    
    const piece = getPieceFromCell(cell);
    
    // If a piece is already selected
    if (selectedPiece) {
        // If trying to replace an existing piece, check if it's the same piece to deselect
        if (cell === selectedPiece) {
            removeHighlights(boardElement); // Remove any move highlights
            cell.classList.remove('selected');  // Remove the 'selected' class
            selectedPiece = null;
            
            // Update policy visualization to show all pieces
            if (policyMode !== 'off') {
                updatePolicyVisualization();
            }
            return;
        }

        // If trying to select another piece of the same player
        if (currentPlayer === 'attacker' && piece === '⚫') {
            removeHighlights(boardElement); // Remove any move highlights
            deselectAll(boardElement);
            cell.classList.add('selected');  // Add the 'selected' class
            highlightLegalMoves(cell, boardElement);
            selectedPiece = cell;
            
            // Update policy visualization for this piece
            if (policyMode !== 'off') {
                updatePolicyVisualization();
            }
            return;
        } else if (currentPlayer === 'defender' && isDefender(piece)) {
            removeHighlights(boardElement); // Remove any move highlights
            deselectAll(boardElement);
            cell.classList.add('selected');  // Add the 'selected' class
            highlightLegalMoves(cell, boardElement);
            selectedPiece = cell;
            
            // Update policy visualization for this piece
            if (policyMode !== 'off') {
                updatePolicyVisualization();
            }
            return;
        }

        // If making a move to an empty square
        if (!piece) {
            if (!isValidMove(selectedPiece, cell, boardElement)) {
                // Clicked on an illegal square - deselect the piece
                removeHighlights(boardElement);
                selectedPiece.classList.remove('selected');
                selectedPiece = null;
                
                // Update policy visualization to show all pieces
                if (policyMode !== 'off') {
                    updatePolicyVisualization();
                }
                return;
            }
            movePiece(selectedPiece, cell);
            removeHighlights(boardElement); // Remove move highlights after moving
            selectedPiece.classList.remove('selected');  // Remove the 'selected' class
            selectedPiece = null;
            
            // Clear MCTS cache after move
            clearMCTSCache();
            if (policyMode !== 'off') {
                clearPolicyVisualization();
            }
            return;
        }
    }

    // If a piece is not selected and the clicked cell has a piece
    if (currentPlayer === 'attacker' && piece === '⚫') {
        selectedPiece = cell; // Mark the piece as selected
        highlightLegalMoves(cell, boardElement);        
        cell.classList.add('selected');  // Add the 'selected' class
        
        // Update policy visualization for this piece
        if (policyMode !== 'off') {
            updatePolicyVisualization();
        }
    } else if (currentPlayer === 'defender' && isDefender(piece)) {
        highlightLegalMoves(cell, boardElement);    
        selectedPiece = cell; // Mark the piece as selected
        cell.classList.add('selected');  // Add the 'selected' class
        
        // Update policy visualization for this piece
        if (policyMode !== 'off') {
            updatePolicyVisualization();
        }
    }
}
function removeHighlights(boardElement) {
    const cells = boardElement.querySelectorAll('td');
    cells.forEach(cell => {
        // Adjust this depending on how you're indicating a legal move. 
        // Here, I'm assuming a CSS class "highlight" is added to show legal moves.
        cell.classList.remove('legal-move'); 
    });
}

function updatePlayerRoles(attackerType, defenderType) {
    const attackerLabel = document.getElementById("attacker-label");
    const defenderLabel = document.getElementById("defender-label");

    attackerLabel.innerHTML = `Attacker:<br>${attackerType}`;
    defenderLabel.innerHTML = `Defender:<br>${defenderType}`;
}


function resetGame() {
    updatePlayerRoles(gameMode["attacker"], gameMode["defender"]);
    clearTimeout(aiMoveTimeout);
    resetBoard();
    currentPlayer = 'attacker';
    if (gameMode[currentPlayer] === 'AI'){
        makeAIMove();
    }
}

document.getElementById('help-btn').addEventListener('click', function() {
    var helpText = document.getElementById('helpText');
    var settingsText = document.getElementById('settingsText');
    
    // Close settings if open
    if (!settingsText.classList.contains('hidden')) {
        settingsText.classList.add('hidden');
    }
    
    // Toggle help
    if (helpText.classList.contains('hidden')) {
        helpText.classList.remove('hidden');
    } else {
        helpText.classList.add('hidden');
    }
});

// Settings button
document.getElementById('settings-btn').addEventListener('click', function() {
    var helpText = document.getElementById('helpText');
    var settingsText = document.getElementById('settingsText');
    
    // Close help if open
    if (!helpText.classList.contains('hidden')) {
        helpText.classList.add('hidden');
    }
    
    // Toggle settings
    if (settingsText.classList.contains('hidden')) {
        settingsText.classList.remove('hidden');
    } else {
        settingsText.classList.add('hidden');
    }
});

// Temperature slider
document.getElementById('temperature-slider').addEventListener('input', function() {
    mctsTemperature = parseFloat(this.value);
    document.getElementById('temperature-value').textContent = mctsTemperature.toFixed(1);
    console.log(`[Settings] Temperature set to ${mctsTemperature}`);
});

// MCTS simulations slider
document.getElementById('mcts-simulations-slider').addEventListener('input', function() {
    mctsSimulationCount = parseInt(this.value);
    document.getElementById('mcts-simulations-value').textContent = mctsSimulationCount;
    console.log(`[Settings] MCTS simulation count set to ${mctsSimulationCount}`);
    // Clear cache when simulation count changes
    clearMCTSCache();
});

// Undo button
document.getElementById('undo-btn').addEventListener('click', function() {
    if (moveHistory.length > 1) {
        // Remove the current state
        moveHistory.pop();
        
        // Restore the previous state (don't remove it, it's now the current state)
        const previousState = moveHistory[moveHistory.length - 1];
        restoreBoardState(previousState);
        gameOver = false;
    } else if (moveHistory.length === 1) {
        // Only initial state exists, reset to it
        const initialState = moveHistory[0];
        restoreBoardState(initialState);
        gameOver = false;
    }
});

// Restart button
document.getElementById('restart-btn').addEventListener('click', function() {
    resetBoard();
    gameOver = false;
    currentPlayer = 'attacker';
    
    // Update player labels
    const attackerLabel = document.getElementById("attacker-label");
    const defenderLabel = document.getElementById("defender-label");
    attackerLabel.classList.add('active-player');
    defenderLabel.classList.remove('active-player');
    
    // If AI is first player, make move
    if (gameMode[currentPlayer] === 'AI' && !gameOver) {
        makeAIMove();
    }
});

/**
 * Convert board HTML element to 2D array representation
 * @param {HTMLTableElement} boardElement 
 * @returns {Array<Array<string>>} 7x7 board array
 */
function getBoardState(boardElement) {
    const board = [];
    for (let r = 0; r < 7; r++) {
        const row = [];
        for (let c = 0; c < 7; c++) {
            row.push(getPieceFromCell(boardElement.rows[r].cells[c]));
        }
        board.push(row);
    }
    return board;
}

const boardElement = document.getElementById('board');

// AI Evaluation and Policy visualization state
let evalMode = 'nn-mcts'; // 'off', 'heuristic', 'nn', 'nn-mcts'
let policyMode = 'off'; // 'off', 'heuristic', 'nn', 'nn-mcts'
let mctsTemperature = 0.4; // Temperature for MCTS move selection
let mctsSimulationCount = 200; // Simulation count for eval bar and move suggestions

// MCTS cache - stores results per position to avoid re-computation
let mctsCache = {
    boardHash: null,  // Hash of board position
    player: null,     // Player who's turn it is
    mctsResult: null, // Full MCTS result {move, policyData: {policy, visitCounts}, value}
    nnPolicy: null,   // Raw NN policy {policy, value}
    nnValue: null     // Just the NN value output
};

// Helper to compute simple board hash
function getBoardHash(boardElement, player) {
    let hash = player + ':';
    for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
            hash += getPieceFromCell(boardElement.rows[r].cells[c]);
        }
    }
    return hash;
}

// Clear MCTS cache (call when board changes)
function clearMCTSCache() {
    mctsCache.boardHash = null;
    mctsCache.player = null;
    mctsCache.mctsResult = null;
    mctsCache.nnPolicy = null;
    mctsCache.nnValue = null;
}

// Initialize MCTS agent on page load
console.log("[Script] Initializing MCTS agent on page load...");
initializeMCTSAgent().then(success => {
    if (success) {
        console.log("[Script] MCTS agent initialized successfully!");
        // Trigger initial evaluation if evalMode is set
        if (evalMode !== 'off') {
            console.log("[Script] Triggering initial evaluation...");
            updateEvaluation();
        }
    } else {
        console.error("[Script] MCTS agent initialization failed. Tree-search AI will be used as fallback.");
    }
}).catch(error => {
    console.error("[Script] MCTS agent initialization error:", error);
});

document.addEventListener('DOMContentLoaded', function() {
    const initialSetup = [
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['⚫', '⚫', '⚪', '⬜', '⚪', '⚫', '⚫'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0']
    ];

    for (let row of initialSetup) {
        const tr = document.createElement('tr');
        for (let cell of row) {
            const td = document.createElement('td');
            
            // Add class based on piece type
            if (cell !== '0') {
                td.innerText = cell;
                td.classList.add(cell); // Add class to td (e.g., "A", "D", "K")
            }

            // Attach the click event to the cell
            td.addEventListener('click', handleCellClick);
            
            // Prevent text selection
            td.addEventListener('mousedown', function(event) {
                event.preventDefault();
            });

            tr.appendChild(td);
        }
        boardElement.appendChild(tr);
    }
    boardElement.className = "attacker";
    updatePlayerRoles(gameMode["attacker"], gameMode["defender"]);
});

// AI Evaluation dropdown handler
document.getElementById('eval-mode-select').addEventListener('change', function() {
    setEvalMode(this.value);
});

// Move suggestions dropdown handler
document.getElementById('policy-mode-select').addEventListener('change', function() {
    setPolicyMode(this.value);
});

function setEvalMode(mode) {
    evalMode = mode;
    
    // Update dropdown value
    document.getElementById('eval-mode-select').value = mode;
    
    // Update evaluation display
    updateEvaluation();
}

function setPolicyMode(mode) {
    policyMode = mode;
    
    // Update dropdown value
    document.getElementById('policy-mode-select').value = mode;
    
    // Update policy visualization
    if (mode === 'off') {
        clearPolicyVisualization();
    } else {
        updatePolicyVisualization();
    }
}

/**
 * Get or compute MCTS result for current position (with caching)
 */
async function getMCTSResult() {
    const hash = getBoardHash(boardElement, currentPlayer);
    
    // Check cache
    if (mctsCache.boardHash === hash && mctsCache.player === currentPlayer && mctsCache.mctsResult) {
        console.log("[MCTS Cache] Using cached MCTS result");
        return mctsCache.mctsResult;
    }
    
    // Compute new MCTS result with configurable simulation count for move suggestions
    const simCount = mctsSimulationCount;  // Use global setting
    
    console.log("[MCTS Cache] Computing new MCTS result with", simCount, "simulations");
    const result = await window.mctsAgent.getBestMove(boardElement, currentPlayer, simCount);
    
    // Cache it, including the root value
    if (result && window.mctsAgent.mcts.root) {
        result.rootValue = window.mctsAgent.mcts.root.meanValue;
        result.rootVisits = window.mctsAgent.mcts.root.visitCount;
        
        mctsCache.boardHash = hash;
        mctsCache.player = currentPlayer;
        mctsCache.mctsResult = result;
    }
    
    return result;
}

/**
 * Get or compute NN policy for current position (with caching)
 */
/**
 * Apply softmax to convert logits to probabilities
 */
function softmax(logits) {
    const maxLogit = Math.max(...logits);
    const expLogits = new Float32Array(logits.length);
    let sum = 0;
    
    for (let i = 0; i < logits.length; i++) {
        expLogits[i] = Math.exp(logits[i] - maxLogit);
        sum += expLogits[i];
    }
    
    for (let i = 0; i < logits.length; i++) {
        expLogits[i] /= sum;
    }
    
    return expLogits;
}

/**
 * Get raw NN policy and value for current board state
 */
async function getNNPolicy() {
    const hash = getBoardHash(boardElement, currentPlayer);
    
    // Check cache
    if (mctsCache.boardHash === hash && mctsCache.player === currentPlayer && mctsCache.nnPolicy) {
        console.log("[MCTS Cache] Using cached NN policy");
        return mctsCache.nnPolicy;
    }
    
    // Compute new NN policy
    console.log("[MCTS Cache] Computing new NN policy");
    const result = await window.mctsAgent.getPolicy(boardElement, currentPlayer);
    
    // Cache it
    if (result) {
        mctsCache.boardHash = hash;
        mctsCache.player = currentPlayer;
        mctsCache.nnPolicy = result;
        mctsCache.nnValue = result.value;
    }
    
    return result;
}

/**
 * Update policy visualization on the board
 */
async function updatePolicyVisualization() {
    if (policyMode === 'off') {
        clearPolicyVisualization();
        return;
    }
    
    if (policyMode === 'heuristic') {
        // TODO: Implement heuristic-based move suggestions if desired
        console.log("[Policy Viz] Heuristic mode not yet implemented");
        clearPolicyVisualization();
        return;
    }
    
    if (!window.mctsAgent || !window.mctsAgent.isReady) {
        console.log("[Policy Viz] MCTS agent not ready");
        clearPolicyVisualization();
        return;
    }
    
    try {
        let policyData;
        
        if (policyMode === 'nn') {
            // Use raw NN policy
            const nnResult = await getNNPolicy();
            // Apply softmax to convert logits to probabilities
            const policyProbs = softmax(nnResult.policy);
            policyData = {
                policy: policyProbs,
                visitCounts: null,
                value: nnResult.value,
                moveValues: null,
                source: 'nn'
            };
        } else if (policyMode === 'nn-mcts') {
            // Use MCTS visit counts
            const mctsResult = await getMCTSResult();
            if (mctsResult && mctsResult.policyData) {
                // Extract move values from MCTS children
                const moveValues = new Map();
                if (window.mctsAgent && window.mctsAgent.mcts && window.mctsAgent.mcts.root) {
                    for (const [moveKey, child] of window.mctsAgent.mcts.root.children.entries()) {
                        moveValues.set(moveKey, child.meanValue);
                    }
                }
                
                policyData = {
                    policy: mctsResult.policyData.policy,
                    visitCounts: mctsResult.policyData.visitCounts,
                    value: mctsResult.rootValue || 0,
                    moveValues: moveValues,
                    source: 'mcts'
                };
            } else {
                console.error("[Policy Viz] MCTS result invalid, falling back to NN");
                const nnResult = await getNNPolicy();
                // Apply softmax to convert logits to probabilities
                const policyProbs = softmax(nnResult.policy);
                policyData = {
                    policy: policyProbs,
                    visitCounts: null,
                    value: nnResult.value,
                    moveValues: null,
                    source: 'nn'
                };
            }
        }
        
        // Visualize based on selected piece
        if (selectedPiece) {
            await visualizePolicyForPiece(selectedPiece, policyData);
        } else {
            await visualizePolicyForAllPieces(policyData);
        }
    } catch (error) {
        console.error("[Policy Viz] Error:", error);
        clearPolicyVisualization();
    }
}

/**
 * Update AI evaluation display
 */
async function updateEvaluation() {
    if (evalMode === 'off') {
        document.getElementById('AI-eval').classList.add('hidden');
        return;
    }
    
    document.getElementById('AI-eval').classList.remove('hidden');
    
    try {
        let evalValue;
        
        if (evalMode === 'heuristic') {
            // Use traditional heuristic evaluation
            await getAIBestMove(boardElement, currentPlayer);
            // computer_eval is set by getAIBestMove
            evalValue = computer_eval;
        } else if (evalMode === 'nn') {
            // Use raw NN value
            if (!window.mctsAgent || !window.mctsAgent.isReady) {
                console.log("[Eval] MCTS agent not ready");
                return;
            }
            const nnResult = await getNNPolicy();
            evalValue = nnResult.value;
        } else if (evalMode === 'nn-mcts') {
            // Use MCTS value
            if (!window.mctsAgent || !window.mctsAgent.isReady) {
                console.log("[Eval] MCTS agent not ready");
                return;
            }
            const mctsResult = await getMCTSResult();
            if (mctsResult && mctsResult.rootValue !== undefined) {
                // Get value from the cached root value
                evalValue = mctsResult.rootValue;
                console.log(`[Eval] MCTS root value: ${evalValue}, visits: ${mctsResult.rootVisits}`);
            } else {
                console.error("[Eval] MCTS result invalid or root value not found");
                return;
            }
        }
        
        // Display the evaluation
        if (evalValue > 5) {
            document.getElementById('AI-eval').innerHTML = `AI eval:<br>black<br>winning`;
        } else if (evalValue < -5) {
            document.getElementById('AI-eval').innerHTML = `AI eval:<br>white<br>winning`;
        } else {
            document.getElementById('AI-eval').innerHTML = `AI eval:<br>${evalValue.toFixed(2)}`;
        }
    } catch (error) {
        console.error("[Eval] Error:", error);
    }
}

/**
 * Visualize policy probabilities for selecting each piece
 */
async function visualizePolicyForAllPieces(policyData) {
    if (!policyData) return;
    
    clearPolicyVisualization();
    
    const encoder = new MoveEncoder();
    const legalMoves = encoder.getAllLegalMoves(boardElement, currentPlayer);
    
    console.log(`[Policy Viz] visualizePolicyForAllPieces: ${legalMoves.length} legal moves`);
    
    // Group moves by source piece
    const pieceProbs = new Map(); // Map from "row,col" to probability/count
    const pieceValues = new Map(); // Map from "row,col" to best value for moves from that piece
    
    for (const move of legalMoves) {
        const moveIdx = encoder.encodeMove(move.fromRow, move.fromCol, move.toRow, move.toCol);
        const moveKey = `${move.fromRow},${move.fromCol},${move.toRow},${move.toCol}`;
        let prob;
        let value = 0;
        
        if (policyData.source === 'mcts' && policyData.visitCounts) {
            // Use MCTS visit counts (raw counts, not normalized yet)
            prob = policyData.visitCounts.get(moveIdx) || 0;
            // Get value from MCTS child node
            if (policyData.moveValues && policyData.moveValues.has(moveKey)) {
                value = -policyData.moveValues.get(moveKey); // Negate because it's opponent's perspective
            }
        } else {
            // Use NN policy (already converted to probabilities via softmax)
            prob = policyData.policy[moveIdx] || 0;
            // For NN, we'll use the base position value (approximation)
            value = policyData.value || 0;
        }
        
        const key = `${move.fromRow},${move.fromCol}`;
        pieceProbs.set(key, (pieceProbs.get(key) || 0) + prob);
        
        // Track the best (maximum) value for moves from this piece
        const currentBestValue = pieceValues.get(key);
        if (currentBestValue === undefined || value > currentBestValue) {
            pieceValues.set(key, value);
        }
    }
    
    console.log(`[Policy Viz] Piece probabilities/counts:`, Array.from(pieceProbs.entries()).slice(0, 5));
    
    // Normalize to get percentages
    const total = Array.from(pieceProbs.values()).reduce((a, b) => a + b, 0);
    console.log(`[Policy Viz] Total: ${total}, Source: ${policyData.source}`);
    
    if (total > 0) {
        for (const [key, probValue] of pieceProbs.entries()) {
            const percentage = (probValue / total) * 100;
            const value = pieceValues.get(key) || 0;
            const [row, col] = key.split(',').map(Number);
            const cell = boardElement.rows[row].cells[col];
            console.log(`[Policy Viz] Piece at (${row},${col}): prob=${probValue}, percentage=${percentage}%, value=${value}`);
            showPolicyOnCell(cell, percentage, value);
        }
    }
}

/**
 * Visualize policy probabilities for moves from a selected piece
 */
async function visualizePolicyForPiece(pieceCell, policyData) {
    if (!policyData) return;
    
    clearPolicyVisualization();
    
    const encoder = new MoveEncoder();
    const fromRow = pieceCell.parentNode.rowIndex;
    const fromCol = pieceCell.cellIndex;
    
    const legalMoves = encoder.getAllLegalMoves(boardElement, currentPlayer)
        .filter(m => m.fromRow === fromRow && m.fromCol === fromCol);
    
    // Get probabilities and values for each move
    const moveProbs = new Map();
    const moveValues = new Map();
    
    for (const move of legalMoves) {
        const moveIdx = encoder.encodeMove(move.fromRow, move.fromCol, move.toRow, move.toCol);
        const moveKey = `${move.fromRow},${move.fromCol},${move.toRow},${move.toCol}`;
        let prob;
        let value = 0;
        
        if (policyData.source === 'mcts' && policyData.visitCounts) {
            prob = policyData.visitCounts.get(moveIdx) || 0;
            // Get value from MCTS child node
            if (policyData.moveValues && policyData.moveValues.has(moveKey)) {
                value = -policyData.moveValues.get(moveKey); // Negate because it's opponent's perspective
            }
        } else {
            prob = policyData.policy[moveIdx] || 0;
            // For NN, use base position value (approximation)
            value = policyData.value || 0;
        }
        
        const key = `${move.toRow},${move.toCol}`;
        moveProbs.set(key, prob);
        moveValues.set(key, value);
    }
    
    // Normalize to get percentages
    const total = Array.from(moveProbs.values()).reduce((a, b) => a + b, 0);
    if (total > 0) {
        for (const [key, probValue] of moveProbs.entries()) {
            const percentage = (probValue / total) * 100;
            const value = moveValues.get(key) || 0;
            const [row, col] = key.split(',').map(Number);
            const cell = boardElement.rows[row].cells[col];
            showPolicyOnCell(cell, percentage, value);
        }
    }
}

/**
 * Display policy percentage and value on a cell
 */
function showPolicyOnCell(cell, percentage, value) {
    // Create or update overlay div
    let overlay = cell.querySelector('.policy-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'policy-overlay';
        overlay.style.pointerEvents = 'none';  // Ensure clicks pass through
        cell.appendChild(overlay);
    }
    
    // Format: "+0.4 (31%)" or "-0.2 (15%)"
    const sign = value >= 0 ? '+' : '';
    const percentageInt = Math.round(percentage);
    overlay.textContent = `${sign}${value.toFixed(1)} (${percentageInt}%)`;
}

/**
 * Clear all policy visualizations
 */
function clearPolicyVisualization() {
    const overlays = boardElement.querySelectorAll('.policy-overlay');
    overlays.forEach(overlay => overlay.remove());
}
