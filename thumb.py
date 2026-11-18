#!/usr/bin/env python3
"""
从 CBZ 里取出第一页，生成小缩略图。

用法：python3 thumb.py <input.cbz> <output.jpg>

为什么需要：OPDS 的章节条目如果只有标题，阅读器会显示灰色占位；
给每章一张缩略图，浏览章节列表时就能直接看到画面。
"""
import io
import sys
import zipfile

try:
    from PIL import Image
except ImportError:
    print('Pillow 未安装', file=sys.stderr)
    sys.exit(2)

MAX_W, MAX_H = 240, 340


def main():
    if len(sys.argv) < 3:
        print('用法: thumb.py <input.cbz> <output.jpg>', file=sys.stderr)
        return 1
    src, out = sys.argv[1], sys.argv[2]

    try:
        with zipfile.ZipFile(src) as z:
            names = sorted(
                n for n in z.namelist()
                if n.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif'))
            )
            if not names:
                print('没有图片', file=sys.stderr)
                return 1
            data = z.read(names[0])
    except Exception as e:
        print(f'读取失败: {e}', file=sys.stderr)
        return 1

    try:
        im = Image.open(io.BytesIO(data))
        if im.mode in ('RGBA', 'LA', 'P'):
            bg = Image.new('RGB', im.size, (255, 255, 255))
            bg.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[-1])
            im = bg
        else:
            im = im.convert('RGB')
        im.thumbnail((MAX_W, MAX_H))
        im.save(out, 'JPEG', quality=78, optimize=True)
    except Exception as e:
        print(f'处理失败: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
