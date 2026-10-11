"""Photo verification port. The rest of the app only calls get_verifier(app).verify(...).

Adapters: MockVerifier (offline dev and tests) and ClaudeVerifier. Provider errors, timeouts and bad output raise
VerifierUnavailable, which the API reports as a retryable 503 and never counts as a rejected photo.
"""
from dataclasses import dataclass, field


class VerifierUnavailable(Exception):
    pass


@dataclass
class Verdict:
    verdict: str                      # "verified" | "rejected"
    confidence: int                   # 0-100
    detected: list = field(default_factory=list)
    note: str = ""
    provider: str = ""
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0


def get_verifier(app):
    cached = app.extensions.get("commit_verifier")
    if cached is None:
        provider = app.config["VERIFIER_PROVIDER"]
        if provider == "claude":
            from .claude import ClaudeVerifier
            cached = ClaudeVerifier(app.config["VERIFIER_MODEL"], app.config["VERIFIER_TIMEOUT"])
        elif provider == "mock":
            from .mock import MockVerifier
            cached = MockVerifier(app.config["MOCK_VERIFIER_RESULT"])
        else:
            raise RuntimeError(f"unknown VERIFIER_PROVIDER {provider!r}")
        app.extensions["commit_verifier"] = cached
    return cached
