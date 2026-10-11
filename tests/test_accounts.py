def test_register_then_state(api):
    r = api.register()
    assert r.status_code == 201
    s = r.get_json()["state"]
    assert (s["balance"], s["spendable"], s["tickets"]) == (10000, 10000, 1)
    assert s["user"] == {"username": "alice", "name": "Alice"}
    assert len(s["charities"]) == 6 and s["onboarded"] is False


def test_register_rules_match_the_client(api):
    r = api.post("/auth/register", {"name": "", "username": "A!", "password": "abc"})
    assert r.status_code == 422
    assert set(r.get_json()["error"]["details"]) == {"name", "username", "password"}
    assert api.register().status_code == 201
    assert api.register().get_json()["error"]["code"] == "USERNAME_TAKEN"


def test_login_logout_and_session(api):
    api.register()
    api.post("/auth/logout")
    assert api.get("/state").status_code == 401
    assert api.post("/auth/login", {"username": "nobody", "password": "x"}).get_json()["error"]["code"] == "NO_SUCH_USER"
    assert api.post("/auth/login", {"username": "alice", "password": "wrong"}).get_json()["error"]["code"] == "WRONG_PASSWORD"
    assert api.post("/auth/login", {"username": "ALICE", "password": "secret1"}).status_code == 200
    assert api.get("/state").status_code == 200


def test_mutations_must_be_json_and_same_origin(api, alice):
    assert api.c.post("/api/v1/tasks", data="x=1").status_code == 415
    r = api.post("/tasks", {}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def test_unknown_api_path_is_json(api):
    r = api.get("/nope")
    assert r.status_code == 404 and r.get_json()["error"]["code"] == "NOT_FOUND"
