import os


def _env_flag(name, default):
    return os.environ.get(name, "1" if default else "0") == "1"


class Config:
    ENV = os.environ.get("COMMIT_ENV", "development")           # development | production | testing
    SECRET_KEY = os.environ.get("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", "sqlite:///commit.db")   # relative paths live in instance/
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    MAX_CONTENT_LENGTH = 3 * 1024 * 1024                          # proof photos arrive as a data URL, ~100-300 KB
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("COMMIT_ENV") == "production"
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 24 * 30

    DEMO_ENABLED = _env_flag("COMMIT_DEMO", os.environ.get("COMMIT_ENV") != "production")
    RATELIMIT_ENABLED = True

    # photo verification: "mock" passes every photo (offline dev, tests); "claude" calls the Anthropic API
    VERIFIER_PROVIDER = os.environ.get("VERIFIER_PROVIDER", "mock")
    VERIFIER_MODEL = os.environ.get("VERIFIER_MODEL", "claude-haiku-5-5")
    VERIFIER_TIMEOUT = float(os.environ.get("VERIFIER_TIMEOUT", "25"))
    MOCK_VERIFIER_RESULT = "verified"
    DUPLICATE_PHOTO_CHECK = _env_flag("DUPLICATE_PHOTO_CHECK", os.environ.get("VERIFIER_PROVIDER", "mock") != "mock")
    PROOF_DIR = os.environ.get("PROOF_DIR")                       # defaults to instance/proofs
