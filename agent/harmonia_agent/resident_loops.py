"""Explicit opt-in for development-only resident background loops."""

from collections.abc import Mapping


def resident_loops_enabled(environment: Mapping[str, str]) -> bool:
    return environment.get("HARMONIA_ENABLE_RESIDENT_LOOPS") == "1"
