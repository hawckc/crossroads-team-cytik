"""Task lifecycle: create, bail, retry, complete, forfeit, and settle().

A stake is moved from the wallet to escrow when the task is created. It leaves escrow exactly once:
back to the wallet (completed, bailed) or to the task's charity (failed). Every move is keyed, so a retry is a no-op.
"""
import uuid

from sqlalchemy import and_, or_, select

from .. import rules
from ..errors import ApiError
from ..models import Charity, Task, User, db
from . import accounts, activity, ledger


def get_owned(user, task_id):
    task = db.session.get(Task, str(task_id))
    if task is None or task.user_id != user.id:
        raise ApiError("NOT_FOUND", "Task not found", 404)
    return task


def _fmt(c):
    return activity.fmt(c)


def validate_new(data, now):
    name = str(data.get("name") or "").strip()
    if not name:
        raise ApiError("NAME_REQUIRED", "Name your task", 422)
    if len(name) > rules.MAX_NAME:
        raise ApiError("NAME_TOO_LONG", f"Task names can be up to {rules.MAX_NAME} characters", 422)
    stake = data.get("stakeCents")
    if not isinstance(stake, int) or isinstance(stake, bool):
        raise ApiError("INVALID_STAKE", "Enter a whole-dollar stake", 422)
    if stake < rules.MIN_STAKE_CENTS:
        raise ApiError("STAKE_TOO_LOW", f"Minimum stake is {_fmt(rules.MIN_STAKE_CENTS)}", 422)
    if stake > rules.MAX_STAKE_CENTS:
        raise ApiError("STAKE_TOO_HIGH", f"Maximum stake is {_fmt(rules.MAX_STAKE_CENTS)}", 422)
    deadline = data.get("deadline")
    if not isinstance(deadline, int) or isinstance(deadline, bool):
        raise ApiError("INVALID_DEADLINE", "Invalid date", 422)
    lead = deadline - now
    if lead < rules.MIN_LEAD_MS:
        raise ApiError("DEADLINE_TOO_SOON", "Pick a time 5 or more minutes ahead", 422)
    if lead > rules.MAX_LEAD_MS:
        raise ApiError("DEADLINE_TOO_FAR", "Up to a year ahead", 422)
    icon = str(data.get("icon") or "📌")[:8]
    return {"name": name, "stake": stake, "deadline": deadline, "icon": icon, "by_date": bool(data.get("byDate"))}


def create(user, data, now, idem_key=None):
    """Returns (task, created). A repeated Idempotency-Key returns the first task instead of making another."""
    if idem_key:
        existing = db.session.scalar(select(Task).where(Task.user_id == user.id, Task.idempotency_key == idem_key))
        if existing:
            return existing, False
    v = validate_new(data, now)
    wallet = ledger.account(ledger.WALLET, user.id)
    if v["stake"] > ledger.balance(wallet):
        raise ApiError("INSUFFICIENT_FUNDS", f"Stake is above your balance ({_fmt(ledger.balance(wallet))})", 422)
    task = Task(
        id=str(uuid.uuid4()), user_id=user.id, name=v["name"], icon=v["icon"], status="active", by_date=v["by_date"],
        stake_cents=v["stake"], charity_id=user.selected_charity_id, created_at=now, deadline_at=v["deadline"],
        duration_ms=v["deadline"] - now, idempotency_key=idem_key,
    )
    db.session.add(task)
    db.session.flush()
    ledger.transfer(wallet, ledger.account(ledger.ESCROW, user.id), task.stake_cents, f"stake:{task.id}", task.id, now)
    return task, True


def create_many(user, items, now, idem_key=None):
    if not items or len(items) > 10:
        raise ApiError("INVALID_BATCH", "Send between 1 and 10 tasks", 422)
    if idem_key:
        first = db.session.scalar(select(Task).where(Task.user_id == user.id, Task.idempotency_key == f"{idem_key}:0"))
        if first:
            return []
    validated = [validate_new(i, now) for i in items]
    total = sum(v["stake"] for v in validated)
    have = ledger.balance(ledger.account(ledger.WALLET, user.id))
    if total > have:
        raise ApiError("INSUFFICIENT_FUNDS", f"{_fmt(total)} is more than your balance ({_fmt(have)})", 422)
    return [create(user, item, now, f"{idem_key}:{i}" if idem_key else None)[0] for i, item in enumerate(items)]


def _release(task, now, tag):
    ledger.transfer(ledger.account(ledger.ESCROW, task.user_id), ledger.account(ledger.WALLET, task.user_id), task.stake_cents, f"release:{task.id}:{tag}", task.id, now)


def complete(task, now):
    """Photo verified: the stake goes back to the wallet. A task finished on its second attempt is "won back"."""
    won_back = task.attempt == 2
    _release(task, now, f"done{task.attempt}")
    task.status, task.completed_at, task.won_back = "completed", now, won_back
    task.offer_expires_at = task.missed_at = None
    activity.add(task.user_id, "completed", "↩️" if won_back else "✅", f'{"Won back" if won_back else "Completed"} "{task.name}"', now, task.id)


def bail(user, task, now):
    if task.status != "active":
        raise ApiError("TASK_NOT_ACTIVE", "This task is no longer running", 409)
    if task.attempt == 2:
        raise ApiError("BAIL_NOT_ALLOWED", "You cannot bail out of a retry", 409)
    if user.tickets < 1:
        raise ApiError("NO_TICKETS", "No tickets left. Buy one in the Shop", 422)
    user.tickets -= 1
    _release(task, now, "bail")
    task.status, task.bailed_at = "bailed", now
    activity.add(user.id, "bail", "🎫", f'Bailed out of "{task.name}" · {_fmt(task.stake_cents)} stake kept', now, task.id)


def forfeit(task, now, retried):
    charity = db.session.get(Charity, task.charity_id)
    ledger.transfer(ledger.account(ledger.ESCROW, task.user_id), ledger.account(ledger.CHARITY, task.charity_id), task.stake_cents, f"forfeit:{task.id}", task.id, now)
    task.status, task.failed_at, task.charged_cents, task.retry_missed = "failed", now, task.stake_cents, bool(retried)
    task.offer_expires_at = None
    activity.add(task.user_id, "penalty", "💸", f'Missed "{task.name}" — {_fmt(task.stake_cents)} sent to {charity.name if charity else "charity"}', now, task.id)


def accept_retry(user, task, duration_ms, now):
    if task.status != "offer":
        raise ApiError("TASK_NOT_ACTIVE", "This task has no open offer", 409)
    if now >= task.offer_expires_at:
        raise ApiError("OFFER_EXPIRED", "The offer has ended", 409)
    if accounts.retries_left(user, now) < 1:
        raise ApiError("NO_RETRIES", "No retries left. Get more in the Shop", 422)
    if duration_ms not in rules.retry_choices(task.duration_ms):
        raise ApiError("INVALID_DURATION", "Pick one of the offered lengths", 422)
    accounts.use_retry(user, now)
    task.status, task.attempt, task.created_at = "active", 2, now
    task.duration_ms, task.deadline_at, task.by_date = duration_ms, now + duration_ms, False
    task.offer_expires_at = task.missed_at = None
    activity.add(user.id, "offer", "↩️", f'One more try on "{task.name}"', now, task.id)


def decline_retry(task, now):
    if task.status != "offer":
        raise ApiError("TASK_NOT_ACTIVE", "This task has no open offer", 409)
    forfeit(task, now, False)


def settle(now, user_id=None):
    """Move every task whose deadline (or retry offer) has passed to its next state. Safe to run any time, any number of times."""
    q = select(Task).where(or_(
        and_(Task.status == "active", Task.deadline_at <= now),
        and_(Task.status == "offer", Task.offer_expires_at <= now),
    )).order_by(Task.deadline_at).with_for_update()
    if user_id is not None:
        q = q.where(Task.user_id == user_id)
    changed = 0
    for task in db.session.scalars(q).all():
        if task.status == "offer":                                   # nobody took the offer in time
            forfeit(task, now, False)
        elif task.attempt >= 2:                                      # a missed retry is final
            forfeit(task, now, True)
        else:
            expires = task.deadline_at + rules.OFFER_MS              # the window starts at the deadline, not when the miss is noticed
            if now >= expires:
                forfeit(task, now, False)
            else:
                task.status, task.missed_at, task.offer_expires_at = "offer", task.deadline_at, expires
                activity.add(task.user_id, "offer", "⏳", f'Missed "{task.name}": one more try offered', now, task.id)
        changed += 1
    return changed
