import pytest

from backend import create_app


@pytest.fixture
def demo_app(tmp_path, now):
    return create_app({
        "TESTING": True, "ENV": "testing", "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'demo.db'}",
        "PROOF_DIR": str(tmp_path / "proofs"), "RATELIMIT_ENABLED": False, "DEMO_ENABLED": True,
    })


def test_demo_account_matches_the_client_sample_data(demo_app):
    from .conftest import Api
    api = Api(demo_app.test_client())
    s = api.post("/auth/login", {"username": "demo", "password": "demo123"}).get_json()["state"]
    assert s["balance"] == 10000 and s["spendable"] == 4300 and s["totalSent"] == 1500 and s["tickets"] == 1
    assert len([t for t in s["tasks"] if t["status"] == "active"]) == 4
    assert any(t.get("proof", {}).get("image", "").startswith("img/proof/") for t in s["tasks"])


def test_only_the_demo_account_can_be_reset(demo_app):
    from .conftest import Api
    api = Api(demo_app.test_client())
    api.post("/auth/login", {"username": "demo", "password": "demo123"})
    assert api.post("/me/reset").status_code == 200
    api.post("/auth/logout")
    api.register()
    assert api.post("/me/reset").status_code == 403
