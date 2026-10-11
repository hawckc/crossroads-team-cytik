import os
import posixpath

from flask import Flask, abort, send_from_directory

# Serves the client from the repo root, but only the files the client needs: the repo also holds source, notes and
# (with the optional backend) a database and uploaded photos, none of which should be downloadable.
ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES = {"index.html", "phone.html", "presentation/index.html"}
ASSET_DIRS = {"css", "js", "img"}
ASSET_PREFIXES = ("docs/screenshots/",)             # the pitch deck uses these; the rest of docs/ stays private

app = Flask(__name__, static_folder=None)


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/presentation")
@app.route("/presentation/")
def presentation():
    return send_from_directory(ROOT, "presentation/index.html")


@app.route("/<path:path>")
def public(path):
    if posixpath.normpath(path) != path or "\\" in path:     # no `..`, `.`, doubled or backslash segments: `css/../instance/x` must not pass
        abort(404)
    if path in PAGES or ("/" in path and path.split("/", 1)[0] in ASSET_DIRS) or path.startswith(ASSET_PREFIXES):
        return send_from_directory(ROOT, path)       # refuses paths that climb out of ROOT
    abort(404)


# The API is opt-in. Without COMMIT_BACKEND=1 this is still a static server and the client runs on localStorage.
if os.environ.get("COMMIT_BACKEND") == "1":
    from backend import init_app
    init_app(app)


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5002")), debug=os.environ.get("FLASK_DEBUG") == "1")
