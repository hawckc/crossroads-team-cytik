"""Shop packs and simulated top-ups. Prices come from rules.py; the client only sends an item and a pack size."""
import uuid

from sqlalchemy import func, select

from .. import rules
from ..errors import ApiError
from ..models import LedgerEntry, db
from . import activity, ledger


def purchase(user, item, qty, key, now):
    packs = rules.PACKS.get(item)
    if packs is None:
        raise ApiError("INVALID_ITEM", "Unknown item", 422)
    if not isinstance(qty, int) or qty not in packs:
        raise ApiError("INVALID_PACK", "Unknown pack size", 422)
    cost = packs[qty]
    key = f"buy:{user.id}:{key or uuid.uuid4().hex}"
    if ledger.used(key):
        return                                                       # a retried request that already went through
    wallet = ledger.account(ledger.WALLET, user.id)
    have = ledger.balance(wallet)
    if cost > have:
        raise ApiError("INSUFFICIENT_FUNDS", f"Not enough balance ({activity.fmt(have)})", 422)
    if not ledger.transfer(wallet, ledger.account(ledger.REVENUE), cost, key, now=now):
        return
    if item == "bail":
        user.tickets += qty
        activity.add(user.id, "ticket", "🎫", f"Bought {qty} bail-out ticket{'s' if qty > 1 else ''} for {activity.fmt(cost)}", now)
    else:
        user.extra_retries += qty
        activity.add(user.id, "ticket", "↩️", f"Bought {qty} {'retries' if qty > 1 else 'retry'} for {activity.fmt(cost)}", now)


def topup(user, cents, key, now):
    if cents not in rules.TOPUP_AMOUNTS_CENTS:
        raise ApiError("INVALID_AMOUNT", "Choose one of the amounts", 422)
    key = f"topup:{user.id}:{key or uuid.uuid4().hex}"
    if ledger.used(key):
        return
    wallet = ledger.account(ledger.WALLET, user.id)
    added = db.session.scalar(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.account_id == wallet.id, LedgerEntry.idempotency_key.like("topup:%"), LedgerEntry.created_at > now - rules.DAY)
    )
    if added + cents > rules.TOPUP_DAILY_CAP_CENTS:
        raise ApiError("TOPUP_LIMIT", f"Daily limit of {activity.fmt(rules.TOPUP_DAILY_CAP_CENTS)} reached", 422)
    if ledger.transfer(ledger.account(ledger.TOPUP), wallet, cents, key, now=now):
        activity.add(user.id, "funds", "💰", f"Added {activity.fmt(cents)} to account", now)
