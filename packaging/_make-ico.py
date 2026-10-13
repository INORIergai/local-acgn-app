"""
_make-ico.py —— 把 _make-icon.js 生成的多尺寸 PNG 合成 icon.ico

ICO 支持「PNG 压缩条目」（Windows Vista 起原生支持），所以这里直接把 PNG
字节塞进 ICO 容器，不需要任何图像库（Pillow 都不用）。

用法：python packaging/_make-ico.py
产物：packaging/build/icon.ico
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, 'build')
OUT = os.path.join(BUILD, 'icon.ico')

# 顺序从大到小，Windows 会按需挑尺寸
SIZES = [256, 128, 64, 48, 32, 24, 16]


def load(size):
    name = 'icon.png' if size == 512 else f'icon-{size}.png'
    path = os.path.join(BUILD, name)
    if not os.path.isfile(path):
        return None
    with open(path, 'rb') as f:
        return f.read()


def main():
    entries = []
    for size in SIZES:
        data = load(size)
        if data is None:
            print(f'  ⚠️ 缺少 icon-{size}.png，跳过')
            continue
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise SystemExit(f'icon-{size}.png 不是 PNG')
        entries.append((size, data))

    if not entries:
        raise SystemExit('没有任何 PNG，先跑 node packaging/_make-icon.js')

    header = struct.pack('<HHH', 0, 1, len(entries))          # reserved, type=icon, count
    offset = 6 + 16 * len(entries)
    dirs = b''
    blobs = b''
    for size, data in entries:
        b = 0 if size >= 256 else size                        # 256 在 ICO 里写 0
        dirs += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)

    with open(OUT, 'wb') as f:
        f.write(header + dirs + blobs)
    print(f'✅ 生成 {OUT}（{len(entries)} 个尺寸：{", ".join(str(s) for s, _ in entries)}，'
          f'共 {os.path.getsize(OUT) / 1024:.1f}KB）')


if __name__ == '__main__':
    main()
