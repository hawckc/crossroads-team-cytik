"""One place for "now", so tests can move time. All timestamps are epoch milliseconds."""
import time

_now = time.time


def now_ms() -> int:
    return int(_now() * 1000)


def set_clock(fn=None) -> None:
    global _now
    _now = fn or time.time
