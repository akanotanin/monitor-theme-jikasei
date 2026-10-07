#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从主题自带的站标源图（`preview-src/site-icon.png`，不进包）生成 hub 1.4.0 要的三份兜底文件：

    public/favicon.svg        标签页/书签图标 —— 一张内嵌 base64 PNG 的 SVG（16×16 与 32×32
                              都是位图缩下去的，矢量描一遍反而更糊）。hub 的「站点图标」没设
                              时，`/favicon.svg` 由主题目录回答，用的就是这张。
    public/favicon.ico        老浏览器、书签管理器、RSS 阅读器会**不看 <link> 直接来要**这条；
                              多尺寸 ICO，免得它们拿到的是回落页（HTML）。
    public/apple-touch-icon.png  iOS 主屏幕图标 —— 180×180、**不透明**（iOS 会把透明的填黑，
                              所以照 hub 面板的做法铺一层白底）。

为什么是这三个名字：hub 1.4.0 的 `ICON_PATHS` 只认 `/favicon.svg`、`/favicon.ico`、
`/apple-touch-icon.png`（外加 precomposed 与 `/admin/` 那几份）——站长在面板上传站点图标后
这几条路径全部改由 hub 回答（带版本号），没设时回落到主题目录里的同名文件。所以主题只要把
这三份放好，就同时管住了「没设图标」与「设了图标」两种状态。

跑法：uv run --with pillow python tools/make_icons.py [--check]
    --check 只比对（不写盘），用来验证仓库里的三份产物确实由这张源图生成。

源图放在 preview-src/ 而不是 public/：public/ 里的东西会被原样打进主题包，而这三份产物已经
把源图的内容带上去了，再带一份 140×140 的原图只是白占体积。
"""
import base64
import io
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SRC = os.path.join(ROOT, "preview-src", "site-icon.png")
SVG = os.path.join(ROOT, "public", "favicon.svg")
TOUCH = os.path.join(ROOT, "public", "apple-touch-icon.png")
ICO = os.path.join(ROOT, "public", "favicon.ico")

# 内嵌位图的边长：顶栏那枚圆标是 32px（视网膜屏 2×/3× → 64/96 设备像素），
# 标签页图标浏览器按 16~32px 画。96 够清楚，PNG 也只有几 KB。
FAVICON_PX = 96
TOUCH_PX = 180


def _palette(img: Image.Image) -> Image.Image:
    """量化成 256 色调色板：源图 1300 色（描边的抗锯齿），缩到这两个尺寸看不出差别，
    体积只有 RGBA 的三分之一。不平滑（dither=NONE）—— 平涂的卡通画抖动反而出噪点。"""
    return img.convert("P", palette=Image.ADAPTIVE, colors=256, dither=Image.NONE)


def favicon_svg(src: Image.Image) -> str:
    small = _palette(src.convert("RGBA").resize((FAVICON_PX, FAVICON_PX), Image.LANCZOS))
    buf = io.BytesIO()
    small.save(buf, "PNG", optimize=True)
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d">\n'
        '  <!-- 主题自带的站点图标：内嵌一张 %d×%d 的 PNG（源图 preview-src/site-icon.png，\n'
        '       由 tools/make_icons.py 生成）。站长在面板「设置 → 站点图标」里选了图之后，\n'
        '       /favicon.svg 由 hub 回答，这张就不再用到；清掉设置即回到这张。 -->\n'
        '  <image width="%d" height="%d" href="data:image/png;base64,%s"/>\n'
        '</svg>\n'
    ) % (FAVICON_PX, FAVICON_PX, FAVICON_PX, FAVICON_PX, FAVICON_PX, FAVICON_PX, data)


def touch_png(src: Image.Image) -> bytes:
    # iOS 会把透明区域填黑，所以铺白底（与 hub 面板生成 touch_icon 的做法一致）。
    canvas = Image.new("RGBA", (TOUCH_PX, TOUCH_PX), (255, 255, 255, 255))
    art = src.convert("RGBA")
    scale = min(TOUCH_PX / art.width, TOUCH_PX / art.height)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    canvas.alpha_composite(art, ((TOUCH_PX - art.width) // 2, (TOUCH_PX - art.height) // 2))
    out = io.BytesIO()
    _palette(canvas.convert("RGB")).save(out, "PNG", optimize=True)
    return out.getvalue()


def ico_bytes(src: Image.Image) -> bytes:
    """多尺寸 ICO：16/32/48 三档（浏览器标签页、任务栏、书签管理器各取所需）。
    不带 64/128：那两档只是把体积翻倍（37KB），而这几个地方最大也就画到 48。"""
    art = src.convert("RGBA")
    out = io.BytesIO()
    art.save(out, "ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    return out.getvalue()


def main() -> int:
    check = "--check" in sys.argv
    src = Image.open(SRC)
    svg = favicon_svg(src)
    touch = touch_png(src)
    ico = ico_bytes(src)
    if check:
        ok = True
        have = open(SVG, "rb").read().decode("utf-8") if os.path.exists(SVG) else ""
        if have != svg:
            print("★ public/favicon.svg 与源图不一致（跑一次不带 --check 的）")
            ok = False
        have = open(TOUCH, "rb").read() if os.path.exists(TOUCH) else b""
        if have != touch:
            print("★ public/apple-touch-icon.png 与源图不一致")
            ok = False
        have = open(ICO, "rb").read() if os.path.exists(ICO) else b""
        if have != ico:
            print("★ public/favicon.ico 与源图不一致")
            ok = False
        print("图标产物与源图一致" if ok else "图标产物需要重新生成")
        return 0 if ok else 1
    open(SVG, "w", encoding="utf-8", newline="\n").write(svg)
    open(TOUCH, "wb").write(touch)
    open(ICO, "wb").write(ico)
    print(f"public/favicon.svg        {len(svg)} B（内嵌 {FAVICON_PX}×{FAVICON_PX} PNG）")
    print(f"public/favicon.ico        {len(ico)} B（16/32/48 多尺寸）")
    print(f"public/apple-touch-icon.png {len(touch)} B（{TOUCH_PX}×{TOUCH_PX}，白底不透明）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
