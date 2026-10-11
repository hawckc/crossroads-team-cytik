import os

from .conftest import photo


def test_shop_prices_come_from_the_server(api, alice):
    s = api.post("/shop/purchases", {"item": "bail", "qty": 3}).get_json()["state"]
    assert (s["tickets"], s["spendable"], s["balance"]) == (4, 9900, 9900)       # 3 tickets cost 1.00
    assert api.post("/shop/purchases", {"item": "bail", "qty": 2}).get_json()["error"]["code"] == "INVALID_PACK"
    assert api.post("/shop/purchases", {"item": "gold", "qty": 1}).get_json()["error"]["code"] == "INVALID_ITEM"


def test_purchase_is_applied_once_per_idempotency_key(api, alice):
    h = {"Idempotency-Key": "k1"}
    api.post("/shop/purchases", {"item": "bail", "qty": 1}, headers=h)
    api.post("/shop/purchases", {"item": "bail", "qty": 1}, headers=h)
    assert api.state()["tickets"] == 2


def test_topups_are_capped_per_day(api, alice):
    assert api.post("/wallet/topups", {"amountCents": 777}).get_json()["error"]["code"] == "INVALID_AMOUNT"
    for _ in range(5):
        assert api.post("/wallet/topups", {"amountCents": 10000}).status_code == 200
    assert api.post("/wallet/topups", {"amountCents": 2500}).get_json()["error"]["code"] == "TOPUP_LIMIT"
    assert api.state()["balance"] == 60000


def test_verified_photo_completes_the_task(api, alice, now):
    tid = api.new_task(now).get_json()["result"]["id"]
    r = api.post(f"/tasks/{tid}/proof", {"image": photo(1)})
    assert r.status_code == 200
    body = r.get_json()
    assert body["result"]["verdict"] == "verified"
    t = next(t for t in body["state"]["tasks"] if t["id"] == tid)
    assert t["status"] == "completed" and t["proof"]["image"] == f"/api/v1/tasks/{tid}/proof.jpg"
    assert body["state"]["spendable"] == 10000
    img = api.get(f"/tasks/{tid}/proof.jpg")
    assert img.status_code == 200 and img.mimetype == "image/jpeg"


def test_the_same_photo_cannot_be_used_twice(api, alice, now):
    t1 = api.new_task(now).get_json()["result"]["id"]
    t2 = api.new_task(now, name="Read").get_json()["result"]["id"]
    assert api.post(f"/tasks/{t1}/proof", {"image": photo(7)}).get_json()["result"]["verdict"] == "verified"
    r = api.post(f"/tasks/{t2}/proof", {"image": photo(7)}).get_json()
    assert r["result"]["verdict"] == "rejected"
    assert next(t for t in r["state"]["tasks"] if t["id"] == t2)["status"] == "active"
    assert api.post(f"/tasks/{t2}/proof", {"image": photo(8)}).get_json()["result"]["verdict"] == "verified"


def test_rejected_photo_leaves_the_task_running_and_keeps_no_image(api, app, alice, now, tmp_path):
    app.config["MOCK_VERIFIER_RESULT"] = "rejected"
    tid = api.new_task(now).get_json()["result"]["id"]
    r = api.post(f"/tasks/{tid}/proof", {"image": photo(3)}).get_json()
    assert r["result"]["verdict"] == "rejected"
    assert next(t for t in r["state"]["tasks"] if t["id"] == tid)["status"] == "active"
    assert not os.path.exists(tmp_path / "proofs" / f"{tid}.jpg")


def test_bad_uploads_and_closed_tasks(api, alice, now):
    tid = api.new_task(now).get_json()["result"]["id"]
    assert api.post(f"/tasks/{tid}/proof", {"image": "not an image"}).get_json()["error"]["code"] == "INVALID_IMAGE"
    assert api.post(f"/tasks/{tid}/proof", {"image": "data:image/png;base64,AAAA"}).get_json()["error"]["code"] == "INVALID_IMAGE"
    api.post(f"/tasks/{tid}/bail")
    assert api.post(f"/tasks/{tid}/proof", {"image": photo(1)}).get_json()["error"]["code"] == "TASK_NOT_ACTIVE"


def test_attempts_per_task_are_capped(api, app, alice, now):
    app.config["MOCK_VERIFIER_RESULT"] = "rejected"
    tid = api.new_task(now).get_json()["result"]["id"]
    for i in range(8):
        assert api.post(f"/tasks/{tid}/proof", {"image": photo(100 + i)}).status_code == 200
    assert api.post(f"/tasks/{tid}/proof", {"image": photo(200)}).get_json()["error"]["code"] == "ATTEMPT_LIMIT"
