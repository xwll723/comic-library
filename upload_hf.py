#!/usr/bin/env python3
"""
把 library/ 下的 CBZ 和封面传到 Hugging Face，GitHub 仓库只留代码和 XML。

用法：
    python3 upload_hf.py              # 上传所有还没传的文件
    python3 upload_hf.py --dry        # 只看会传什么

环境变量：
    HF_TOKEN        必填
    HF_REPO         xwll/comic-library（默认）
"""
import argparse
import os
import sys

try:
    from huggingface_hub import HfApi
except ImportError:
    print('缺少 huggingface_hub，先跑 pip install huggingface_hub', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(ROOT, 'library')
REPO = os.environ.get('HF_REPO', 'xwll/comic-library')
TOKEN = os.environ.get('HF_TOKEN', '')

# 只传这些类型（thumbs 之类的辅助文件也一起传，反正很小）
EXTS = ('.cbz', '.jpg', '.jpeg', '.png', '.webp', '.gif')


def local_files():
    out = []
    if not os.path.isdir(LIB):
        return out
    for dirpath, _, names in os.walk(LIB):
        for n in names:
            if n.lower().endswith(EXTS):
                full = os.path.join(dirpath, n)
                rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                out.append((full, rel, os.path.getsize(full)))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    if not TOKEN:
        print('没有 HF_TOKEN 环境变量', file=sys.stderr)
        return 1

    api = HfApi(token=TOKEN)
    files = local_files()
    if not files:
        print('library/ 里没有可上传的文件')
        return 0

    # 远程已有的文件（同名同大小就跳过）
    print(f'读取远程文件列表（{REPO}）...')
    remote = {}
    try:
        for f in api.list_repo_tree(REPO, repo_type='dataset', recursive=True):
            if hasattr(f, 'size'):
                remote[f.path] = f.size
    except Exception as e:
        print(f'  读取失败（首次上传正常）: {e}')

    todo = [x for x in files if remote.get(x[1]) != x[2]]
    total_mb = sum(x[2] for x in todo) / 1048576
    print(f'本地 {len(files)} 个文件，需要上传 {len(todo)} 个（{total_mb:.1f}MB）')

    if args.dry:
        for _, rel, size in todo[:20]:
            print(f'  {rel}  {size/1024:.0f}KB')
        if len(todo) > 20:
            print(f'  ... 还有 {len(todo)-20} 个')
        return 0

    ok = 0
    fail = 0
    for full, rel, size in todo:
        try:
            api.upload_file(
                path_or_fileobj=full,
                path_in_repo=rel,
                repo_id=REPO,
                repo_type='dataset',
                commit_message=f'add {rel}',
            )
            ok += 1
            print(f'  ✓ {rel}  {size/1024:.0f}KB')
        except Exception as e:
            fail += 1
            print(f'  ✗ {rel}  {e}')

    print(f'\n完成：成功 {ok}，失败 {fail}')
    print(f'仓库地址：https://huggingface.co/datasets/{REPO}')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
