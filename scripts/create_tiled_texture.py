#!/usr/bin/env python3
"""
Create a tiled version of a texture with mirroring to visualize seamless tiling.
"""

import argparse
import numpy as np
from PIL import Image
from pathlib import Path


def load_image(path: str) -> np.ndarray:
    """Load image and convert to numpy array."""
    img = Image.open(path)
    return np.array(img)


def save_image(arr: np.ndarray, path: str):
    """Save numpy array as image."""
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    img.save(path)
    print(f"Saved: {path}")


def create_tiled_texture(image: np.ndarray, tiles_x: int = 4, tiles_y: int = 4, 
                         mirror: bool = True) -> np.ndarray:
    """
    Create a tiled version of the texture.
    
    Args:
        image: Input image as numpy array
        tiles_x: Number of tiles horizontally
        tiles_y: Number of tiles vertically
        mirror: If True, alternate tiles are mirrored to break up repetition
    
    Returns:
        Tiled image as numpy array
    """
    h, w = image.shape[:2]
    channels = image.shape[2] if len(image.shape) == 3 else 1
    
    if channels == 1:
        image = image[:, :, np.newaxis]
    
    result_h = h * tiles_y
    result_w = w * tiles_x
    result = np.zeros((result_h, result_w, channels), dtype=image.dtype)
    
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            y_start = ty * h
            y_end = y_start + h
            x_start = tx * w
            x_end = x_start + w
            
            # Determine if this tile should be mirrored
            if mirror:
                # Checkerboard pattern: mirror if sum of coordinates is odd
                mirror_h = (tx % 2 == 1)
                mirror_v = (ty % 2 == 1)
            else:
                mirror_h = False
                mirror_v = False
            
            tile = image.copy()
            
            # Apply mirroring
            if mirror_v:
                tile = np.flipud(tile)  # Mirror vertically
            if mirror_h:
                tile = np.fliplr(tile)  # Mirror horizontally
            
            result[y_start:y_end, x_start:x_end, :] = tile
    
    if channels == 1:
        result = result[:, :, 0]
    
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Create a tiled version of a texture with optional mirroring"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Input texture file path"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output texture file path (default: input_repeated.png)"
    )
    parser.add_argument(
        "--tiles-x", "-x",
        type=int,
        default=4,
        help="Number of tiles horizontally (default: 4)"
    )
    parser.add_argument(
        "--tiles-y", "-y",
        type=int,
        default=4,
        help="Number of tiles vertically (default: 4)"
    )
    parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="Disable mirroring (just repeat the same tile)"
    )
    
    args = parser.parse_args()
    
    # Determine output path
    input_path = Path(args.input)
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.parent / f"{input_path.stem}_repeated{input_path.suffix}"
    
    print(f"Loading: {input_path}")
    image = load_image(str(input_path))
    print(f"Image shape: {image.shape}")
    
    print(f"Creating {args.tiles_x}x{args.tiles_y} tiled version...")
    print(f"Mirroring: {not args.no_mirror}")
    
    tiled = create_tiled_texture(
        image,
        tiles_x=args.tiles_x,
        tiles_y=args.tiles_y,
        mirror=not args.no_mirror
    )
    
    print(f"Result shape: {tiled.shape}")
    save_image(tiled, str(output_path))
    print("Done!")


if __name__ == "__main__":
    main()
