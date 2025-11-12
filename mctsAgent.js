/**
 * MCTS Agent for Brandubh
 * Integrates MCTS search with ONNX neural network
 */

class MCTSAgent {
    constructor() {
        this.session = null;
        this.moveEncoder = null;
        this.mcts = null;
        this.isLoading = false;
        this.isReady = false;
        
        console.log("[MCTSAgent] Created, waiting for initialization");
    }
    
    /**
     * Initialize the agent by loading the neural network
     */
    async initialize() {
        if (this.isLoading || this.isReady) {
            console.log("[MCTSAgent] Already initialized or loading");
            return;
        }
        
        this.isLoading = true;
        console.log("[MCTSAgent] Starting initialization...");
        
        try {
            // Check if ONNX Runtime is available
            if (typeof ort === 'undefined') {
                throw new Error("ONNX Runtime Web not loaded. Make sure to include the library.");
            }
            
            console.log("[MCTSAgent] ONNX Runtime Web version:", ort.env.versions);
            
            // Set execution providers
            // Single-threaded mode works on all static hosts (including GitHub Pages)
            // Multi-threading requires special HTTP headers (Cross-Origin-Isolation)
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.simd = true;
            console.log("[MCTSAgent] WASM threads:", ort.env.wasm.numThreads);
            
            // Load the ONNX model
            const modelPath = 'checkpoints/checkpoint_iter_99.onnx';
            console.log(`[MCTSAgent] Loading model from ${modelPath}...`);
            
            try {
                this.session = await ort.InferenceSession.create(modelPath, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all'
                });
                
                console.log("[MCTSAgent] Model loaded successfully!");
                console.log("[MCTSAgent] Input names:", this.session.inputNames);
                console.log("[MCTSAgent] Output names:", this.session.outputNames);
            } catch (modelError) {
                console.error("[MCTSAgent] Failed to load ONNX model:", modelError);
                console.error("[MCTSAgent] Error details:", {
                    message: modelError.message,
                    stack: modelError.stack,
                    name: modelError.name
                });
                throw new Error(`Failed to load ONNX model: ${modelError.message || modelError}`);
            }
            
            // Initialize move encoder
            this.moveEncoder = new MoveEncoder();
            console.log("[MCTSAgent] Move encoder initialized");
            
            // Create MCTS instance (will be recreated with different simulation counts)
            this.createMCTS(100); // Default
            
            this.isReady = true;
            this.isLoading = false;
            
            console.log("[MCTSAgent] Initialization complete!");
            
            // Test inference
            await this.testInference();
            
        } catch (error) {
            console.error("[MCTSAgent] Initialization failed:", error);
            this.isLoading = false;
            this.isReady = false;
            throw error;
        }
    }
    
    /**
     * Create MCTS instance with specified number of simulations
     * @param {number} numSimulations 
     */
    createMCTS(numSimulations) {
        console.log(`[MCTSAgent] Creating MCTS with ${numSimulations} simulations`);
        this.mcts = new MCTS(this.session, this.moveEncoder, numSimulations, 1.4);
    }
    
    /**
     * Test neural network inference
     */
    async testInference() {
        console.log("[MCTSAgent] Running test inference...");
        
        try {
            // Create a dummy input (4 planes, 7x7)
            const dummyInput = new Float32Array(4 * 7 * 7);
            const inputTensor = new ort.Tensor('float32', dummyInput, [1, 4, 7, 7]);
            
            const feeds = { input: inputTensor };
            const startTime = performance.now();
            const results = await this.session.run(feeds);
            const elapsedTime = performance.now() - startTime;
            
            console.log(`[MCTSAgent] Test inference completed in ${elapsedTime.toFixed(2)}ms`);
            console.log("[MCTSAgent] Output shapes:");
            for (let name in results) {
                console.log(`  ${name}: ${results[name].dims}`);
            }
            
            // Check output names
            const policyOutput = results.policy || results.output0 || results[this.session.outputNames[0]];
            const valueOutput = results.value || results.output1 || results[this.session.outputNames[1]];
            
            if (policyOutput) {
                console.log(`[MCTSAgent] Policy output size: ${policyOutput.data.length}`);
            }
            if (valueOutput) {
                console.log(`[MCTSAgent] Value output: ${valueOutput.data[0]}`);
            }
            
        } catch (error) {
            console.error("[MCTSAgent] Test inference failed:", error);
            throw error;
        }
    }
    
    /**
     * Get the best move for the current position
     * @param {HTMLTableElement} boardElement 
     * @param {string} player - 'attacker' or 'defender'
     * @param {number} numSimulations - number of MCTS simulations (optional, uses current setting if not provided)
     * @returns {Object} {piece, target, policyData} - cells to move from/to and policy information
     */
    async getBestMove(boardElement, player, numSimulations = null, temperature = 0.0) {
        if (!this.isReady) {
            console.error("[MCTSAgent] Agent not ready. Call initialize() first.");
            return null;
        }
        
        console.log(`[MCTSAgent] getBestMove called for ${player}, temperature=${temperature}`);
        
        // Update simulation count if provided
        if (numSimulations !== null && numSimulations !== this.mcts.numSimulations) {
            this.createMCTS(numSimulations);
        }
        
        try {
            const move = await this.mcts.selectMove(boardElement, player, temperature);
            
            // Include policy data from the search
            if (move && this.mcts.root) {
                const visitCounts = new Map();
                // Convert moveKey (string "r,c,r,c") to moveIdx (integer 0-1175)
                for (const [moveKey, child] of this.mcts.root.children.entries()) {
                    const [fromRow, fromCol, toRow, toCol] = moveKey.split(',').map(Number);
                    const moveIdx = this.moveEncoder.encodeMove(fromRow, fromCol, toRow, toCol);
                    visitCounts.set(moveIdx, child.visitCount);
                }
                
                move.policyData = {
                    policy: this.mcts.lastRawPolicy || new Float32Array(1176),
                    visitCounts: visitCounts
                };
            }
            
            return move;
        } catch (error) {
            console.error("[MCTSAgent] Error selecting move:", error);
            return null;
        }
    }
    
    /**
     * Get raw policy output from the neural network for the current position
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Object} {policy: Float32Array, value: number}
     */
    async getPolicy(boardElement, player) {
        if (!this.isReady) {
            console.error("[MCTSAgent] Agent not ready.");
            return null;
        }
        
        console.log(`[MCTSAgent] getPolicy called for ${player}`);
        
        try {
            // Get state representation (same as MCTS.getStateRepresentation)
            const state = this.getStateRepresentation(boardElement, player);
            
            // Run inference
            const feeds = { input: new ort.Tensor('float32', state, [1, 4, 7, 7]) };
            const results = await this.session.run(feeds);
            
            // Extract outputs
            const policyOutput = results.policy || results.output0 || results[this.session.outputNames[0]];
            const valueOutput = results.value || results.output1 || results[this.session.outputNames[1]];
            
            const policy = new Float32Array(policyOutput.data);
            const value = valueOutput.data[0];
            
            console.log(`[MCTSAgent] Raw policy retrieved, value: ${value.toFixed(3)}`);
            
            return { policy, value };
            
        } catch (error) {
            console.error("[MCTSAgent] Error getting policy:", error);
            return null;
        }
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
        
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const cell = boardElement.rows[r].cells[c];
                const idx = r * 7 + c;
                
                // Get the first text node (ignore policy overlay divs)
                let piece = '';
                for (let node of cell.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        piece = node.textContent.trim();
                        break;
                    }
                }
                
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
     * Get evaluation statistics for the current position
     * @param {HTMLTableElement} boardElement 
     * @param {string} player 
     * @returns {Object} {value, topMoves}
     */
    async getEvaluation(boardElement, player) {
        if (!this.isReady) {
            console.error("[MCTSAgent] Agent not ready.");
            return null;
        }
        
        console.log(`[MCTSAgent] getEvaluation called for ${player}`);
        
        try {
            // Run a quick search
            const visitProbs = await this.mcts.search(boardElement, player);
            
            const value = this.mcts.root ? this.mcts.root.meanValue : 0;
            
            // Get top 5 moves
            const topMoves = Array.from(visitProbs.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([moveKey, prob]) => ({
                    move: moveKey,
                    probability: prob,
                    visits: this.mcts.root.children.get(moveKey).visitCount
                }));
            
            return { value, topMoves };
            
        } catch (error) {
            console.error("[MCTSAgent] Error in evaluation:", error);
            return null;
        }
    }
}

// Create global instance
window.mctsAgent = null;

/**
 * Get or create the global MCTS agent instance
 * @returns {MCTSAgent}
 */
function getMCTSAgent() {
    if (!window.mctsAgent) {
        window.mctsAgent = new MCTSAgent();
    }
    return window.mctsAgent;
}

/**
 * Initialize the MCTS agent (should be called on page load)
 */
async function initializeMCTSAgent() {
    console.log("[Global] Initializing MCTS agent...");
    const agent = getMCTSAgent();
    
    try {
        await agent.initialize();
        console.log("[Global] MCTS agent ready!");
        return true;
    } catch (error) {
        console.error("[Global] Failed to initialize MCTS agent:", error);
        return false;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MCTSAgent, getMCTSAgent, initializeMCTSAgent };
}
