#!/usr/bin/env python3
"""
Export PyTorch SE model to ONNX format optimized for web deployment.
This script handles models with Squeeze-and-Excitation blocks.
"""

import torch

# Enable denormal flushing to prevent performance issues
# This ensures the exported ONNX model doesn't contain denormal numbers
torch.set_flush_denormal(True)

import sys
import os
from pathlib import Path
import numpy as np

# Add Python_example to path
sys.path.insert(0, str(Path(__file__).parent / "Python_example"))

import onnx
from onnxruntime.quantization import quantize_static, CalibrationDataReader, QuantType, QuantFormat

class BrandubhDataReader(CalibrationDataReader):
    """
    Generates calibration data for static quantization.
    This helps the quantizer determine the dynamic range of activations.
    """
    def __init__(self, num_samples=100):
        self.num_samples = num_samples
        self.current_index = 0
        # Create random board states for calibration
        # In a production scenario, real game states from a replay buffer are better,
        # but random states work reasonably well for determining value ranges.
        self.data = []
        for _ in range(num_samples):
            # Shape: (1, 4, 7, 7) matching your network input
            input_tensor = np.random.randn(1, 4, 7, 7).astype(np.float32)
            self.data.append({'input': input_tensor})

    def get_next(self):
        if self.current_index < self.num_samples:
            batch = self.data[self.current_index]
            self.current_index += 1
            return batch
        else:
            return None

def quantize_onnx_model(onnx_fp32_path, onnx_quant_path):
    """
    Quantizes the ONNX model to INT8 using Static Quantization.
    """
    print(f"\nQuantizing model to {onnx_quant_path}...")
    
    # 1. Create calibration data reader
    dr = BrandubhDataReader(num_samples=50)
    
    # 2. Perform Static Quantization
    # We use QOperator format which is generally faster for x86/WASM backends
    # We use QUInt8 for activations and QInt8 for weights (standard config)
    quantize_static(
        model_input=onnx_fp32_path,
        model_output=onnx_quant_path,
        calibration_data_reader=dr,
        quant_format=QuantFormat.QOperator,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
    )
    print("✓ Quantization complete.")


from network import BrandubhNet

def infer_network_architecture(state_dict):
    """
    Infer num_res_blocks, num_channels, and value_head_hidden_size from the state dict.
    
    Args:
        state_dict: Model state dictionary
        
    Returns:
        tuple: (num_res_blocks, num_channels, value_head_hidden_size)
    """
    # Determine num_channels from the input conv layer
    if 'conv_input.weight' in state_dict:
        num_channels = state_dict['conv_input.weight'].shape[0]
    else:
        raise ValueError("Cannot find conv_input.weight in state dict")
    
    # Count residual blocks by looking for res_blocks.X.se.2.weight keys (SE blocks)
    num_res_blocks = 0
    for key in state_dict.keys():
        if key.startswith('res_blocks.') and '.se.2.weight' in key:
            # Extract block number from key like "res_blocks.3.se.2.weight"
            block_num = int(key.split('.')[1])
            num_res_blocks = max(num_res_blocks, block_num + 1)
    
    if num_res_blocks == 0:
        raise ValueError("Cannot determine number of residual blocks from state dict")
    
    # Determine value head hidden size from fc_value1
    if 'fc_value1.weight' in state_dict:
        value_head_hidden_size = state_dict['fc_value1.weight'].shape[0]
    else:
        # Default to 64 if not found
        value_head_hidden_size = 64
    
    return num_res_blocks, num_channels, value_head_hidden_size

def export_model_to_onnx(checkpoint_path, output_path, opset_version=14, 
                         num_res_blocks=None, num_channels=None, value_head_hidden_size=None):
    """
    Export a PyTorch SE checkpoint to ONNX format.
    
    Args:
        checkpoint_path: Path to .pt or .pth checkpoint file
        output_path: Where to save the .onnx file
        opset_version: ONNX opset version (14 is well-supported by onnxruntime-web)
        num_res_blocks: Number of residual blocks (auto-detected if None)
        num_channels: Number of channels (auto-detected if None)
        value_head_hidden_size: Value head hidden layer size (auto-detected if None)
    """
    print(f"Loading SE model from {checkpoint_path}...")
    
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
    if num_res_blocks is None or num_channels is None or value_head_hidden_size is None:
        print("Inferring network architecture from checkpoint...")
        inferred_res_blocks, inferred_channels, inferred_value_hidden = infer_network_architecture(state_dict)
        
        if num_res_blocks is None:
            num_res_blocks = inferred_res_blocks
        if num_channels is None:
            num_channels = inferred_channels
        if value_head_hidden_size is None:
            value_head_hidden_size = inferred_value_hidden
            
        print(f"✓ Detected architecture: {num_res_blocks} SE residual blocks, {num_channels} channels, {value_head_hidden_size} value hidden units")
    else:
        print(f"Using provided architecture: {num_res_blocks} SE residual blocks, {num_channels} channels, {value_head_hidden_size} value hidden units")
    
    # Create model with detected/provided architecture
    model = BrandubhNet(
        num_res_blocks=num_res_blocks, 
        num_channels=num_channels,
        value_head_hidden_size=value_head_hidden_size
    )
    
    # Load state dict into model
    try:
        model.load_state_dict(state_dict)
        print("✓ Model loaded successfully")
    except Exception as e:
        print(f"✗ Error loading state dict into model: {e}")
        return False
    
    model.eval()
    
    # Fix denormal/subnormal performance issues by normalizing batch norm stats
    # This prevents extreme slowdowns caused by tiny activation values
    print("\nPreparing model for export...")
    print("  • Denormal flushing: ENABLED (torch.set_flush_denormal=True)")
    print("  • Checking batch normalization statistics...")
    
    max_running_var_before = 0
    num_fixed = 0
    for name, module in model.named_modules():
        if isinstance(module, torch.nn.BatchNorm2d):
            max_var = module.running_var.max().item()
            max_running_var_before = max(max_running_var_before, max_var)
            
            # Cap running variance at reasonable values to prevent denormals
            # Values > 10 can cause severe performance issues
            if max_var > 10.0:
                module.running_var.clamp_(max=10.0)
                num_fixed += 1
    
    if num_fixed > 0:
        print(f"  ✓ Fixed {num_fixed} batch norm layers (max var was {max_running_var_before:.1f}, capped at 10.0)")
        print(f"    This prevents denormal number performance issues.")
    else:
        print(f"  ✓ All batch norm statistics healthy (max var: {max_running_var_before:.1f})")
    
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
        from pathlib import Path
        
        # Load model (this might load external data if it was created)
        model_proto = onnx.load(output_path, load_external_data=True)
        
        # Save with all data embedded in the main file
        onnx.save(model_proto, output_path, save_as_external_data=False)
        
        # Remove any .onnx.data file that might have been created
        external_data_file = Path(str(output_path) + '.data')
        if external_data_file.exists():
            external_data_file.unlink()
            print("✓ Removed external data file")
        
        print("✓ Model saved with all data embedded (no external files)")
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
    
    parser = argparse.ArgumentParser(description='Export PyTorch SE model to ONNX for web deployment')
    parser.add_argument('checkpoint', help='Path to PyTorch checkpoint (.pt or .pth)')
    parser.add_argument('-o', '--output', help='Output ONNX file path (default: same as input with .onnx extension)', default=None)
    parser.add_argument('--opset', type=int, default=14, help='ONNX opset version (default: 14)')
    parser.add_argument('--test', action='store_true', help='Test the exported model with onnxruntime')
    parser.add_argument('--num-res-blocks', type=int, default=None, 
                        help='Number of residual blocks (auto-detected if not provided)')
    parser.add_argument('--num-channels', type=int, default=None,
                        help='Number of channels (auto-detected if not provided)')
    parser.add_argument('--value-head-hidden-size', type=int, default=None,
                        help='Value head hidden layer size (auto-detected if not provided)')
    
    args = parser.parse_args()
    
    # Determine output path
    if args.output is None:
        # Generate output path from input: checkpoint.pth -> checkpoint.onnx
        input_path = Path(args.checkpoint)
        args.output = str(input_path.with_suffix('.onnx'))
    
    # Create output directory if needed
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    
    # Export Standard FP32 model
    success = export_model_to_onnx(
        args.checkpoint, 
        args.output, 
        args.opset,
        num_res_blocks=args.num_res_blocks,
        num_channels=args.num_channels,
        value_head_hidden_size=args.value_head_hidden_size
    )
    
    if not success:
        print("\n✗ Export failed!")
        sys.exit(1)

    # --- NEW: Perform Quantization ---
    quantized_output = str(Path(args.output).with_suffix('.quant.onnx'))
    try:
        quantize_onnx_model(args.output, quantized_output)
        
        # Verify sizes
        fp32_size = os.path.getsize(args.output) / (1024 * 1024)
        int8_size = os.path.getsize(quantized_output) / (1024 * 1024)
        print(f"\nSize Comparison:")
        print(f"  FP32: {fp32_size:.2f} MB")
        print(f"  INT8: {int8_size:.2f} MB ({fp32_size/int8_size:.1f}x smaller)")
        
        # Optional: update args.output to point to quantized model for testing
        if args.test:
            print("\nTesting Quantized Model:")
            test_exported_model(quantized_output)

    except ImportError:
        print("\n⚠ onnxruntime-tools not found. Skipping quantization.")
        print("  Install with: pip install onnxruntime-tools")
    except Exception as e:
        print(f"\n✗ Quantization failed: {e}")
        import traceback
        traceback.print_exc()
