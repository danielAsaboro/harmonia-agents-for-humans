"""One fail-closed gate for operations that can incur AWS charges."""
import os

def require_paid_aws(operation: str) -> None:
    if os.environ.get("HARMONIA_ALLOW_PAID_AWS", "false").lower() != "true":
        raise PermissionError(f"{operation} requires HARMONIA_ALLOW_PAID_AWS=true")
