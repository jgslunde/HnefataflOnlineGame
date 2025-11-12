#!/usr/bin/env python3
"""
Export PyTorch model to ONNX format optimized for web deployment.
This ensures compatibility with ONNX Runtime Web.
"""

import torch
import sys
from pathlib import Path

# Add Python_example to path
sys.path.insert(0, str(Path(__file__).parent / "Python_example"))

from network import BrandubhNet

def infer_network_architecture(state_dict):
    """
    Infer num_res_blocks and num_channels from the state dict.
    
    Args:
        state_dict: Model state dictionary
        
    Returns:
        tuple: (num_res_blocks, num_channels)
    """
    # Determine num_channels from the input conv layer
    if 'conv_input.weight' in state_dict:
        num_channels = state_dict['conv_input.weight'].shape[0]
    else:
        raise ValueError("Cannot find conv_input.weight in state dict")
    
    # Count residual blocks by looking for res_blocks.X.conv1.weight keys
    num_res_blocks = 0
    for key in state_dict.keys():
        if key.startswith('res_blocks.') and key.endswith('.conv1.weight'):
            # Extract block number from key like "res_blocks.3.conv1.weight"
            block_num = int(key.split('.')[1])
            num_res_blocks = max(num_res_blocks, block_num + 1)
    
    if num_res_blocks == 0:
        raise ValueError("Cannot determine number of residual blocks from state dict")
    
    return num_res_blocks, num_channels

def export_model_to_onnx(checkpoint_path, output_path, opset_version=14, 
                         num_res_blocks=None, num_channels=None):
    """
    Export a PyTorch checkpoint to ONNX format.
    
    Args:
        checkpoint_path: Path to .pt or .pth checkpoint file
        output_path: Where to save the .onnx file
        opset_version: ONNX opset version (14 is well-supported by onnxruntime-web)
        num_res_blocks: Number of residual blocks (auto-detected if None)
        num_channels: Number of channels (auto-detected if None)
    """
    print(f"Loading model from {checkpoint_path}...")
    
    # Load weights
    try:
        # Use weights_only=False for older checkpoints with numpy objects
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
        
        # Handle different checkpoint formats
        if isinstance(checkpoint, dict):
            if 'model_state_dict' in checkpoint:
                # Training checkpoint with optimizer state, etc.
                state_dict = checkpoint['model_state_dict']
                print(f"✓ Loaded training checkpoint (iteration {checkpoint.get('iteration', 'unknown')})")
            elif 'state_dict' in checkpoint:
                state_dict = checkpoint['state_dict']
                print("✓ Loaded checkpoint with 'state_dict' key")
            else:
                # Assume the checkpoint is the state dict itself
                state_dict = checkpoint
                print("✓ Loaded state dict directly")
        else:
            state_dict = checkpoint
            print("✓ Loaded model directly")
    except Exception as e:
        print(f"✗ Error loading checkpoint: {e}")
        return False
    
    # Infer or use provided architecture parameters
    if num_res_blocks is None or num_channels is None:
        print("Inferring network architecture from checkpoint...")
        inferred_res_blocks, inferred_channels = infer_network_architecture(state_dict)
        
        if num_res_blocks is None:
            num_res_blocks = inferred_res_blocks
        if num_channels is None:
            num_channels = inferred_channels
            
        print(f"✓ Detected architecture: {num_res_blocks} residual blocks, {num_channels} channels")
    else:
        print(f"Using provided architecture: {num_res_blocks} residual blocks, {num_channels} channels")
    
    # Create model with detected/provided architecture
    model = BrandubhNet(num_res_blocks=num_res_blocks, num_channels=num_channels)
    
    # Load state dict into model
    try:
        model.load_state_dict(state_dict)
        print("✓ Model loaded successfully")
    except Exception as e:
        print(f"✗ Error loading state dict into model: {e}")
        return False
    
    model.eval()
    
    # Create dummy input (batch_size=1, channels=4, height=7, width=7)
    dummy_input = torch.randn(1, 4, 7, 7)
    
    print(f"\nExporting to ONNX (opset {opset_version})...")
    
    try:
        # Export with all data embedded (no external data file)
        # This is required for ONNX Runtime Web to work properly
        torch.onnx.export(
            model,
            dummy_input,
            output_path,
            export_params=True,
            opset_version=opset_version,
            do_constant_folding=True,
            input_names=['input'],
            output_names=['policy', 'value'],
            dynamic_axes={
                'input': {0: 'batch_size'},
                'policy': {0: 'batch_size'},
                'value': {0: 'batch_size'}
            },
            verbose=False
        )
        
        # Load the exported model and re-save with all data embedded
        # This prevents external data files which don't work in browsers
        import onnx
        model_proto = onnx.load(output_path)
        onnx.save(model_proto, output_path, save_as_external_data=False)
        print("✓ Re-saved model with embedded data (no external files)")
        print(f"✓ Model exported to {output_path}")
        
        # Verify the exported model
        print("\nVerifying exported model...")
        import onnx
        
        onnx_model = onnx.load(output_path)
        onnx.checker.check_model(onnx_model)
        print("✓ ONNX model is valid")
        
        # Print model info
        print("\nModel Information:")
        print(f"  Inputs: {[inp.name for inp in onnx_model.graph.input]}")
        print(f"  Outputs: {[out.name for out in onnx_model.graph.output]}")
        print(f"  Opset version: {onnx_model.opset_import[0].version}")
        
        # Print input shapes
        for inp in onnx_model.graph.input:
            print(f"  Input '{inp.name}' shape: {[d.dim_value if d.dim_value > 0 else 'dynamic' for d in inp.type.tensor_type.shape.dim]}")
        
        # Print output shapes
        for out in onnx_model.graph.output:
            print(f"  Output '{out.name}' shape: {[d.dim_value if d.dim_value > 0 else 'dynamic' for d in out.type.tensor_type.shape.dim]}")
        
        return True
        
    except Exception as e:
        print(f"✗ Error exporting model: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_exported_model(onnx_path):
    """Test the exported ONNX model using onnxruntime."""
    print(f"\n{'='*60}")
    print("Testing exported model with ONNX Runtime...")
    print('='*60)
    
    try:
        import onnxruntime as ort
        import numpy as np
        
        # Create session
        session = ort.InferenceSession(onnx_path)
        
        print(f"✓ Model loaded successfully with ONNX Runtime")
        print(f"  Available providers: {ort.get_available_providers()}")
        print(f"  Using provider: {session.get_providers()}")
        
        # Create dummy input
        dummy_input = np.random.randn(1, 4, 7, 7).astype(np.float32)
        
        # Run inference
        outputs = session.run(None, {'input': dummy_input})
        
        print(f"\n✓ Inference successful!")
        print(f"  Policy shape: {outputs[0].shape}")
        print(f"  Value shape: {outputs[1].shape}")
        print(f"  Policy sum: {outputs[0].sum():.4f}")
        print(f"  Value: {outputs[1][0][0]:.4f}")
        
        return True
        
    except ImportError:
        print("⚠ onnxruntime not installed, skipping test")
        print("  Install with: pip install onnxruntime")
        return True
    except Exception as e:
        print(f"✗ Error testing model: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Export PyTorch model to ONNX for web deployment')
    parser.add_argument('checkpoint', help='Path to PyTorch checkpoint (.pt or .pth)')
    parser.add_argument('-o', '--output', help='Output ONNX file path', default='checkpoints/checkpoint_iter_99.onnx')
    parser.add_argument('--opset', type=int, default=14, help='ONNX opset version (default: 14)')
    parser.add_argument('--test', action='store_true', help='Test the exported model with onnxruntime')
    parser.add_argument('--num-res-blocks', type=int, default=None, 
                        help='Number of residual blocks (auto-detected if not provided)')
    parser.add_argument('--num-channels', type=int, default=None,
                        help='Number of channels (auto-detected if not provided)')
    
    args = parser.parse_args()
    
    # Create output directory if needed
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    
    # Export model
    success = export_model_to_onnx(
        args.checkpoint, 
        args.output, 
        args.opset,
        num_res_blocks=args.num_res_blocks,
        num_channels=args.num_channels
    )
    
    if not success:
        print("\n✗ Export failed!")
        sys.exit(1)
    
    # Test if requested
    if args.test:
        test_success = test_exported_model(args.output)
        if not test_success:
            print("\n⚠ Test failed, but model may still work in browser")
    
    print(f"\n{'='*60}")
    print("✓ Export complete!")
    print('='*60)
    print(f"\nONNX model saved to: {args.output}")
    print("\nNext steps:")
    print("  1. Test locally: python3 -m http.server 8000")
    print("  2. Visit: http://localhost:8000/test_mcts.html")
    print("  3. Deploy to GitHub Pages")
