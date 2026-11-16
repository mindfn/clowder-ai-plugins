import json
import os
from pathlib import Path
import signal
import sys

config_path, run_path, seed = sys.argv[1:]
config = json.loads(Path(config_path).read_text())
run = Path(run_path)
attempt_path = run / 'python-attempt'
attempt = int(attempt_path.read_text()) + 1 if attempt_path.exists() else 1
attempt_path.write_text(str(attempt))
if config.get('kill'):
    os.kill(os.getpid(), signal.SIGKILL)
if config.get('exit'):
    sys.exit(9)
score = float('nan') if config.get('nan') else int(seed) + config.get('delta', 0)
if config.get('only_selection') and int(seed) > 23:
    score = int(seed) - 2
output = {'metrics': {'score': score, 'cost': config.get('cost', 1), 'quality': config.get('quality', 1)},
          'failed': config.get('failed', False), 'dataVersion': 'sample-data-v1'}
(run / 'metrics.json').write_text(json.dumps(output))
(run / 'cwd').write_text(os.getcwd())
