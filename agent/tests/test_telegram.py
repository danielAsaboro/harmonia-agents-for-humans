from harmonia_agent.telegram_bot import is_chat_allowed, parse_callback_data


def test_parse_callback_data_valid():
    assert parse_callback_data("decide:job123:act456:approved") == ("job123", "act456", "approved")
    assert parse_callback_data("decide:job123:act456:rejected") == ("job123", "act456", "rejected")


def test_parse_callback_data_invalid():
    assert parse_callback_data("decide:job123:act456:maybe") is None
    assert parse_callback_data("decide:nocolon") is None
    assert parse_callback_data("other:job:act:approved") is None
    assert parse_callback_data("decide::act:approved") is None
    assert parse_callback_data("decide:job::approved") is None
    # action ids may contain no colons; extra segments are rejected
    assert parse_callback_data("decide:job:act:id:approved") is None


def test_chat_allow_list():
    assert is_chat_allowed(12345, "12345") is True
    assert is_chat_allowed(" 12345 ", "12345") is True
    assert is_chat_allowed(99999, "12345") is False
    assert is_chat_allowed(None, "12345") is False
