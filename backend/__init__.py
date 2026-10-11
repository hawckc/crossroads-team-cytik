"""Optional Flask backend for the Commit client. Off by default: app.py only mounts it when COMMIT_BACKEND=1.

    COMMIT_BACKEND=1 python app.py            # API + static client
    python -m backend.worker                  # settles missed deadlines even when nobody is online
"""
from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from .models import db


def init_app(app, overrides=None):
    """Adds the database, the /api/v1 routes and JSON error pages for /api/ to an existing Flask app."""
    app.config.from_object("backend.config.Config")
    if overrides:
        app.config.update(overrides)
    if not app.config.get("SECRET_KEY"):
        if app.config["ENV"] == "production":
            raise RuntimeError("SECRET_KEY must be set in production")
        app.config["SECRET_KEY"] = "dev-only-not-secret"

    db.init_app(app)
    from .api import bp
    app.register_blueprint(bp)

    @app.errorhandler(HTTPException)
    def _http_error(e):
        if not request.path.startswith("/api/"):
            return e
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "PAYLOAD_TOO_LARGE"}.get(e.code, "HTTP_ERROR")
        return jsonify(error={"code": code, "message": e.description, "details": None}), e.code

    @app.errorhandler(Exception)
    def _unexpected(e):
        if not request.path.startswith("/api/") or app.debug:
            raise e
        db.session.rollback()
        app.logger.exception("unhandled error")
        return jsonify(error={"code": "INTERNAL", "message": "Something went wrong", "details": None}), 500

    from . import seed
    with app.app_context():
        db.create_all()
        seed.seed_charities()
        if app.config["DEMO_ENABLED"]:
            seed.ensure_demo()
    return app


def create_app(overrides=None):
    """A standalone API app (used by tests and the worker)."""
    return init_app(Flask(__name__, instance_relative_config=True), overrides)
