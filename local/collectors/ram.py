"""RAM stats via psutil.

"Used" is reported as total minus available, which matches what a
human means by used: memory that is not reclaimable for new work.
psutil's raw `used` field excludes cache and reads misleadingly low.
"""

import psutil

_GB = 1024**3


def collect() -> dict:
    """One RAM sample in GB and percent."""
    vm = psutil.virtual_memory()
    return {
        "used_gb": round((vm.total - vm.available) / _GB, 1),
        "total_gb": round(vm.total / _GB, 1),
        "pct": vm.percent,
    }
