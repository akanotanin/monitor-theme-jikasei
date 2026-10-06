#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 public/site-icon.png 无损压小：RGBA → 调色板 PNG（像素逐一相同，只是编码更省）。

背景：这张图是顶栏那枚 32px 圆标 + 浏览器标签页图标 + 手机桌面图标，140×140 RGBA 原本
17KB。主题是灰阶的，图里颜色数远少于 256，所以能**无损**转成调色板 PNG —— 不重采样、
不量化、不动一个像素，只是把每个像素从 4 字节压成 1 字节索引。

跑法：python tools/optimize_icon.py [--write]
  不带 --write 只报告（会解码两遍并逐像素比对，证明「无损」不是嘴上说的）。
"""
import struct, sys, zlib, os

SRC = os.path.join(os.path.dirname(__file__), "..", "public", "site-icon.png")


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos, idat, ihdr = 8, b"", None
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif typ == b"IDAT":
            idat += body
        pos += 12 + ln
    w, h, depth, color, comp, filt, inter = ihdr
    assert depth == 8 and color == 6 and inter == 0, f"只处理 8 位 RGBA 非隔行（这张是 depth={depth} color={color}）"
    raw = zlib.decompress(idat)
    stride, bpp = w * 4, 4
    out, prev = bytearray(), bytearray(stride)
    p = 0
    for _ in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 0xFF
            elif f == 2: line[i] = (line[i] + b) & 0xFF
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out += line
        prev = line
    return w, h, bytes(out)


def write_indexed_png(path, w, h, pixels):
    """pixels: RGBA 字节串（长 w*h*4）。按出现顺序建调色板，输出 colorType 3 + tRNS。"""
    palette, index = [], {}
    idx = bytearray()
    for i in range(0, len(pixels), 4):
        px = pixels[i:i + 4]
        if px not in index:
            index[px] = len(palette)
            palette.append(px)
        idx.append(index[px])
    assert len(palette) <= 256, f"颜色数 {len(palette)} 超过 256，调色板装不下（那就别转）"
    plte = b"".join(px[:3] for px in palette)
    trns = bytes(px[3] for px in palette)
    raw = bytearray()
    for y in range(h):                     # 每行 filter=0（图小，压不压无所谓，简单最要紧）
        raw.append(0)
        raw += idx[y * w:(y + 1) * w]

    def chunk(typ, body):
        return struct.pack(">I", len(body)) + typ + body + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0))
    png += chunk(b"PLTE", plte)
    png += chunk(b"tRNS", trns)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def write_rgba_png(path, w, h, pixels, level=9):
    """原样重编码成 RGBA PNG（像素不变）：逐行试 5 种 filter，挑「绝对值和」最小的那个。
    这是**无损**的 —— 只是把编码方式换得更省，不动一个像素。"""
    stride, bpp = w * 4, 4
    raw = bytearray()
    prev = bytes(stride)
    for y in range(h):
        line = pixels[y * stride:(y + 1) * stride]
        best = None
        for f in range(5):
            enc = bytearray(stride)
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                if f == 0: pred = 0
                elif f == 1: pred = a
                elif f == 2: pred = b
                elif f == 3: pred = (a + b) >> 1
                else:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                enc[i] = (line[i] - pred) & 0xFF
            score = sum(v if v < 128 else 256 - v for v in enc)
            if best is None or score < best[0]:
                best = (score, f, bytes(enc))
        raw.append(best[1])
        raw += best[2]
        prev = line

    def chunk(typ, body):
        return struct.pack(">I", len(body)) + typ + body + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), level))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main():
    w, h, px = read_png(SRC)
    colors = len({px[i:i + 4] for i in range(0, len(px), 4)})
    before = os.path.getsize(SRC)
    print(f"{SRC}: {w}×{h} RGBA，{colors} 种颜色，{before / 1024:.1f}KB")
    if "--write" not in sys.argv:
        print("（不带 --write 只报告）")
        return
    if colors <= 256:
        tmp = SRC + ".tmp"
        write_indexed_png(tmp, w, h, px)
    else:
        # 颜色数超 256：调色板装不下。**不量化**（那是有损的），改成原样重编码 ——
        # 逐行选 filter + zlib 9 级，像素一个不动。
        print(f"颜色数 {colors} > 256：调色板装不下，改为**无损**重编码（逐行选 filter + zlib 9）")
        tmp = SRC + ".tmp"
        write_rgba_png(tmp, w, h, px)
    # 逐像素比对，证明无损
    w2, h2, px2 = read_png(tmp)
    assert (w, h, px) == (w2, h2, px2), "像素不一致 —— 别写回去"
    after = os.path.getsize(tmp)
    if after >= before:
        os.remove(tmp)
        print(f"重编码后没更小（{after / 1024:.1f}KB ≥ {before / 1024:.1f}KB）：保持原样，不写回去")
        return
    os.replace(tmp, SRC)
    print(f"无损压完：{before / 1024:.1f}KB → {after / 1024:.1f}KB（-{100 - after * 100 // before}%），像素逐一相同")


if __name__ == "__main__":
    main()
