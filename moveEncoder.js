/**
 * Move Encoder for Brandubh
 * 
 * Encodes and decodes moves to/from policy vector indices.
 * Matches the Python implementation in network.py
 * 
 * Policy encoding scheme:
 * - Each square (49 total) can initiate a move
 * - From each square, can move in 4 directions (up, down, left, right)
 * - Can move 1-6 squares in each direction
 * - Total: 49 * 4 * 6 = 1176 possible move encodings
 * 
 * Move format: (from_row, from_col, to_row, to_col)
 * Policy index: from_square * 24 + direction * 6 + (distance - 1)
 */

// Helper function to get piece from cell, ignoring policy overlay divs
function getPieceFromCell(cell) {
    for (let node of cell.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.trim();
        }
    }
    return '';
}

class MoveEncoder {
    constructor() {
        // Direction mappings
        this.DIRECTIONS = {
            0: [-1, 0],  // up
            1: [1, 0],   // down
            2: [0, -1],  // left
            3: [0, 1]    // right
        };
    }
    
    /**
     * Encode a move as a policy index
     * @param {number} fromRow 
     * @param {number} fromCol 
     * @param {number} toRow 
     * @param {number} toCol 
     * @returns {number} policy index in [0, 1175]
     */
    encodeMove(fromRow, fromCol, toRow, toCol) {
        const fromSquare = fromRow * 7 + fromCol;
        
        // Determine direction and distance
        const dr = toRow - fromRow;
        const dc = toCol - fromCol;
        
        let direction, distance;
        
        if (dr !== 0) {  // vertical move
            direction = dr < 0 ? 0 : 1;  // up or down
            distance = Math.abs(dr);
        } else {  // horizontal move
            direction = dc < 0 ? 2 : 3;  // left or right
            distance = Math.abs(dc);
        }
        
        const policyIndex = fromSquare * 24 + direction * 6 + (distance - 1);
        
        // Reduced logging - only uncomment for debugging
        // console.log(`[MoveEncoder] Encoded move (${fromRow},${fromCol})->(${toRow},${toCol}) as index ${policyIndex}`);
        return policyIndex;
    }
    
    /**
     * Decode a policy index to a move
     * @param {number} policyIndex - integer in [0, 1175]
     * @returns {Object} {fromRow, fromCol, toRow, toCol}
     */
    decodeMove(policyIndex) {
        const fromSquare = Math.floor(policyIndex / 24);
        const remainder = policyIndex % 24;
        const direction = Math.floor(remainder / 6);
        const distance = (remainder % 6) + 1;
        
        const fromRow = Math.floor(fromSquare / 7);
        const fromCol = fromSquare % 7;
        
        const [dr, dc] = this.DIRECTIONS[direction];
        const toRow = fromRow + dr * distance;
        const toCol = fromCol + dc * distance;
        
        return { fromRow, fromCol, toRow, toCol };
    }
    
    /**
     * Get a mask of legal moves for the current game state
     * @param {HTMLTableElement} boardElement - the game board
     * @param {string} player - 'attacker' or 'defender'
     * @returns {Float32Array} binary array of shape (1176,) where 1 = legal, 0 = illegal
     */
    getLegalMoveMask(boardElement, player) {
        const mask = new Float32Array(1176);
        
        // Get all pieces for current player
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
        
        // For each piece, check all possible moves
        for (let piece of pieces) {
            const fromRow = piece.parentNode.rowIndex;
            const fromCol = piece.cellIndex;
            
            // Try all 4 directions
            for (let dir = 0; dir < 4; dir++) {
                const [dr, dc] = this.DIRECTIONS[dir];
                
                // Try distances 1-6
                for (let distance = 1; distance <= 6; distance++) {
                    const toRow = fromRow + dr * distance;
                    const toCol = fromCol + dc * distance;
                    
                    // Check if target is on board
                    if (toRow < 0 || toRow >= 7 || toCol < 0 || toCol >= 7) {
                        break;  // Can't move further in this direction
                    }
                    
                    const targetCell = boardElement.rows[toRow].cells[toCol];
                    
                    // Check if move is valid
                    if (isValidMove(piece, targetCell, boardElement)) {
                        const policyIndex = this.encodeMove(fromRow, fromCol, toRow, toCol);
                        mask[policyIndex] = 1.0;
                    } else if (getPieceFromCell(targetCell) !== '') {
                        // Blocked by a piece, can't move further in this direction
                        break;
                    }
                }
            }
        }
        
        return mask;
    }
    
    /**
     * Get all legal moves as an array of move objects
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Array<Object>} array of {fromRow, fromCol, toRow, toCol, policyIndex}
     */
    getAllLegalMoves(boardElement, player) {
        const moves = [];
        
        // Get all pieces for current player
        for (let row of boardElement.rows) {
            for (let cell of row.cells) {
                const piece = getPieceFromCell(cell);
                if ((player === 'attacker' && piece === '⚫') || 
                    (player === 'defender' && (piece === '⚪' || piece === '⬜'))) {
                    
                    const fromRow = cell.parentNode.rowIndex;
                    const fromCol = cell.cellIndex;
                    
                    // Try all 4 directions
                    for (let dir = 0; dir < 4; dir++) {
                        const [dr, dc] = this.DIRECTIONS[dir];
                        
                        // Try distances 1-6
                        for (let distance = 1; distance <= 6; distance++) {
                            const toRow = fromRow + dr * distance;
                            const toCol = fromCol + dc * distance;
                            
                            // Check if target is on board
                            if (toRow < 0 || toRow >= 7 || toCol < 0 || toCol >= 7) {
                                break;
                            }
                            
                            const targetCell = boardElement.rows[toRow].cells[toCol];
                            
                            // Check if move is valid
                            if (isValidMove(cell, targetCell, boardElement)) {
                                const policyIndex = this.encodeMove(fromRow, fromCol, toRow, toCol);
                                moves.push({ fromRow, fromCol, toRow, toCol, policyIndex });
                            } else if (getPieceFromCell(targetCell) !== '') {
                                // Blocked by a piece
                                break;
                            }
                        }
                    }
                }
            }
        }
        
        return moves;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MoveEncoder;
}
