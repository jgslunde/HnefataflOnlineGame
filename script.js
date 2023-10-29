Module['onRuntimeInitialized'] = function() {
    // Now you can safely call functions from your WebAssembly module
    console.log("Emscripten module loaded.")
};


function isDefender(piece) {
    return ['⚫', '⬛'].includes(piece);
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
            if (boardElement.rows[sourceRow].cells[col].innerText !== '') {
                return false;
            }
        }
    } else if (sourceCol === targetCol) {  // Moving vertically
        const startRow = Math.min(sourceRow, targetRow);
        const endRow = Math.max(sourceRow, targetRow);

        for (let row = startRow + 1; row < endRow; row++) {
            if (boardElement.rows[row].cells[sourceCol].innerText !== '') {
                return false;
            }
        }
    }

    return true;
}

function isValidMove(source, target, boardElement) {
    // Check if moving onto another piece
    if (['⚪', '⚫', '⬛'].includes(target.innerText)) {
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
    if (isCornerSquare(targetRow, targetCol) && source.innerText !== '⬛') {
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

        if (target.innerText === '⚪' && enemyCell.innerText === '⚫' && (allyCell.innerText === '⚪' || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the defender
        } else if ((target.innerText === '⚫' || target.innerText === '⬛') && enemyCell.innerText === '⚪' && (isDefender(allyCell.innerText) || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the attacker
        } else if (target.innerText === '⚪' && enemyCell.innerText === '⬛' && (allyCell.innerText === '⚪' || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the king
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
            if (cell.textContent === '⬛') {
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
            } else if (cell.textContent === '⚪') {
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
            if ((player === 'attacker' && cell.innerText === '⚪') || 
                (player === 'defender' && (cell.innerText === '⚫' || cell.innerText === '⬛'))) {
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

function getAIDifficulty() {
    for (let radioButton of aiDifficultyRadioButtons) {
        if (radioButton.checked) {
            return radioButton.value;
        }
    }
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

    let player = player_str === 'attacker'? 1 : -1;
    let board_arr = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            if(cell.innerText === '⚪')
                board_arr.push(1);
            else if(cell.innerText === '⚫')
                board_arr.push(2);
            else if(cell.innerText === '⬛')
                board_arr.push(3);
            else
                board_arr.push(0);
        }
    }
    let size = board_arr.length;

    let ptr_movefrom_x = Module._malloc(4);
    let ptr_movefrom_y = Module._malloc(4);
    let ptr_moveto_x = Module._malloc(4);
    let ptr_moveto_y = Module._malloc(4);
    let board_ptr = Module._malloc(size * 4);
    let board_dataHeap = new Int32Array(Module.HEAP32.buffer, board_ptr, size);
    board_dataHeap.set(board_arr);

    // Call the C++ function
    Module._AI_web_get_move(ptr_movefrom_x, ptr_movefrom_y, ptr_moveto_x, ptr_moveto_y, board_ptr, player, max_depth);
    let movefrom_x = new Int32Array(Module.HEAP32.buffer, ptr_movefrom_x, 1)[0];
    let movefrom_y = new Int32Array(Module.HEAP32.buffer, ptr_movefrom_y, 1)[0];
    let moveto_x = new Int32Array(Module.HEAP32.buffer, ptr_moveto_x, 1)[0];
    let moveto_y = new Int32Array(Module.HEAP32.buffer, ptr_moveto_y, 1)[0];
    
    return {
        piece: boardElement.rows[movefrom_y].cells[movefrom_x],
        target: boardElement.rows[moveto_y].cells[moveto_x]
    };
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

    // Remove the "win" overlay.
    const overlay = document.getElementById('overlay');
    overlay.classList.add('hidden'); // Show the overlay


    // Clear the current board content
    boardElement.innerHTML = '';

    const initialSetup = [
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['⚪', '⚪', '⚫', '⬛', '⚫', '⚪', '⚪'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0']
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
    targetCell.innerText = sourceCell.innerText;
    // Introduce a delay before capturing
    capturePieces(sourceCell, targetCell, boardElement);
    sourceCell.innerText = ''; // Clear the old position
    // Clear class of source and destination
    sourceCell.className = '';
    targetCell.className = '';
    // Add appropriate class to the destination
    targetCell.classList.add(targetCell.innerText);


    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            cell.classList.remove('legal-move');
        }
    }
    let win = checkForVictory(boardElement);
    console.log(win);
    if(win !== 0){
        return;
    }

    // Switch turns
    togglePlayer();

    if ((gameMode[currentPlayer] === 'AI') && (!gameOver)) {
        makeAIMove();
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
    aiMoveTimeout = setTimeout(() => {  // Add a delay for better user experience

        const move = getAIBestMove(boardElement, currentPlayer);

        if (move) {
            movePiece(move.piece, move.target);
        }
    }, 600);
}

function togglePlayer() {
    if (currentPlayer === 'attacker') {
        currentPlayer = 'defender';
        boardElement.className = 'defender';
    } else {
        currentPlayer = 'attacker';
        boardElement.className = 'attacker';
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
    const cell = event.target;
    
    // If a piece is already selected
    if (selectedPiece) {
        // If trying to replace an existing piece, check if it's the same piece to deselect
        if (cell === selectedPiece) {
            removeHighlights(boardElement); // Remove any move highlights
            cell.classList.remove('selected');  // Remove the 'selected' class
            selectedPiece = null;
            return;
        }

        // If trying to select another piece of the same player
        if (currentPlayer === 'attacker' && cell.innerText === '⚪') {
            removeHighlights(boardElement); // Remove any move highlights
            deselectAll(boardElement);
            cell.classList.add('selected');  // Add the 'selected' class
            highlightLegalMoves(cell, boardElement);
            selectedPiece = cell;
            return;
        } else if (currentPlayer === 'defender' && isDefender(cell.innerText)) {
            removeHighlights(boardElement); // Remove any move highlights
            deselectAll(boardElement);
            cell.classList.add('selected');  // Add the 'selected' class
            highlightLegalMoves(cell, boardElement);
            selectedPiece = cell;
            return;
        }

        // If making a move to an empty square
        if (!cell.innerText) {
            if (!isValidMove(selectedPiece, cell, boardElement)) {
                return;
            }
            movePiece(selectedPiece, cell);
            removeHighlights(boardElement); // Remove move highlights after moving
            selectedPiece.classList.remove('selected');  // Remove the 'selected' class
            selectedPiece = null;
            return;
        }
    }

    // If a piece is not selected and the clicked cell has a piece
    if (currentPlayer === 'attacker' && cell.innerText === '⚪') {
        selectedPiece = cell; // Mark the piece as selected
        highlightLegalMoves(cell, boardElement);        
        cell.classList.add('selected');  // Add the 'selected' class
    } else if (currentPlayer === 'defender' && isDefender(cell.innerText)) {
        highlightLegalMoves(cell, boardElement);    
        selectedPiece = cell; // Mark the piece as selected
        cell.classList.add('selected');  // Add the 'selected' class
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

document.addEventListener('DOMContentLoaded', function() {
    const initialSetup = [
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['⚪', '⚪', '⚫', '⬛', '⚫', '⚪', '⚪'],
        ['0', '0', '0', '⚫', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0'],
        ['0', '0', '0', '⚪', '0', '0', '0']
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