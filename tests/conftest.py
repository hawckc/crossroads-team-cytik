"""Backend tests. They use a throwaway SQLite file, the mock verifier and a movable clock; they never touch instance/."""
import base64
import io
import random

import pytest
from PIL import Image

from backend import clock, create_app, ratelimit

T0 = 1_800_000_000          # seconds; a fixed "now"
MIN = 60


@pytest.fixture
def now():
    """Mutable clock: `now.t` is seconds. Move time with `now.t += 600`."""
    box = type("Clock", (), {"t": float(T0)})()
    clock.set_clock(lambda: box.t)
    yield box
    clock.set_clock(None)


@pytest.fixture
def app(tmp_path, now):
    ratelimit.reset()
    return create_app({
        "TESTING": True, "ENV": "testing", "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'test.db'}",
        "PROOF_DIR": str(tmp_path / "proofs"), "RATELIMIT_ENABLED": False, "DEMO_ENABLED": False,
        "DUPLICATE_PHOTO_CHECK": True,
    })


class Api:
    def __init__(self, client):
        self.c = client

    def call(self, method, path, body=None, headers=None):
        kwargs = {} if method == "get" else {"json": body if body is not None else {}}
        return getattr(self.c, method)("/api/v1" + path, headers=headers, **kwargs)

    def get(self, path, **kw): return self.call("get", path, **kw)
    def post(self, path, body=None, **kw): return self.call("post", path, body, **kw)
    def put(self, path, body=None, **kw): return self.call("put", path, body, **kw)
    def patch(self, path, body=None, **kw): return self.call("patch", path, body, **kw)

    def register(self, username="alice", password="secret1", name="Alice"):
        return self.post("/auth/register", {"name": name, "username": username, "password": password, "timezone": "UTC"})

    def new_task(self, now, minutes=60, stake_cents=1000, name="Gym visit", **extra):
        deadline = int((now.t + minutes * MIN) * 1000)
        return self.post("/tasks", {"name": name, "icon": "🏋️", "stakeCents": stake_cents, "deadline": deadline, **extra})

    def state(self):
        return self.get("/state").get_json()["state"]


@pytest.fixture
def api(app):
    return Api(app.test_client())


@pytest.fixture
def alice(api):
    assert api.register().status_code == 201
    return api


def photo(seed=1):
    """A noise image as a data URL. Different seeds look nothing alike; the same seed is a duplicate."""
    rnd = random.Random(seed)
    img = Image.new("RGB", (64, 64))
    img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(64 * 64)])
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
