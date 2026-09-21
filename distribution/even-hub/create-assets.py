#!/usr/bin/env python3
"""Draw original monochrome listing assets, without external image dependencies."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent
# Each design cell becomes a 2x2 block in the required 24x24 store icon.
MARK = (
    '000000000000',
    '000000000000',
    '000000000000',
    '011110011110',
    '110010010011',
    '010011110010',
    '010010010010',
    '001100001100',
    '000000000000',
    '000000000000',
    '000000000000',
    '000000000000',
)


def png(path, pixels):
    height, width = len(pixels), len(pixels[0])
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    raw = b''.join(b'\0' + bytes(row) for row in pixels)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)) +
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def mark_on(canvas, x, y, scale, value=255):
    for row, cells in enumerate(MARK):
        for col, cell in enumerate(cells):
            if cell == '1':
                for dy in range(scale):
                    for dx in range(scale):
                        canvas[y + row * scale + dy][x + col * scale + dx] = value


def main():
    assets = ROOT.parents[1] / '.build/even-hub-assets'
    assets.mkdir(parents=True, exist_ok=True)
    icon = [[0] * 24 for _ in range(24)]
    mark_on(icon, 0, 0, 2)
    png(assets / 'icon-24.png', icon)
    # This neutral background is a proposal; verify the portal's crop/dimensions.
    background = [[0] * 576 for _ in range(288)]
    mark_on(background, 144, 0, 24, 96)
    png(assets / 'background-draft.png', background)
    assert all(icon[y][x] == icon[y + dy][x + dx]
               for y in range(0, 24, 2) for x in range(0, 24, 2)
               for dy in (0, 1) for dx in (0, 1))
    print('Created original 24x24 binary icon and grayscale draft background.')


if __name__ == '__main__':
    main()
