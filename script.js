Module['onRuntimeInitialized'] = function() {
    // Now you can safely call functions from your WebAssembly module
    console.log("Emscripten module loaded.")
};


function isDefender(piece) {
    return ['D', 'K'].includes(piece);
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
    if (['A', 'D', 'K'].includes(target.innerText)) {
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
    if (isCornerSquare(targetRow, targetCol) && source.innerText !== 'K') {
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

        if (target.innerText === 'A' && enemyCell.innerText === 'D' && (allyCell.innerText === 'A' || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the defender
        } else if ((target.innerText === 'D' || target.innerText === 'K') && enemyCell.innerText === 'A' && (isDefender(allyCell.innerText) || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the attacker
        } else if (target.innerText === 'A' && enemyCell.innerText === 'K' && (allyCell.innerText === 'A' || isRestrictedSquare(allyRow, allyCol))) {
            enemyCell.innerText = '';  // Capture the king
        }
    }
}



function checkForVictory(boardElement) {
    let kingPresent = false;
    let attackerCount = 0;

    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            if (cell.textContent === 'K') {
                kingPresent = true;

                // Check if king is on a corner
                if (
                    (cell.cellIndex === 0 && (row.rowIndex === 0 || row.rowIndex === 6)) ||
                    (cell.cellIndex === 6 && (row.rowIndex === 0 || row.rowIndex === 6))
                ) {
                    gameOver=true;
                    alert("Defenders Win! The king has reached a corner.");
                    return -1;
                }
            } else if (cell.textContent === 'A') {
                attackerCount++;
            }
        }
    }

    if (!kingPresent) {
        gameOver=true;
        alert("Attackers Win! The king has been captured.");
        return 1;
    } else if (attackerCount === 0) {
        gameOver=true;
        alert("Defenders Win! All attackers have been captured.");
        return -1;
    }
    return 0;
}


function getRandomLegalMove(boardElement, player) {
    const pieces = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            if ((player === 'attacker' && cell.innerText === 'A') || 
                (player === 'defender' && (cell.innerText === 'D' || cell.innerText === 'K'))) {
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

function getAIBestMove(boardElement, player_str) {
    let player = player_str === 'attacker'? 1 : -1;
    let board_arr = [];
    for (let row of boardElement.rows) {
        for (let cell of row.cells) {
            if(cell.innerText === 'A')
                board_arr.push(1);
            else if(cell.innerText === 'D')
                board_arr.push(2);
            else if(cell.innerText === 'K')
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
    Module._AI_web_get_move(ptr_movefrom_x, ptr_movefrom_y, ptr_moveto_x, ptr_moveto_y, board_ptr, player, 4);
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

function resetBoard() {
    gameOver = false;

    // Clear the current board content
    boardElement.innerHTML = '';

    const initialSetup = [
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'D', '0', '0', '0'],
        ['A', 'A', 'D', 'K', 'D', 'A', 'A'],
        ['0', '0', '0', 'D', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0']
    ];

    for (let row of initialSetup) {
        const tr = document.createElement('tr');
        for (let cell of row) {
            const td = document.createElement('td');
            if (cell !== '0') {
                td.innerText = cell;
            }

            // Attach the click event to the cell
            td.addEventListener('click', handleCellClick);

            tr.appendChild(td);
        }
        boardElement.appendChild(tr);
    }

}

function movePiece(sourceCell, targetCell) {
    // Move the piece to the new cell
    targetCell.innerText = sourceCell.innerText;
    capturePieces(sourceCell, targetCell, boardElement);
    sourceCell.innerText = ''; // Clear the old position

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

    if ((gameMode[currentPlayer] === 'ai') && (!gameOver)) {
        makeAIMove();
    }
}


function makeAIMove() {
    if (gameOver || gameMode[currentPlayer] !== 'ai') {
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
    }, 500);    
}

function togglePlayer() {
    currentPlayer = currentPlayer === 'attacker' ? 'defender' : 'attacker';
}

let gameOver = false;
let currentPlayer = 'attacker';
const gameMode = {
    attacker: 'human',
    defender: 'human'
};
let aiMoveTimeout = null;
let selectedPiece = null;


function startGame(attackerMode, defenderMode) {
    resetBoard();
    currentPlayer = 'attacker';
    gameMode = { attacker: attackerMode, defender: defenderMode };
    if (gameMode[currentPlayer] === 'ai') {
        makeAIMove();
    }
}

// Event listener for piece selection or movement
function handleCellClick(event) {
    if (gameOver) return;
    const cell = event.target;

    // If a piece is already selected
    if (selectedPiece) {
        // If trying to replace an existing piece, ignore
        if (cell.innerText && ['A', 'D', 'K'].includes(cell.innerText)) {
            return;
        }
        if (!isValidMove(selectedPiece, cell, boardElement)) {
            return;
        }

        movePiece(selectedPiece, cell);
        // Deselect the piece
        selectedPiece = null;
        return;
    }

    // If a piece is not selected and the clicked cell has a piece
    if (currentPlayer === 'attacker' && cell.innerText === 'A') {
        selectedPiece = cell; // Mark the piece as selected
        highlightLegalMoves(cell, boardElement);        
    } else if (currentPlayer === 'defender' && isDefender(cell.innerText)) {
        highlightLegalMoves(cell, boardElement);    
        selectedPiece = cell; // Mark the piece as selected
    }
}

function resetGame() {
    clearTimeout(aiMoveTimeout);
    resetBoard();
    currentPlayer = 'attacker';
    if (gameMode[currentPlayer] === 'ai'){
        makeAIMove();
    }
}

document.getElementById('btn-human-human').addEventListener('click', function() {
    gameMode.attacker = 'human';
    gameMode.defender = 'human';
    resetGame();
});

document.getElementById('btn-human-ai').addEventListener('click', function() {
    gameMode.attacker = 'human';
    gameMode.defender = 'ai';
    resetGame();
});

document.getElementById('btn-ai-human').addEventListener('click', function() {
    gameMode.attacker = 'ai';
    gameMode.defender = 'human';
    resetGame();
});

document.getElementById('btn-ai-ai').addEventListener('click', function() {
    gameMode.attacker = 'ai';
    gameMode.defender = 'ai';
    resetGame();
    makeAIMove(); // Start the game with AI's move since attacker goes first
});

const boardElement = document.getElementById('board');

document.addEventListener('DOMContentLoaded', function() {
    const initialSetup = [
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'D', '0', '0', '0'],
        ['A', 'A', 'D', 'K', 'D', 'A', 'A'],
        ['0', '0', '0', 'D', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0'],
        ['0', '0', '0', 'A', '0', '0', '0']
    ];

    for (let row of initialSetup) {
        const tr = document.createElement('tr');
        for (let cell of row) {
            const td = document.createElement('td');
            if (cell !== '0') {
                td.innerText = cell;
            }

            // Attach the click event to the cell
            td.addEventListener('click', handleCellClick);

            tr.appendChild(td);
        }
        boardElement.appendChild(tr);
    }
});
