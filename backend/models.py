"""Database models. Timestamps are epoch milliseconds (BigInteger) and money is integer cents."""
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import BigInteger, CheckConstraint, Index, UniqueConstraint

db = SQLAlchemy()


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False, index=True)
    name = db.Column(db.String(30), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    timezone = db.Column(db.String(64), nullable=False, default="UTC")
    tickets = db.Column(db.Integer, nullable=False, default=0)
    extra_retries = db.Column(db.Integer, nullable=False, default=0)        # bought retries; they do not expire
    retries_month = db.Column(db.String(7), nullable=False, default="")     # "2026-10" in the user's timezone
    retries_used = db.Column(db.Integer, nullable=False, default=0)         # free retries used in retries_month
    default_stake_cents = db.Column(db.Integer, nullable=False, default=1000)
    selected_charity_id = db.Column(db.String(32), nullable=False, default="ocean")
    profile_json = db.Column(db.Text)
    onboarded = db.Column(db.Boolean, nullable=False, default=False)
    is_demo = db.Column(db.Boolean, nullable=False, default=False)
    seeded_at = db.Column(BigInteger)
    created_at = db.Column(BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint("tickets >= 0", name="ck_user_tickets"),
        CheckConstraint("extra_retries >= 0", name="ck_user_extra_retries"),
    )


class Account(db.Model):
    """A ledger account. WALLET and ESCROW belong to a user (owner_ref = user id), CHARITY to a charity id."""
    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(16), nullable=False)
    owner_ref = db.Column(db.String(40), nullable=False, default="")

    __table_args__ = (UniqueConstraint("kind", "owner_ref", name="uq_account_owner"),)


class LedgerEntry(db.Model):
    """Append-only. Two entries per transfer share a txn_id and sum to zero."""
    id = db.Column(db.Integer, primary_key=True)
    txn_id = db.Column(db.String(32), nullable=False, index=True)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False, index=True)
    amount_cents = db.Column(BigInteger, nullable=False)
    idempotency_key = db.Column(db.String(120), nullable=False)
    task_id = db.Column(db.String(36), index=True)
    created_at = db.Column(BigInteger, nullable=False)

    __table_args__ = (UniqueConstraint("idempotency_key", "account_id", name="uq_ledger_key_account"),)


class Charity(db.Model):
    id = db.Column(db.String(32), primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    category = db.Column(db.String(32), nullable=False)
    desc = db.Column(db.String(200), nullable=False)
    goal_cents = db.Column(BigInteger, nullable=False)
    seed_raised_cents = db.Column(BigInteger, nullable=False, default=0)    # sample baseline; real forfeits are added on top
    impact_per = db.Column(db.Integer, nullable=False)                      # dollars
    impact_text = db.Column(db.String(120), nullable=False)
    sort = db.Column(db.Integer, nullable=False, default=0)


class Task(db.Model):
    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    name = db.Column(db.String(40), nullable=False)
    icon = db.Column(db.String(8), nullable=False, default="📌")
    status = db.Column(db.String(12), nullable=False)                       # active | offer | completed | failed | bailed
    by_date = db.Column(db.Boolean, nullable=False, default=False)
    stake_cents = db.Column(db.Integer, nullable=False)
    charity_id = db.Column(db.String(32), nullable=False)                   # chosen when the task was created
    created_at = db.Column(BigInteger, nullable=False)
    deadline_at = db.Column(BigInteger, nullable=False)
    duration_ms = db.Column(BigInteger, nullable=False)
    attempt = db.Column(db.Integer, nullable=False, default=1)
    offer_expires_at = db.Column(BigInteger)
    missed_at = db.Column(BigInteger)
    completed_at = db.Column(BigInteger)
    failed_at = db.Column(BigInteger)
    bailed_at = db.Column(BigInteger)
    charged_cents = db.Column(db.Integer)
    won_back = db.Column(db.Boolean, nullable=False, default=False)
    retry_missed = db.Column(db.Boolean, nullable=False, default=False)
    idempotency_key = db.Column(db.String(80))

    __table_args__ = (
        CheckConstraint("stake_cents > 0", name="ck_task_stake"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_task_idem"),
        Index("ix_task_due", "status", "deadline_at"),
    )


class Proof(db.Model):
    """One photo check. Only an accepted proof keeps its image; a rejected one keeps the verdict."""
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.String(36), db.ForeignKey("task.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    accepted = db.Column(db.Boolean, nullable=False, default=False)
    verdict = db.Column(db.String(12), nullable=False)                      # verified | rejected
    confidence = db.Column(db.Integer, nullable=False, default=0)
    detected_json = db.Column(db.Text)
    note = db.Column(db.String(300))
    image_path = db.Column(db.String(255))                                  # a file under the proof directory
    image_url = db.Column(db.String(255))                                   # a static URL (demo history photos)
    phash = db.Column(db.String(16), index=True)
    provider = db.Column(db.String(24))
    model = db.Column(db.String(64))
    tokens_in = db.Column(db.Integer)
    tokens_out = db.Column(db.Integer)
    created_at = db.Column(BigInteger, nullable=False)


class Activity(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    type = db.Column(db.String(16), nullable=False)
    icon = db.Column(db.String(8), nullable=False)
    text = db.Column(db.String(200), nullable=False)
    task_id = db.Column(db.String(36))
    created_at = db.Column(BigInteger, nullable=False)
