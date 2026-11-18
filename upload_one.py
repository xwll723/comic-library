import os, sys
try:
    from huggingface_hub import HfApi
    path, rel = sys.argv[1], sys.argv[2]
    token = os.environ.get('HF_TOKEN', '')
    if not token:
        print('ERR no HF_TOKEN', file=sys.stderr)
        sys.exit(3)
    api = HfApi(token=token)
    api.upload_file(path_or_fileobj=path, path_in_repo=rel,
                    repo_id=os.environ.get('HF_REPO', 'xwll/comic-library'),
                    repo_type='dataset', commit_message=f'add {rel}')
    print('OK', rel)
except Exception as e:
    print(f'ERR {type(e).__name__}: {e}', file=sys.stderr)
    sys.exit(1)
