#!/usr/bin/env python3
"""
FFT-based texture pattern removal script.

This script removes visible repeating patterns from textures by analyzing
and filtering the frequency domain using Fast Fourier Transform (FFT).
"""

import argparse
import numpy as np
from PIL import Image
from scipy import ndimage
from pathlib import Path


def load_image(path: str) -> np.ndarray:
    """Load image and convert to numpy array."""
    img = Image.open(path)
    return np.array(img)


def save_image(arr: np.ndarray, path: str):
    """Save numpy array as image."""
    # Clip values to valid range and convert to uint8
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    img.save(path)
    print(f"Saved: {path}")


def fft_filter_channel_lines(channel: np.ndarray, line_width: int = 2, 
                            protect_center: int = 20, attenuation: float = 0.99) -> np.ndarray:
    """
    Remove horizontal and vertical repeating patterns by filtering lines in frequency domain.
    This targets the specific pattern visible in the FFT visualization.
    
    Args:
        channel: 2D numpy array (single color channel)
        line_width: Width of the filter around horizontal/vertical lines
        protect_center: Radius around DC component to protect
        attenuation: How much to reduce the filtered frequencies (0.99 = reduce by 99%)
    
    Returns:
        Filtered channel as 2D numpy array
    """
    h, w = channel.shape
    
    # Apply FFT
    f_transform = np.fft.fft2(channel)
    f_shift = np.fft.fftshift(f_transform)
    
    # Create a mask starting with all ones (pass everything)
    mask = np.ones((h, w), dtype=np.float64)
    
    # Find center of frequency domain
    center_y, center_x = h // 2, w // 2
    
    # Create coordinate grids
    y_coords, x_coords = np.ogrid[:h, :w]
    
    # Protect the center (DC component and very low frequencies)
    center_mask = ((y_coords - center_y) ** 2 + (x_coords - center_x) ** 2) <= protect_center ** 2
    
    # Filter horizontal line (through center, all x values)
    # This removes vertical repeating patterns in the image
    # Use a wider, more aggressive filter
    if line_width > 0:
        for dy in range(-line_width * 2, line_width * 2 + 1):
            y_idx = center_y + dy
            if 0 <= y_idx < h:
                # Distance from center line
                dist = abs(dy)
                if dist <= line_width:
                    # Strong reduction at center
                    reduction = attenuation
                else:
                    # Soft falloff beyond line_width
                    falloff = (line_width * 2 - dist) / line_width if dist < line_width * 2 else 0
                    reduction = attenuation * falloff
                mask[y_idx, :] *= (1.0 - reduction)
    
    # Filter vertical line (through center, all y values)
    # This removes horizontal repeating patterns in the image
    if line_width > 0:
        for dx in range(-line_width * 2, line_width * 2 + 1):
            x_idx = center_x + dx
            if 0 <= x_idx < w:
                dist = abs(dx)
                if dist <= line_width:
                    reduction = attenuation
                else:
                    falloff = (line_width * 2 - dist) / line_width if dist < line_width * 2 else 0
                    reduction = attenuation * falloff
                mask[:, x_idx] *= (1.0 - reduction)
    
    # Restore center protection
    mask[center_mask] = 1.0
    
    # Apply mask to frequency domain
    f_filtered = f_shift * mask
    
    # Inverse FFT
    f_ishift = np.fft.ifftshift(f_filtered)
    img_back = np.fft.ifft2(f_ishift)
    img_back = np.real(img_back)
    
    return img_back


def fft_filter_channel(channel: np.ndarray, threshold_percentile: float = 99.5, 
                       notch_radius: int = 3, protect_center: int = 10) -> np.ndarray:
    """
    Apply FFT-based filtering to remove periodic patterns from a single channel.
    
    Args:
        channel: 2D numpy array (single color channel)
        threshold_percentile: Percentile above which frequencies are considered peaks
        notch_radius: Radius of notch filter around detected peaks
        protect_center: Radius around DC component to protect (preserves overall brightness)
    
    Returns:
        Filtered channel as 2D numpy array
    """
    h, w = channel.shape
    
    # Apply FFT
    f_transform = np.fft.fft2(channel)
    f_shift = np.fft.fftshift(f_transform)
    
    # Get magnitude spectrum for analysis
    magnitude = np.abs(f_shift)
    
    # Create a mask starting with all ones (pass everything)
    mask = np.ones((h, w), dtype=np.float64)
    
    # Find center of frequency domain
    center_y, center_x = h // 2, w // 2
    
    # Calculate threshold for detecting periodic pattern peaks
    # Exclude the center (DC component) from threshold calculation
    magnitude_for_threshold = magnitude.copy()
    y_coords, x_coords = np.ogrid[:h, :w]
    center_mask = ((y_coords - center_y) ** 2 + (x_coords - center_x) ** 2) <= protect_center ** 2
    magnitude_for_threshold[center_mask] = 0
    
    threshold = np.percentile(magnitude_for_threshold, threshold_percentile)
    
    # Find peaks (potential periodic patterns)
    peaks = magnitude > threshold
    
    # Protect the center (DC component and very low frequencies)
    peaks[center_mask] = False
    
    # Create notch filter around each peak
    peak_coords = np.where(peaks)
    for py, px in zip(peak_coords[0], peak_coords[1]):
        # Create circular notch
        for dy in range(-notch_radius, notch_radius + 1):
            for dx in range(-notch_radius, notch_radius + 1):
                ny, nx = py + dy, px + dx
                if 0 <= ny < h and 0 <= nx < w:
                    dist = np.sqrt(dy**2 + dx**2)
                    if dist <= notch_radius:
                        # Soft falloff for smoother filtering
                        mask[ny, nx] *= (dist / notch_radius) ** 2 if dist > 0 else 0
    
    # Apply mask to frequency domain
    f_filtered = f_shift * mask
    
    # Inverse FFT
    f_ishift = np.fft.ifftshift(f_filtered)
    img_back = np.fft.ifft2(f_ishift)
    img_back = np.real(img_back)
    
    return img_back


def fft_remove_pattern(image: np.ndarray, threshold_percentile: float = 99.5,
                       notch_radius: int = 3, protect_center: int = 15,
                       method: str = "peaks", line_width: int = 2, 
                       attenuation: float = 0.99) -> np.ndarray:
    """
    Remove periodic patterns from an image using FFT filtering.
    
    Args:
        image: Input image as numpy array (H, W) or (H, W, C)
        threshold_percentile: Percentile for peak detection (for "peaks" method)
        notch_radius: Radius of notch filter (for "peaks" method)
        protect_center: Radius to protect around DC component
        method: "peaks" for peak-based filtering, "lines" for horizontal/vertical line filtering
        line_width: Width of filter around lines (for "lines" method)
        attenuation: Attenuation strength for lines method (0.99 = reduce by 99%)
    
    Returns:
        Filtered image as numpy array
    """
    if len(image.shape) == 2:
        # Grayscale
        if method == "lines":
            return fft_filter_channel_lines(image.astype(np.float64), 
                                           line_width=line_width, protect_center=protect_center,
                                           attenuation=attenuation)
        else:
            return fft_filter_channel(image.astype(np.float64), 
                                      threshold_percentile, notch_radius, protect_center)
    
    # Color image - process each channel
    result = np.zeros_like(image, dtype=np.float64)
    channels = image.shape[2]
    
    for c in range(channels):
        print(f"Processing channel {c + 1}/{channels}...")
        if method == "lines":
            result[:, :, c] = fft_filter_channel_lines(
                image[:, :, c].astype(np.float64),
                line_width=line_width,
                protect_center=protect_center,
                attenuation=attenuation
            )
        else:
            result[:, :, c] = fft_filter_channel(
                image[:, :, c].astype(np.float64),
                threshold_percentile,
                notch_radius,
                protect_center
            )
    
    return result


def visualize_fft(image: np.ndarray, output_path: str):
    """
    Save a visualization of the FFT magnitude spectrum.
    Useful for debugging and understanding the frequency content.
    """
    if len(image.shape) == 3:
        # Convert to grayscale for visualization
        gray = np.mean(image, axis=2)
    else:
        gray = image
    
    f_transform = np.fft.fft2(gray)
    f_shift = np.fft.fftshift(f_transform)
    magnitude = np.log1p(np.abs(f_shift))  # Log scale for better visualization
    
    # Normalize to 0-255
    magnitude = (magnitude - magnitude.min()) / (magnitude.max() - magnitude.min()) * 255
    
    save_image(magnitude, output_path)
    print(f"FFT visualization saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Remove repeating patterns from textures using FFT filtering"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Input texture file path"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output texture file path (default: input_fixed.png)"
    )
    parser.add_argument(
        "--threshold", "-t",
        type=float,
        default=99.5,
        help="Percentile threshold for peak detection (default: 99.5)"
    )
    parser.add_argument(
        "--notch-radius", "-n",
        type=int,
        default=5,
        help="Radius of notch filter around detected peaks (default: 5)"
    )
    parser.add_argument(
        "--protect-center", "-p",
        type=int,
        default=20,
        help="Radius around center to protect (default: 20)"
    )
    parser.add_argument(
        "--method", "-m",
        choices=["peaks", "lines"],
        default="peaks",
        help="Filtering method: 'peaks' for peak detection, 'lines' for horizontal/vertical line filtering (default: peaks)"
    )
    parser.add_argument(
        "--line-width", "-l",
        type=int,
        default=2,
        help="Width of filter around horizontal/vertical lines (for 'lines' method, default: 2)"
    )
    parser.add_argument(
        "--attenuation", "-a",
        type=float,
        default=0.99,
        help="Attenuation strength for lines method (0.0-1.0, default: 0.99 = reduce by 99%%)"
    )
    parser.add_argument(
        "--visualize-fft",
        action="store_true",
        help="Save FFT magnitude visualization (before and after)"
    )
    
    args = parser.parse_args()
    
    # Determine output path
    input_path = Path(args.input)
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.parent / f"{input_path.stem}_fixed{input_path.suffix}"
    
    print(f"Loading: {input_path}")
    image = load_image(str(input_path))
    print(f"Image shape: {image.shape}")
    
    # Optionally visualize FFT before filtering
    if args.visualize_fft:
        fft_vis_path = input_path.parent / f"{input_path.stem}_fft_before.png"
        visualize_fft(image, str(fft_vis_path))
    
    # Apply FFT filtering
    print("Applying FFT-based pattern removal...")
    print(f"  Method: {args.method}")
    if args.method == "peaks":
        print(f"  Threshold percentile: {args.threshold}")
        print(f"  Notch radius: {args.notch_radius}")
    else:
        print(f"  Line width: {args.line_width}")
    print(f"  Protected center radius: {args.protect_center}")
    
    filtered = fft_remove_pattern(
        image,
        threshold_percentile=args.threshold,
        notch_radius=args.notch_radius,
        protect_center=args.protect_center,
        method=args.method,
        line_width=args.line_width,
        attenuation=args.attenuation
    )
    
    # Optionally visualize FFT after filtering
    if args.visualize_fft:
        fft_vis_path = input_path.parent / f"{input_path.stem}_fft_after.png"
        visualize_fft(filtered.astype(np.uint8), str(fft_vis_path))
    
    # Save result
    save_image(filtered, str(output_path))
    print("Done!")


if __name__ == "__main__":
    main()
