import os, sys
from huggingface_hub import HfApi
path, rel = sys.argv[1], sys.argv[2]
api = HfApi(token=os.environ['HF_TOKEN'])
api.upload_file(path_or_fileobj=path, path_in_repo=rel,
                repo_id=os.environ.get('HF_REPO','xwll/comic-library'),
                repo_type='dataset', commit_message=f'add {rel}')
print('OK', rel)
