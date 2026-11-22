"""Bake the lab's close-up grain from the game's surface photo."""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
photo = Image.open(ROOT / 'public/textures/surface-high-detail.png').convert('RGB')
photo = photo.resize((768, 512), getattr(Image, 'Resampling', Image).LANCZOS)
srgb = np.asarray(photo, dtype=np.float32) / 255
linear = np.where(srgb < 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
luminance = linear @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
# Remove photographic lighting and broad patches before random patch blending.
local_mean = gaussian_filter(luminance, sigma=10, mode='reflect')
detail = np.clip(luminance / np.maximum(local_mean, 0.004) - 1, -0.55, 0.55)
detail -= detail.mean()
encoded = np.uint8(np.clip(np.rint(128 + 220 * detail), 0, 255))
Image.fromarray(encoded).save(ROOT / 'src/surface-lab/grain.png', optimize=True)
