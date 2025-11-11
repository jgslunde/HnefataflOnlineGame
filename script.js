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

    // All checks passed
    return true;
}

function isRestrictedSquare(row, col) {
    return (row === 0 || row === 6) && (col === 0 || col === 6);
}

function capturePieces(source, target, boardElement) {
    const targetRow = target.parentNode.rowIndex;
    const targetCol = target.cellIndex;
    const directions = [
        { dr: -1, dc: 0 },  // up
        { dr: 1, dc: 0 },   // down
        { dr: 0, dc: -1 },  // left
        { dr: 0, dc: 1 }    // right
    ];

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
            setPieceInCell(enemyCell, '');  // Capture the defender
        } else if ((targetPiece === '⚪' || targetPiece === '⬜') && enemyPiece === '⚫' && (isDefender(allyPiece) || isRestrictedSquare(allyRow, allyCol))) {
            setPieceInCell(enemyCell, '');  // Capture the attacker
        } else if (targetPiece === '⚫' && enemyPiece === '⬜' && (allyPiece === '⚫' || isRestrictedSquare(allyRow, allyCol))) {
            setPieceInCell(enemyCell, '');  // Capture the king
        }
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
            if (cell.textContent === '⬜') {
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
            } else if (cell.textContent === '⚫') {
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
// const aiShowEvalRadioButtons = document.querySelectorAll('input[name="ai-show-eval"]');
document.getElementById('AI-eval-toggle-btn').addEventListener('click', function() {
    var aiEval = document.getElementById('AI-eval');
    if (aiEval.classList.contains('hidden')) {
        aiEval.classList.remove('hidden');
        getAIBestMove(boardElement, currentPlayer);
    } else {
        aiEval.classList.add('hidden');
    }
});

function getAIType() {
    for (let radioButton of aiTypeRadioButtons) {
        if (radioButton.checked) {
            return radioButton.value;
        }
    }
    return 'tree-search'; // default
}

function getAIDifficulty() {
    for (let radioButton of aiDifficultyRadioButtons) {
        if (radioButton.checked) {
            return radioButton.value;
        }
    }
    return 'medium'; // default
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
    let numSimulations = 100;
    
    // Map difficulty to simulation count
    if (difficulty === "easy")
        numSimulations = 100;
    else if (difficulty === "medium")
        numSimulations = 200;
    else if (difficulty === "hard")
        numSimulations = 300;
    else if (difficulty === "veryhard")
        numSimulations = 300;  // Same as hard for now
    
    console.log(`[Script] MCTS difficulty: ${difficulty}, simulations: ${numSimulations}`);
    
    const agent = getMCTSAgent();
    
    if (!agent.isReady) {
        console.error("[Script] MCTS agent not ready!");
        // Fall back to tree search AI
        console.log("[Script] Falling back to tree-search AI");
        return getAIBestMove(boardElement, player_str);
    }
    
    try {
        const move = await agent.getBestMove(boardElement, player_str, numSimulations);
        
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
    computer_eval = 0.0;
    document.getElementById('AI-eval').innerHTML = `AI eval:<br>${computer_eval.toFixed(2)}`;

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
}

function movePiece(sourceCell, targetCell) {
    // Move the piece to the new cell
    const piece = getPieceFromCell(sourceCell);
    setPieceInCell(targetCell, piece);
    // Introduce a delay before capturing
    capturePieces(sourceCell, targetCell, boardElement);
    setPieceInCell(sourceCell, ''); // Clear the old position
    // Clear class of source and destination
    sourceCell.className = '';
    targetCell.className = '';
    // Add appropriate class to the destination
    targetCell.classList.add(piece);


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
    if ((gameMode[currentPlayer] === 'AI') && (!gameOver)) {
        makeAIMove();
    }else if(!document.getElementById("AI-eval").classList.contains('hidden')){
        getAIBestMove(boardElement, currentPlayer);
    }
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
    
    // Refresh policy visualization for new player
    if (policyVisualizationEnabled) {
        updatePolicyVisualization();
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

function startGame(attackerMode, defenderMode) {
    resetBoard();
    currentPlayer = 'attacker';
    gameMode = { attacker: attackerMode, defender: defenderMode };
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
            
            // Update policy visualization to show all pieces (no need to recompute)
            if (policyVisualizationEnabled && currentPolicyData) {
                visualizePolicyForAllPieces();
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
            if (policyVisualizationEnabled) {
                visualizePolicyForPiece(cell);
            }
            return;
        } else if (currentPlayer === 'defender' && isDefender(piece)) {
            removeHighlights(boardElement); // Remove any move highlights
            deselectAll(boardElement);
            cell.classList.add('selected');  // Add the 'selected' class
            highlightLegalMoves(cell, boardElement);
            selectedPiece = cell;
            
            // Update policy visualization for this piece
            if (policyVisualizationEnabled) {
                visualizePolicyForPiece(cell);
            }
            return;
        }

        // If making a move to an empty square
        if (!piece) {
            if (!isValidMove(selectedPiece, cell, boardElement)) {
                return;
            }
            movePiece(selectedPiece, cell);
            removeHighlights(boardElement); // Remove move highlights after moving
            selectedPiece.classList.remove('selected');  // Remove the 'selected' class
            selectedPiece = null;
            
            // Clear policy data after move (will need to recompute)
            currentPolicyData = null;
            if (policyVisualizationEnabled) {
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
        if (policyVisualizationEnabled) {
            visualizePolicyForPiece(cell);
        }
    } else if (currentPlayer === 'defender' && isDefender(piece)) {
        highlightLegalMoves(cell, boardElement);    
        selectedPiece = cell; // Mark the piece as selected
        cell.classList.add('selected');  // Add the 'selected' class
        
        // Update policy visualization for this piece
        if (policyVisualizationEnabled) {
            visualizePolicyForPiece(cell);
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
    if (helpText.classList.contains('hidden')) {
        helpText.classList.remove('hidden');
    } else {
        helpText.classList.add('hidden');
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
            row.push(boardElement.rows[r].cells[c].innerText);
        }
        board.push(row);
    }
    return board;
}

document.getElementById('btn-human-human').addEventListener('click', function() {
    gameMode.attacker = 'Human';
    gameMode.defender = 'Human';
    resetGame();
});

document.getElementById('btn-human-ai').addEventListener('click', function() {
    gameMode.attacker = 'Human';
    gameMode.defender = 'AI';
    resetGame();
});

document.getElementById('btn-ai-human').addEventListener('click', function() {
    gameMode.attacker = 'AI';
    gameMode.defender = 'Human';
    resetGame();
});

document.getElementById('btn-ai-ai').addEventListener('click', function() {
    gameMode.attacker = 'AI';
    gameMode.defender = 'AI';
    resetGame();
    makeAIMove(); // Start the game with AI's move since attacker goes first
});

const boardElement = document.getElementById('board');

// Policy visualization state
let policyVisualizationEnabled = false;
let policySource = 'network'; // 'network' or 'mcts'
let currentPolicyData = null; // Stores {policy: Float32Array, visitCounts: Map}

// Initialize MCTS agent on page load
console.log("[Script] Initializing MCTS agent on page load...");
initializeMCTSAgent().then(success => {
    if (success) {
        console.log("[Script] MCTS agent initialized successfully!");
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

// Policy visualization toggle button
document.getElementById('policy-viz-toggle-btn').addEventListener('click', function() {
    policyVisualizationEnabled = !policyVisualizationEnabled;
    this.textContent = policyVisualizationEnabled ? 'Hide Policy' : 'Show Policy';
    
    // Show/hide the policy source toggle button
    const sourceBtn = document.getElementById('policy-source-toggle-btn');
    if (policyVisualizationEnabled && getAIType() === 'mcts') {
        sourceBtn.classList.remove('hidden');
    } else {
        sourceBtn.classList.add('hidden');
    }
    
    if (policyVisualizationEnabled) {
        updatePolicyVisualization();
    } else {
        clearPolicyVisualization();
    }
});

// Policy source toggle button (Network vs MCTS)
document.getElementById('policy-source-toggle-btn').addEventListener('click', function() {
    policySource = policySource === 'network' ? 'mcts' : 'network';
    this.innerHTML = `Policy Source:<br>${policySource === 'network' ? 'Network' : 'MCTS'}`;
    
    // Clear cached policy data to force recomputation
    currentPolicyData = null;
    
    if (policyVisualizationEnabled) {
        updatePolicyVisualization();
    }
});

/**
 * Update policy visualization on the board
 */
async function updatePolicyVisualization() {
    const aiType = getAIType();
    
    // Only works with MCTS
    if (aiType !== 'mcts') {
        console.log("[Policy Viz] Not available for tree-search AI");
        clearPolicyVisualization();
        return;
    }
    
    try {
        // Get policy and optionally MCTS data
        if (policySource === 'network') {
            // Always get fresh network policy when in network mode
            const result = await window.mctsAgent.getPolicy(boardElement, currentPlayer);
            currentPolicyData = {
                policy: result.policy,
                visitCounts: null
            };
        } else {
            // Get MCTS visit counts (run a quick search)
            const difficulty = getAIDifficulty();
            const simCount = { easy: 50, medium: 100, hard: 150, veryhard: 200 }[difficulty] || 100;
            
            const result = await window.mctsAgent.getBestMove(boardElement, currentPlayer, simCount);
            if (result && result.policyData) {
                currentPolicyData = result.policyData; // Contains both policy and visitCounts
            } else {
                console.error("[Policy Viz] getBestMove returned null or no policy data");
                // Fall back to network policy
                const networkResult = await window.mctsAgent.getPolicy(boardElement, currentPlayer);
                currentPolicyData = {
                    policy: networkResult.policy,
                    visitCounts: null
                };
            }
        }
        
        // Visualize based on selected piece
        if (selectedPiece) {
            visualizePolicyForPiece(selectedPiece);
        } else {
            visualizePolicyForAllPieces();
        }
    } catch (error) {
        console.error("[Policy Viz] Error:", error);
        clearPolicyVisualization();
    }
}

/**
 * Visualize policy probabilities for selecting each piece
 */
function visualizePolicyForAllPieces() {
    if (!currentPolicyData) return;
    
    clearPolicyVisualization();
    
    const encoder = new MoveEncoder();
    const legalMoves = encoder.getAllLegalMoves(boardElement, currentPlayer);
    
    console.log(`[Policy Viz] visualizePolicyForAllPieces: ${legalMoves.length} legal moves`);
    
    // Group moves by source piece
    const pieceProbs = new Map(); // Map from "row,col" to probability/count
    
    for (const move of legalMoves) {
        const moveIdx = encoder.encodeMove(move.fromRow, move.fromCol, move.toRow, move.toCol);
        let prob;
        
        if (policySource === 'mcts' && currentPolicyData.visitCounts) {
            // Use MCTS visit counts (raw counts, not normalized yet)
            prob = currentPolicyData.visitCounts.get(moveIdx) || 0;
        } else {
            // Use raw network policy (already probabilities)
            prob = currentPolicyData.policy[moveIdx] || 0;
        }
        
        const key = `${move.fromRow},${move.fromCol}`;
        pieceProbs.set(key, (pieceProbs.get(key) || 0) + prob);
    }
    
    console.log(`[Policy Viz] Piece probabilities/counts:`, Array.from(pieceProbs.entries()).slice(0, 5));
    
    // Normalize to get percentages
    const total = Array.from(pieceProbs.values()).reduce((a, b) => a + b, 0);
    console.log(`[Policy Viz] Total: ${total}, Source: ${policySource}`);
    
    if (total > 0) {
        for (const [key, value] of pieceProbs.entries()) {
            const percentage = ((value / total) * 100).toFixed(1);
            const [row, col] = key.split(',').map(Number);
            const cell = boardElement.rows[row].cells[col];
            console.log(`[Policy Viz] Piece at (${row},${col}): value=${value}, percentage=${percentage}%`);
            showPolicyOnCell(cell, percentage);
        }
    }
}

/**
 * Visualize policy probabilities for moves from a selected piece
 */
function visualizePolicyForPiece(pieceCell) {
    if (!currentPolicyData) return;
    
    clearPolicyVisualization();
    
    const encoder = new MoveEncoder();
    const fromRow = pieceCell.parentNode.rowIndex;
    const fromCol = pieceCell.cellIndex;
    
    const legalMoves = encoder.getAllLegalMoves(boardElement, currentPlayer)
        .filter(m => m.fromRow === fromRow && m.fromCol === fromCol);
    
    // Get probabilities for each move
    const moveProbs = new Map();
    
    for (const move of legalMoves) {
        const moveIdx = encoder.encodeMove(move.fromRow, move.fromCol, move.toRow, move.toCol);
        let prob;
        
        if (policySource === 'mcts' && currentPolicyData.visitCounts) {
            prob = currentPolicyData.visitCounts.get(moveIdx) || 0;
        } else {
            prob = currentPolicyData.policy[moveIdx] || 0;
        }
        
        moveProbs.set(`${move.toRow},${move.toCol}`, prob);
    }
    
    // Normalize to get percentages
    const total = Array.from(moveProbs.values()).reduce((a, b) => a + b, 0);
    if (total > 0) {
        for (const [key, value] of moveProbs.entries()) {
            const percentage = ((value / total) * 100).toFixed(1);
            const [row, col] = key.split(',').map(Number);
            const cell = boardElement.rows[row].cells[col];
            showPolicyOnCell(cell, percentage);
        }
    }
}

/**
 * Display policy percentage on a cell
 */
function showPolicyOnCell(cell, percentage) {
    // Create or update overlay div
    let overlay = cell.querySelector('.policy-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'policy-overlay';
        overlay.style.pointerEvents = 'none';  // Ensure clicks pass through
        cell.appendChild(overlay);
    }
    overlay.textContent = `${percentage}%`;
}

/**
 * Clear all policy visualizations
 */
function clearPolicyVisualization() {
    const overlays = boardElement.querySelectorAll('.policy-overlay');
    overlays.forEach(overlay => overlay.remove());
}
