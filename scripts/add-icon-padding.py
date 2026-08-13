#!/usr/bin/env python3
"""
Add safe-area padding to icon files for proper macOS Dock sizing.
Reduces icon content to 80% of canvas size with transparent padding.
"""
import os
from pathlib import Path
from PIL import Image

def add_padding(input_path: str, output_path: str, scale: float = 0.80):
    """Add transparent padding by scaling down the content."""
    img = Image.open(input_path)
    
    # Ensure RGBA mode for transparency
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # Calculate new size (80% of original)
    width, height = img.size
    new_width = int(width * scale)
    new_height = int(height * scale)
    
    # Scale down the content
    scaled = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Create new transparent canvas at original size
    padded = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    
    # Paste scaled image centered
    x_offset = (width - new_width) // 2
    y_offset = (height - new_height) // 2
    padded.paste(scaled, (x_offset, y_offset), scaled)
    
    # Save with transparency
    padded.save(output_path, 'PNG')
    print(f"✓ {output_path}")

def main():
    # Process all PNG files in icon.iconset
    iconset_dir = Path('build/icon.iconset')
    if iconset_dir.exists():
        for png_file in sorted(iconset_dir.glob('*.png')):
            add_padding(str(png_file), str(png_file))
    
    # Process the 1024px source
    if Path('build/icon-1024.png').exists():
        add_padding('build/icon-1024.png', 'build/icon-1024.png')
    
    # Rebuild .icns from iconset
    print("\nRebuilding icon.icns...")
    os.system('iconutil -c icns build/icon.iconset -o build/icon.icns')
    print("✓ build/icon.icns")
    
    print("\n✓ All icons updated with safe-area padding")

if __name__ == '__main__':
    main()
