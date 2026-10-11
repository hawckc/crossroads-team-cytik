"""Double-entry ledger. Balances are always derived from entries; nothing is ever updated or deleted."""
import uuid

from sqlalchemy import func, select

from .. import clock
from ..errors import ApiError
from ..models import Account, LedgerEntry, db

WALLET, ESCROW, CHARITY, TOPUP, REVENUE = "WALLET", "ESCROW", "CHARITY", "TOPUP_SOURCE", "SHOP_REVENUE"


def account(kind, owner_ref=""):
    owner_ref = str(owner_ref)
    acc = db.session.scalar(select(Account).where(Account.kind == kind, Account.owner_ref == owner_ref))
    if acc is None:
        acc = Account(kind=kind, owner_ref=owner_ref)
        db.session.add(acc)
        db.session.flush()
    return acc


def balance(acc):
    return db.session.scalar(select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0)).where(LedgerEntry.account_id == acc.id))


def used(key):
    return db.session.scalar(select(LedgerEntry.id).where(LedgerEntry.idempotency_key == key).limit(1)) is not None


def transfer(src, dst, amount, key, task_id=None, now=None):
    """Move `amount` cents from src to dst. Returns False (and does nothing) if `key` was already used."""
    if amount <= 0:
        raise ValueError("amount must be positive")
    if used(key):
        return False
    if src.kind == WALLET and balance(src) < amount:
        raise ApiError("INSUFFICIENT_FUNDS", "Not enough balance", 422)
    txn, at = uuid.uuid4().hex, now if now is not None else clock.now_ms()
    db.session.add(LedgerEntry(txn_id=txn, account_id=src.id, amount_cents=-amount, idempotency_key=key, task_id=task_id, created_at=at))
    db.session.add(LedgerEntry(txn_id=txn, account_id=dst.id, amount_cents=amount, idempotency_key=key, task_id=task_id, created_at=at))
    db.session.flush()
    return True


def user_money(user_id):
    """(wallet, escrow) in cents. Total balance is wallet + escrow; only the wallet is spendable."""
    return balance(account(WALLET, user_id)), balance(account(ESCROW, user_id))


def charity_totals():
    """{charity_id: cents received}"""
    rows = db.session.execute(
        select(Account.owner_ref, func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .join(LedgerEntry, LedgerEntry.account_id == Account.id)
        .where(Account.kind == CHARITY)
        .group_by(Account.owner_ref)
    ).all()
    return {ref: int(total) for ref, total in rows}
