from backend.models import LedgerEntry, db
from backend.services import tasks

from .conftest import MIN


def task_of(api, tid):
    return next(t for t in api.state()["tasks"] if t["id"] == tid)


def test_create_reserves_the_stake(api, alice, now):
    r = api.new_task(now)
    assert r.status_code == 201
    s = r.get_json()["state"]
    assert (s["balance"], s["spendable"]) == (10000, 9000)          # total unchanged, 10.00 held
    assert s["tasks"][0]["status"] == "active" and s["tasks"][0]["penalty"] == 1000


def test_create_validation(api, alice, now):
    assert api.new_task(now, stake_cents=999).get_json()["error"]["code"] == "STAKE_TOO_LOW"
    assert api.new_task(now, minutes=2).get_json()["error"]["code"] == "DEADLINE_TOO_SOON"
    assert api.new_task(now, minutes=60 * 24 * 400).get_json()["error"]["code"] == "DEADLINE_TOO_FAR"
    assert api.new_task(now, name=" ").get_json()["error"]["code"] == "NAME_REQUIRED"
    assert api.new_task(now, stake_cents=10100).get_json()["error"]["code"] == "INSUFFICIENT_FUNDS"


def test_stakes_cannot_be_overcommitted(api, alice, now):
    for _ in range(10):
        assert api.new_task(now).status_code == 201
    assert api.new_task(now).get_json()["error"]["code"] == "INSUFFICIENT_FUNDS"


def test_idempotency_key_creates_once(api, alice, now):
    h = {"Idempotency-Key": "abc"}
    assert api.new_task(now, headers=h).status_code == 201
    assert api.new_task(now, headers=h).status_code == 200
    assert len(api.state()["tasks"]) == 1 and api.state()["spendable"] == 9000


def test_miss_opens_an_offer_then_forfeits_to_the_charity(api, alice, now):
    tid = api.new_task(now, minutes=10).get_json()["result"]["id"]
    before = {c["id"]: c["raised"] for c in api.state()["charities"]}
    now.t += 11 * MIN
    t = task_of(api, tid)
    assert t["status"] == "offer" and t["offerExpiresAt"] == t["deadline"] + 10 * MIN * 1000
    now.t += 10 * MIN
    s = api.state()
    t = task_of(api, tid)
    assert t["status"] == "failed" and t["charged"] == 1000 and s["totalSent"] == 1000
    assert (s["balance"], s["spendable"]) == (9000, 9000)
    after = {c["id"]: c["raised"] for c in s["charities"]}
    assert after["ocean"] == before["ocean"] + 1000


def test_offer_that_lapsed_while_away_forfeits_straight_away(api, alice, now):
    tid = api.new_task(now, minutes=10).get_json()["result"]["id"]
    now.t += 3 * 3600
    assert task_of(api, tid)["status"] == "failed"


def test_retry_then_miss_again_is_final(api, alice, now):
    tid = api.new_task(now, minutes=60).get_json()["result"]["id"]
    now.t += 61 * MIN
    r = api.post(f"/tasks/{tid}/retry", {"durationMs": 3600000})
    assert r.status_code == 200
    s = r.get_json()["state"]
    t = task_of(api, tid)
    assert t["attempt"] == 2 and t["status"] == "active" and s["retries"]["used"] == 1 and s["spendable"] == 9000
    assert api.post(f"/tasks/{tid}/bail").get_json()["error"]["code"] == "BAIL_NOT_ALLOWED"
    now.t += 61 * MIN
    t = task_of(api, tid)
    assert t["status"] == "failed" and t["retryMissed"] is True


def test_retry_rules(api, alice, now):
    tid = api.new_task(now, minutes=60).get_json()["result"]["id"]
    assert api.post(f"/tasks/{tid}/retry", {"durationMs": 3600000}).get_json()["error"]["code"] == "TASK_NOT_ACTIVE"   # still running
    now.t += 61 * MIN
    assert api.post(f"/tasks/{tid}/retry", {"durationMs": 12345}).get_json()["error"]["code"] == "INVALID_DURATION"
    assert api.post(f"/tasks/{tid}/decline").status_code == 200
    assert task_of(api, tid)["status"] == "failed"


def test_free_retries_run_out_then_bought_ones_are_used(api, alice, now):
    for _ in range(4):
        tid = api.new_task(now, minutes=10, stake_cents=1000).get_json()["result"]["id"]
        now.t += 11 * MIN
        assert api.post(f"/tasks/{tid}/retry", {"durationMs": 3600000}).status_code == 200
        now.t += 3 * 3600
        api.state()
    tid = api.new_task(now, minutes=10).get_json()["result"]["id"]
    now.t += 11 * MIN
    assert api.post(f"/tasks/{tid}/retry", {"durationMs": 3600000}).get_json()["error"]["code"] == "NO_RETRIES"
    api.post("/shop/purchases", {"item": "retry", "qty": 1})
    assert api.post(f"/tasks/{tid}/retry", {"durationMs": 3600000}).status_code == 200
    assert api.state()["extraRetries"] == 0


def test_bail_spends_a_ticket_and_keeps_the_stake(api, alice, now):
    tid = api.new_task(now).get_json()["result"]["id"]
    s = api.post(f"/tasks/{tid}/bail").get_json()["state"]
    assert (s["tickets"], s["spendable"], s["totalSent"]) == (0, 10000, 0)
    tid2 = api.new_task(now).get_json()["result"]["id"]
    assert api.post(f"/tasks/{tid2}/bail").get_json()["error"]["code"] == "NO_TICKETS"


def test_other_users_tasks_are_invisible(api, app, alice, now):
    tid = api.new_task(now).get_json()["result"]["id"]
    bob = type(api)(app.test_client())
    bob.register("bob", "secret2", "Bob")
    assert bob.post(f"/tasks/{tid}/bail").status_code == 404
    assert bob.state()["tasks"] == []


def test_settle_is_idempotent_and_the_ledger_balances(api, app, alice, now):
    api.new_task(now, minutes=10)
    now.t += 3 * 3600
    with app.app_context():
        assert tasks.settle(int(now.t * 1000)) == 1
        db.session.commit()
        assert tasks.settle(int(now.t * 1000)) == 0
        assert db.session.query(db.func.sum(LedgerEntry.amount_cents)).scalar() == 0
    assert api.state()["totalSent"] == 1000
