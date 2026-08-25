from harmonia_agent.resident_loops import resident_loops_enabled


def test_resident_loops_are_disabled_without_explicit_local_opt_in():
    assert resident_loops_enabled({}) is False
    assert resident_loops_enabled({"HARMONIA_ENABLE_RESIDENT_LOOPS": "0"}) is False
    assert resident_loops_enabled({"HARMONIA_ENABLE_RESIDENT_LOOPS": "1"}) is True
