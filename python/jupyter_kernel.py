"""Launch the checkout's Bo kernel independently of the working directory."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from python.bo.jupyter import main


if __name__ == "__main__":
    raise SystemExit(main())
