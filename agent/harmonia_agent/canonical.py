import math
import struct
import hashlib
from typing import Any

def _canonical_typed_bytes(value: Any) -> str:
    """Typed canonical encoding with IEEE-754 numbers shared with TypeScript."""
    if value is None:
        return "n;"
    if isinstance(value, bool):
        return "b1;" if value else "b0;"
    if isinstance(value, (int, float)):
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError("typed digest requires finite numbers")
        if numeric == 0:
            numeric = 0.0
        return f"d{struct.pack('>d', numeric).hex()};"
    if isinstance(value, str):
        return f"s{len(value.encode('utf-8'))}:{value}"
    if isinstance(value, list):
        return f"a{len(value)}[{''.join(_canonical_typed_bytes(item) for item in value)}]"
    if isinstance(value, dict):
        entries = "".join(
            _canonical_typed_bytes(key) + _canonical_typed_bytes(value[key])
            for key in sorted(value)
        )
        return f"o{len(value)}{{{entries}}}"
    raise ValueError("typed digest contains an unsupported value")


def typed_digest(value: Any) -> str:
    return hashlib.sha256(_canonical_typed_bytes(value).encode("utf-8")).hexdigest()
