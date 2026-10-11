"""HTTP API under /api/v1. Every mutation answers {"result": ..., "state": <client state>} so the client can swap its state in."""
import json
import os
from functools import wraps
from urllib.parse import urlparse

from flask import Blueprint, current_app, g, jsonify, request, send_file, session
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from . import clock, ratelimit, rules, seed
from .errors import ApiError
from .models import Charity, Proof, User, db
from .services import accounts, images, shop, state_view
from .services import tasks as task_svc
from .services.verifier import VerifierUnavailable, get_verifier

bp = Blueprint("api", __name__, url_prefix="/api/v1")


@bp.errorhandler(ApiError)
def _api_error(e):
    db.session.rollback()
    return jsonify(error={"code": e.code, "message": e.message, "details": e.details}), e.status


@bp.errorhandler(IntegrityError)
def _integrity(e):
    db.session.rollback()
    return jsonify(error={"code": "CONFLICT", "message": "That request conflicted with another. Try again.", "details": None}), 409


@bp.before_request
def _guard():
    """Cookie auth needs a CSRF barrier: mutations must be JSON, and a cross-site Origin is refused."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        if not request.is_json:
            raise ApiError("UNSUPPORTED_MEDIA_TYPE", "Send JSON", 415)
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            raise ApiError("BAD_ORIGIN", "Cross-site requests are not allowed", 403)


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("INVALID_JSON", "Send a JSON object", 400)
    return data


def idem_key():
    key = (request.headers.get("Idempotency-Key") or "").strip()
    return key[:64] or None


def limit(key, count, window_ms):
    if current_app.config["RATELIMIT_ENABLED"]:
        ratelimit.check(key, count, window_ms)


def auth(fn):
    """Loads the signed-in user, settles any deadlines that have passed, and (for mutations) locks the user's row."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = db.session.get(User, session["uid"]) if "uid" in session else None
        if user is None:
            session.clear()
            raise ApiError("UNAUTHENTICATED", "Sign in required", 401)
        g.user, g.now = user, clock.now_ms()
        if task_svc.settle(g.now, user.id):
            db.session.commit()
        if request.method != "GET":
            db.session.refresh(user, with_for_update=True)           # serialises this user's money moves on Postgres
        return fn(*args, **kwargs)
    return wrapper


def ok(result=None, status=200):
    db.session.commit()
    return jsonify(result=result, state=state_view.build(g.user, clock.now_ms())), status


@bp.get("/health")
def health():
    return jsonify(ok=True)


# ---------- accounts ----------
@bp.post("/auth/register")
def register():
    limit(f"register:{request.remote_addr}", 10, rules.HOUR)
    data = body()
    errors = accounts.validate_registration(data)
    if errors:
        raise ApiError("VALIDATION", "Check the highlighted fields", 422, errors)
    username = str(data["username"]).strip().lower()
    if accounts.find(username):
        raise ApiError("USERNAME_TAKEN", "Username taken", 409, {"username": "Username taken"})
    user = accounts.create_user(username, str(data["name"]), str(data["password"]), data.get("timezone"), clock.now_ms())
    db.session.commit()
    session.clear()
    session["uid"], session.permanent = user.id, True
    g.user = user
    return ok(status=201)


@bp.post("/auth/login")
def login():
    data = body()
    username = str(data.get("username") or "").strip().lower()
    limit(f"login:{request.remote_addr}:{username}", 10, 5 * rules.MINUTE)
    user = accounts.find(username)
    if user is None:
        raise ApiError("NO_SUCH_USER", "No account with that username", 401)
    if not accounts.check_password(user, str(data.get("password") or "")):
        raise ApiError("WRONG_PASSWORD", "Wrong password", 401)
    now = clock.now_ms()
    if current_app.config["DEMO_ENABLED"]:
        seed.reseed_demo_if_stale(user, now)
    session.clear()
    session["uid"], session.permanent = user.id, True
    g.user = user
    return ok()


@bp.post("/auth/logout")
def logout():
    session.clear()
    return jsonify(result=None)


@bp.get("/state")
@auth
def get_state():
    return jsonify(state=state_view.build(g.user, clock.now_ms()))


# ---------- tasks ----------
@bp.post("/tasks")
@auth
def create_task():
    task, created = task_svc.create(g.user, body(), g.now, idem_key())
    return ok({"id": task.id}, 201 if created else 200)


@bp.post("/tasks/batch")
@auth
def create_tasks():
    items = body().get("tasks")
    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
        raise ApiError("INVALID_BATCH", "Send a list of tasks", 422)
    created = task_svc.create_many(g.user, items, g.now, idem_key())
    return ok({"ids": [t.id for t in created]}, 201)


@bp.post("/tasks/<task_id>/bail")
@auth
def bail(task_id):
    task_svc.bail(g.user, task_svc.get_owned(g.user, task_id), g.now)
    return ok()


@bp.post("/tasks/<task_id>/retry")
@auth
def retry(task_id):
    duration = body().get("durationMs")
    task = task_svc.get_owned(g.user, task_id)
    task_svc.accept_retry(g.user, task, duration if isinstance(duration, int) else -1, g.now)
    return ok()


@bp.post("/tasks/<task_id>/decline")
@auth
def decline(task_id):
    task_svc.decline_retry(task_svc.get_owned(g.user, task_id), g.now)
    return ok()


@bp.post("/tasks/<task_id>/proof")
@auth
def proof(task_id):
    """Check a photo. A verified photo completes the task and releases the stake in the same request."""
    user, received = g.user, g.now
    task = task_svc.get_owned(user, task_id)
    if task.status != "active":
        raise ApiError("TASK_NOT_ACTIVE", "This task is no longer running", 409)
    limit(f"proof:{user.id}", rules.PROOF_PER_HOUR, rules.HOUR)
    attempts = db.session.scalar(select(func.count(Proof.id)).where(Proof.task_id == task.id))
    if attempts >= rules.MAX_PROOF_ATTEMPTS_PER_TASK:
        raise ApiError("ATTEMPT_LIMIT", "Too many photo attempts for this task", 429)
    try:
        jpeg, phash = images.process(images.parse_data_url(body().get("image")))
    except ValueError as e:
        raise ApiError("INVALID_IMAGE", f"That photo could not be read ({e})", 400)

    cfg = current_app.config
    if cfg["DUPLICATE_PHOTO_CHECK"]:
        earlier = db.session.scalars(select(Proof.phash).where(Proof.user_id == user.id, Proof.accepted.is_(True), Proof.phash.isnot(None))).all()
        if any(images.hamming(phash, h) <= 3 for h in earlier):
            db.session.add(Proof(task_id=task.id, user_id=user.id, verdict="rejected", note="This photo was already used as proof.", created_at=received, provider="rule"))
            result = {"verdict": "rejected", "confidence": 0, "detected": [], "note": "This photo was already used as proof."}
            return ok(result)

    name, icon = task.name, task.icon
    db.session.commit()                                              # do not hold the row lock during the model call
    try:
        verdict = get_verifier(current_app).verify(name, icon, jpeg)
    except VerifierUnavailable as e:
        current_app.logger.warning("verifier unavailable: %s", e)
        raise ApiError("VERIFIER_UNAVAILABLE", "The photo check is unavailable. Try again.", 503)
    current_app.logger.info("proof verdict task=%s provider=%s model=%s tokens=%s/%s", task.id, verdict.provider, verdict.model, verdict.tokens_in, verdict.tokens_out)

    db.session.refresh(user, with_for_update=True)
    db.session.refresh(task)
    row = Proof(
        task_id=task.id, user_id=user.id, verdict=verdict.verdict, confidence=verdict.confidence, note=verdict.note,
        detected_json=json.dumps(verdict.detected), provider=verdict.provider, model=verdict.model,
        tokens_in=verdict.tokens_in, tokens_out=verdict.tokens_out, created_at=clock.now_ms(),
    )
    if verdict.verdict == "verified":
        # the upload counts if the server received it before the deadline, even if the verdict arrived later
        if task.status not in ("active", "offer") or received >= task.deadline_at:
            raise ApiError("TOO_LATE", "The deadline passed before the photo was checked", 409)
        row.accepted, row.phash = True, phash
        proof_dir = cfg["PROOF_DIR"] or os.path.join(current_app.instance_path, "proofs")
        row.image_path = images.save(proof_dir, task.id, jpeg)
        task_svc.complete(task, row.created_at)
    db.session.add(row)
    return ok({"verdict": verdict.verdict, "confidence": verdict.confidence, "detected": verdict.detected, "note": verdict.note})


@bp.get("/tasks/<task_id>/proof.jpg")
@auth
def proof_image(task_id):
    task = task_svc.get_owned(g.user, task_id)
    row = db.session.scalar(select(Proof).where(Proof.task_id == task.id, Proof.accepted.is_(True), Proof.image_path.isnot(None)))
    if row is None or not os.path.exists(row.image_path):
        raise ApiError("NOT_FOUND", "No photo for this task", 404)
    resp = send_file(row.image_path, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


# ---------- shop, wallet, settings ----------
@bp.post("/shop/purchases")
@auth
def buy():
    data = body()
    shop.purchase(g.user, data.get("item"), data.get("qty"), idem_key(), g.now)
    return ok()


@bp.post("/wallet/topups")
@auth
def add_funds():
    limit(f"topup:{g.user.id}", 20, rules.HOUR)
    cents = body().get("amountCents")
    shop.topup(g.user, cents if isinstance(cents, int) else -1, idem_key(), g.now)
    return ok()


@bp.put("/me/charity")
@auth
def set_charity():
    cid = body().get("charityId")
    if not isinstance(cid, str) or db.session.get(Charity, cid) is None:
        raise ApiError("UNKNOWN_CHARITY", "Unknown charity", 422)
    g.user.selected_charity_id = cid                                # running tasks keep the charity they started with
    return ok()


@bp.patch("/me/settings")
@auth
def settings():
    stake = body().get("defaultStakeCents")
    if not isinstance(stake, int) or isinstance(stake, bool) or stake < rules.MIN_STAKE_CENTS:
        raise ApiError("STAKE_TOO_LOW", f"Minimum stake is ${rules.MIN_STAKE_CENTS // 100}", 422)
    if stake > rules.MAX_STAKE_CENTS:
        raise ApiError("STAKE_TOO_HIGH", f"Maximum stake is ${rules.MAX_STAKE_CENTS // 100}", 422)
    g.user.default_stake_cents = stake
    return ok()


@bp.put("/me/profile")
@auth
def profile():
    data = body()
    prof = data.get("profile")
    if prof is not None:
        if not isinstance(prof, dict) or len(json.dumps(prof)) > 4000:
            raise ApiError("INVALID_PROFILE", "Invalid profile", 422)
        g.user.profile_json = json.dumps(prof)
    if "onboarded" in data:
        g.user.onboarded = bool(data["onboarded"])
    if isinstance(data.get("defaultStakeCents"), int) and rules.MIN_STAKE_CENTS <= data["defaultStakeCents"] <= rules.MAX_STAKE_CENTS:
        g.user.default_stake_cents = data["defaultStakeCents"]
    return ok()


@bp.post("/me/reset")
@auth
def reset():
    if not g.user.is_demo:
        raise ApiError("FORBIDDEN", "Only the demo account can be reset", 403)
    seed.seed_demo(g.user, g.now)
    return ok()
