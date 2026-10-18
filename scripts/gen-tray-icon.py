#!/usr/bin/env python3
"""生成菜单栏托盘模板图（黑色+透明，macOS 自动适配深浅色）：MT 立方体标志（取自 build/icon-source.png）。
输出 base64 到 stdout，粘贴进 src/main/tray-icon.ts。"""
from PIL import Image
import base64, io, os

W = 32  # @2x：16pt
LOGO_W = 30  # 标志宽度（标志横向略宽，按宽度适配）

src = Image.open(os.path.join(os.path.dirname(__file__), "..", "build", "icon-source.png")).convert("L")
alpha = src.point(lambda v: 255 - v)  # 白底黑字 → 黑处不透明
alpha = alpha.crop(alpha.point(lambda a: 255 if a > 128 else 0).getbbox())
size = (LOGO_W, round(alpha.size[1] * LOGO_W / alpha.size[0]))
alpha = alpha.resize(size, Image.LANCZOS)
logo = Image.new("RGBA", size, (0, 0, 0, 0))
logo.putalpha(alpha)
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.alpha_composite(logo, ((W - size[0]) // 2, (W - size[1]) // 2))
buf = io.BytesIO()
img.save(buf, "PNG", optimize=True)
print(base64.b64encode(buf.getvalue()).decode())
