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
     * @returns {Object} {piece, target} - cells to move from/to
     */
    async getBestMove(boardElement, player, numSimulations = null) {
        if (!this.isReady) {
            console.error("[MCTSAgent] Agent not ready. Call initialize() first.");
            return null;
        }
        
        console.log(`[MCTSAgent] getBestMove called for ${player}`);
        
        // Update simulation count if provided
        if (numSimulations !== null && numSimulations !== this.mcts.numSimulations) {
            this.createMCTS(numSimulations);
        }
        
        try {
            const move = await this.mcts.selectMove(boardElement, player, 0.0);
            return move;
        } catch (error) {
            console.error("[MCTSAgent] Error selecting move:", error);
            return null;
        }
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
let mctsAgent = null;

/**
 * Get or create the global MCTS agent instance
 * @returns {MCTSAgent}
 */
function getMCTSAgent() {
    if (!mctsAgent) {
        mctsAgent = new MCTSAgent();
    }
    return mctsAgent;
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
