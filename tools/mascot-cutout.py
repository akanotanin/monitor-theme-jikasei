# 把「白底角色图」抠成透明 PNG（主题预览图的素材）。
#
# 为什么要脚本而不是手工抠：原图是 JPEG、底色不是纯白（带一层很淡的蓝灰渐变），
# 手工魔术棒会在轮廓上留下白边；这里用「从四条边泛洪」把与画面外缘连通的底色整块拿掉，
# 角色内部的白（围裙、脸）因为有黑描边围着、不与外缘连通，所以不会被误伤。
#
# 用法：python tools/mascot-cutout.py <源图> [输出路径]
#   python tools/mascot-cutout.py IMG_1152.JPG preview-src/mascot.png
# 依赖：Pillow + numpy + scipy
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = sys.argv[1] if len(sys.argv) > 1 else 'IMG_1152.JPG'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'preview-src/mascot.png'
# 输出边长：预览图里角色最大放到 700 CSS px = 1400 设备像素，1600 留一点余量
SIDE = 1600

im = Image.open(SRC).convert("RGB")
a = np.asarray(im).astype(np.int16)
dark = a.min(axis=2)                      # 最暗通道：底色≈250，黑描边≈0
sat = a.max(axis=2) - a.min(axis=2)       # 饱和度：底色与淡蓝阴影都很低

# 可能是底色的像素（阈值放宽到 205 是给那层淡蓝灰渐变留位，连通性负责挡住角色内部）
cand = (dark >= 205) & (sat <= 30)
seed = np.zeros_like(cand)
seed[0, :] = cand[0, :]; seed[-1, :] = cand[-1, :]
seed[:, 0] = cand[:, 0]; seed[:, -1] = cand[:, -1]
bg = ndimage.binary_propagation(seed, mask=cand)
print(f"判定为底色的像素占比 {100 * bg.mean():.1f}%")

alpha = np.where(bg, 0, 255).astype(np.uint8)
# 只留最大的那块不透明连通域：清掉底色里的孤立杂点与悬浮碎块
lab, n = ndimage.label(alpha > 0)
sizes = ndimage.sum(np.ones_like(lab), lab, index=range(1, n + 1))
main = int(np.argmax(sizes)) + 1
print(f"不透明连通域 {n} 块，保留最大一块 {int(sizes[main - 1])} 像素"
      f"（其余合计 {int(sizes.sum() - sizes[main - 1])}，已丢弃）")
alpha = np.where(lab == main, 255, 0).astype(np.uint8)

# 羽化锯齿。白底上用，残留的浅色边与预览图的白底同色，看不见。
al = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.8))
al = al.point(lambda v: 0 if v < 40 else (255 if v > 215 else int((v - 40) * 255 / 175)))

out = Image.merge("RGBA", (im.getchannel("R"), im.getchannel("G"), im.getchannel("B"), al))
out = out.crop(out.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())
if out.width > SIDE or out.height > SIDE:
    scale = SIDE / max(out.width, out.height)
    out = out.resize((round(out.width * scale), round(out.height * scale)), Image.LANCZOS)
out.save(OUT, optimize=True)

# 自检：围裙（角色内部的白）必须还是不透明的，四角必须透明 —— 这两条一坏就是「抠穿了」
chk = np.asarray(out.getchannel("A"))
w, h = out.size
for tag, (x, y) in {
    "围裙中心": (round(w * 0.50), round(h * 0.96)),
    "脸部": (round(w * 0.53), round(h * 0.46)),
    "左上角": (3, 3), "右上角": (w - 4, 3),
    "左下角": (3, h - 4), "右下角": (w - 4, h - 4),
}.items():
    v = int(chk[y, x])
    print(f"   {tag:6} alpha={v}")
print(f"写出 {OUT} {out.size[0]}x{out.size[1]}")
