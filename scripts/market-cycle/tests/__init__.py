# Tests never read or clear the mini's real outage state (collect-macro --write
# keeps it in ~/Library/Application Support/lrg-market-cycle).
import os as _os
import tempfile as _tempfile

_os.environ["MC_STATE_DIR"] = _tempfile.mkdtemp(prefix="mc-test-state-")
