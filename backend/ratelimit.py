"""Tiny in-process sliding-window limiter. Per process only: put a shared limiter (Redis) in front for multi-worker setups."""
from . import clock
from .errors import ApiError

_hits = {}


def check(key, limit, window_ms):
    now = clock.now_ms()
    recent = [t for t in _hits.get(key, []) if now - t < window_ms]
    if len(recent) >= limit:
        _hits[key] = recent
        raise ApiError("RATE_LIMITED", "Too many requests. Try again later.", 429)
    recent.append(now)
    _hits[key] = recent


def reset():
    _hits.clear()
