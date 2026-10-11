"""Builds the object the client keeps as `state` (see js/app.js). Amounts are cents; js/api.js converts them to dollars."""
import json

from sqlalchemy import select

from .. import rules
from ..models import Charity, Proof, Task, db
from . import accounts, activity, ledger


def proof_url(task, proof):
    if proof.image_path:
        return f"/api/v1/tasks/{task.id}/proof.jpg"
    return proof.image_url


def task_dict(t, proof=None):
    d = {
        "id": t.id, "name": t.name, "icon": t.icon, "status": t.status, "byDate": t.by_date,
        "createdAt": t.created_at, "deadline": t.deadline_at, "durationMs": t.duration_ms, "penalty": t.stake_cents,
        "attempt": t.attempt, "offerExpiresAt": t.offer_expires_at, "missedAt": t.missed_at, "completedAt": t.completed_at,
        "failedAt": t.failed_at, "bailedAt": t.bailed_at, "charged": t.charged_cents, "charityId": t.charity_id,
        "wonBack": t.won_back or None, "retryMissed": t.retry_missed or None,
    }
    if t.status == "offer":
        d["offerChoiceMs"] = rules.default_retry_ms(t.duration_ms)
    if proof is not None:
        d["proof"] = {"image": proof_url(t, proof), "ai": {"verdict": proof.verdict, "confidence": proof.confidence, "at": proof.created_at}}
    return {k: v for k, v in d.items() if v is not None}


def build(user, now):
    wallet, escrow = ledger.user_money(user.id)
    tasks = db.session.scalars(select(Task).where(Task.user_id == user.id).order_by(Task.created_at.desc())).all()
    proofs = {}
    if tasks:
        for p in db.session.scalars(select(Proof).where(Proof.user_id == user.id, Proof.accepted.is_(True))).all():
            proofs[p.task_id] = p
    raised = ledger.charity_totals()
    charities = [
        {"id": c.id, "name": c.name, "category": c.category, "desc": c.desc, "goal": c.goal_cents,
         "raised": c.seed_raised_cents + raised.get(c.id, 0), "impact": {"per": c.impact_per, "text": c.impact_text}}
        for c in db.session.scalars(select(Charity).order_by(Charity.sort)).all()
    ]
    mk = accounts.month_key(user, now)
    return {
        "serverNow": now,
        "user": {"username": user.username, "name": user.name},
        "balance": wallet + escrow,                      # total funds: unchanged until a stake is forfeited
        "spendable": wallet,                             # what can still be staked or spent
        "tickets": user.tickets,
        "extraRetries": user.extra_retries,
        "retries": {"month": mk, "used": rules.RETRIES_PER_MONTH - accounts.free_retries_left(user, now)},
        "totalSent": sum(t.charged_cents or 0 for t in tasks if t.status == "failed"),
        "defaultPenalty": user.default_stake_cents,
        "selectedCharityId": user.selected_charity_id,
        "charities": charities,
        "tasks": [task_dict(t, proofs.get(t.id)) for t in tasks],
        "activity": activity.recent(user.id),
        "profile": json.loads(user.profile_json) if user.profile_json else None,
        "onboarded": bool(user.onboarded),
        "config": {
            "minStakeCents": rules.MIN_STAKE_CENTS, "packPricesCents": rules.PACKS, "retriesPerMonth": rules.RETRIES_PER_MONTH,
            "offerMs": rules.OFFER_MS, "topupAmountsCents": list(rules.TOPUP_AMOUNTS_CENTS),
        },
    }
