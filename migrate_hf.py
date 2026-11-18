#!/usr/bin/env python3
"""把 Hugging Face 上旧的中文路径文件迁到 ASCII 路径（幂等，可重复跑）"""
import hashlib, os, sys, tempfile
from huggingface_hub import HfApi

REPO = os.environ.get('HF_REPO', 'xwll/comic-library')
TOKEN = os.environ.get('HF_TOKEN', '')
ROOT = os.path.dirname(os.path.abspath(__file__))

def slug(key):
    return 'b' + hashlib.md5(key.encode('utf-8')).hexdigest()[:10]

def load_map():
    """中文目录名 -> slug"""
    import json, glob
    m = {}
    for f in glob.glob(os.path.join(ROOT, 'state', '*.json')):
        if os.path.basename(f).startswith('_data_'):
            continue
        key = os.path.basename(f)[:-5]
        m[key] = slug(key)
    return m

def main():
    api = HfApi(token=TOKEN)
    smap = load_map()
    files = [f.path for f in api.list_repo_tree(REPO, repo_type='dataset', recursive=True) if hasattr(f, 'size')]
    todo = []
    for p in files:
        if not p.startswith('library/'):
            continue
        parts = p.split('/')
        if len(parts) < 3:
            continue
        folder = parts[1]
        if folder in smap.values():
            continue  # 已经是 slug 路径
        new = smap.get(folder)
        if not new:
            continue
        todo.append((p, f'library/{new}/' + '/'.join(parts[2:])))
    print(f'需要迁移 {len(todo)} 个文件')
    ok = fail = 0
    for old, new in todo:
        try:
            from huggingface_hub import hf_hub_download
            local = hf_hub_download(repo_id=REPO, filename=old, repo_type='dataset', token=TOKEN)
            api.upload_file(path_or_fileobj=local, path_in_repo=new, repo_id=REPO,
                            repo_type='dataset', commit_message=f'move {old}')
            ok += 1
            if ok % 10 == 0:
                print(f'  已迁移 {ok}')
        except Exception as e:
            fail += 1
            print(f'  ✗ {old}: {str(e)[:60]}')
    print(f'完成：迁移 {ok}，失败 {fail}')
    print('（旧文件保留，确认新路径可用后可手动删除）')

if __name__ == '__main__':
    main()
