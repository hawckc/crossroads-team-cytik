"""Charities and the demo account (a port of seedState() in js/mock-data.js)."""
import uuid

from sqlalchemy import delete, select

from . import clock, rules
from .models import Account, Activity, Charity, LedgerEntry, Proof, Task, User, db
from .services import accounts, activity, ledger

E = ['🏋️', '🍳', '💻', '🧹', '📚', '🏃', '🧘', '💊', '🎨', '🌿']

# (id, name, category, desc, raised, goal, impact per $, impact text): sample charities, none are real organisations
CHARITIES = [
    ("ocean", "Ocean Cleanup Alliance", "Environment", "Removing plastic from oceans and rivers worldwide.", 1240, 2000, 10, "removes about 20 kg of plastic from rivers"),
    ("food", "Food for All", "Hunger", "Serving hot meals to families facing hunger.", 865, 1500, 10, "provides about 4 hot meals"),
    ("green", "Green Earth Initiative", "Environment", "Planting trees and restoring damaged habitats.", 530, 1000, 10, "plants about 5 trees"),
    ("read", "Read Together", "Education", "Putting books in the hands of children who have none.", 410, 800, 10, "buys about 3 children's books"),
    ("water", "Clean Water Now", "Health", "Building wells and filters for villages without safe water.", 720, 1200, 10, "gives one person clean water for a year"),
    ("clinic", "Health Bridge", "Health", "Mobile clinics bringing basic care to remote areas.", 300, 900, 10, "covers about 2 clinic visits"),
]

PROOF_IMAGES = {"h1": ("stretch", 94), "h2": ("run", 91), "h3": ("study", 88), "h5": ("gym", 96), "h6": ("read", 90), "h8": ("cook", 87), "h9": ("work", 93)}
DEMO_USERNAME, DEMO_PASSWORD = "demo", "demo123"
DEMO_REFRESH_MS = 12 * rules.HOUR


def seed_charities():
    if db.session.scalar(select(Charity.id).limit(1)):
        return
    for i, (cid, name, cat, desc, raised, goal, per, text) in enumerate(CHARITIES):
        db.session.add(Charity(id=cid, name=name, category=cat, desc=desc, seed_raised_cents=raised * 100, goal_cents=goal * 100, impact_per=per, impact_text=text, sort=i))
        ledger.account(ledger.CHARITY, cid)
    db.session.commit()


def ensure_demo():
    if db.session.scalar(select(User.id).where(User.username == DEMO_USERNAME)):
        return
    now = clock.now_ms()
    user = accounts.create_user(DEMO_USERNAME, "Demo", DEMO_PASSWORD, "UTC", now, demo=True)
    seed_demo(user, now)
    db.session.commit()


def _wipe(user):
    """Remove everything the demo user owns, including the counter-entries of its transfers, so totals stay balanced."""
    wallet, escrow = ledger.account(ledger.WALLET, user.id), ledger.account(ledger.ESCROW, user.id)
    task_ids = db.session.scalars(select(Task.id).where(Task.user_id == user.id)).all()
    txns = set(db.session.scalars(select(LedgerEntry.txn_id).where(LedgerEntry.account_id.in_([wallet.id, escrow.id]))).all())
    if task_ids:
        txns |= set(db.session.scalars(select(LedgerEntry.txn_id).where(LedgerEntry.task_id.in_(task_ids))).all())
    if txns:
        db.session.execute(delete(LedgerEntry).where(LedgerEntry.txn_id.in_(txns)))
    db.session.execute(delete(Proof).where(Proof.user_id == user.id))
    db.session.execute(delete(Activity).where(Activity.user_id == user.id))
    db.session.execute(delete(Task).where(Task.user_id == user.id))
    db.session.flush()


def seed_demo(user, now):
    """Reset the demo account: $115 funded, $15 already sent to charity, a week of history and four running tasks."""
    _wipe(user)
    user.tickets, user.extra_retries, user.retries_month, user.retries_used = 1, 0, "", 0
    user.default_stake_cents, user.selected_charity_id, user.profile_json, user.onboarded, user.seeded_at = 1000, "ocean", None, True, now
    wallet, escrow = ledger.account(ledger.WALLET, user.id), ledger.account(ledger.ESCROW, user.id)
    ledger.transfer(ledger.account(ledger.TOPUP), wallet, 11500, f"seed:fund:{user.id}:{now}", now=now - 7 * rules.DAY)

    H, D = rules.HOUR, rules.DAY
    done = []                                                                 # (task, activity_at, text, type, icon)

    def past(key, name, icon, stake, ago, status, charity=None, **extra):
        at = now - ago
        t = Task(id=str(uuid.uuid4()), user_id=user.id, name=name, icon=icon, status=status, stake_cents=stake * 100,
                 charity_id=charity or "ocean", created_at=at - 2 * H, deadline_at=at, duration_ms=2 * H, **extra)
        db.session.add(t)
        db.session.flush()
        if status == "completed":
            t.completed_at = at - 25 * 60000
            if key in PROOF_IMAGES:
                img, conf = PROOF_IMAGES[key]
                db.session.add(Proof(task_id=t.id, user_id=user.id, accepted=True, verdict="verified", confidence=conf, image_url=f"img/proof/{img}.jpg", created_at=t.completed_at))
            icon_, text = ("↩️", f'Won back "{name}" on one more try') if extra.get("won_back") else ("✅", f'Completed "{name}" · verified {88 + len(name) % 10}% confidence')
            done.append((t, t.completed_at, text, "completed", icon_))
        elif status == "failed":
            t.failed_at, t.charged_cents = at, t.stake_cents
            ledger.transfer(wallet, ledger.account(ledger.CHARITY, t.charity_id), t.stake_cents, f"seed:forfeit:{t.id}", t.id, at)
            name_ = db.session.get(Charity, t.charity_id).name
            done.append((t, at, f'Missed "{name}" — ${stake:.2f} sent to {name_}', "penalty", "💸"))
        elif status == "bailed":
            t.bailed_at = at - 40 * 60000
            done.append((t, t.bailed_at, f'Bailed out of "{name}" · ${stake:.2f} stake kept', "bail", "🎫"))
        return t

    past("h1", "Stretch break", E[6], 5, 3 * H, "completed")
    past("h1b", "Take your vitamins", E[7], 5, 7 * H, "completed")
    past("h2", "Morning run", E[5], 5, 1 * D + 2 * H, "completed")
    past("h2b", "Plan tomorrow", E[2], 5, 1 * D + 9 * H, "completed")
    past("h3", "Study session", E[4], 5, 2 * D + 5 * H, "completed")
    past("h3b", "Language practice", E[4], 5, 2 * D + 10 * H, "completed", attempt=2, won_back=True)
    past("h4", "Meal prep", E[1], 10, 3 * D + 1 * H, "failed", "ocean")
    past("h4b", "Laundry and reset", E[3], 5, 3 * D + 8 * H, "bailed")
    past("h5", "Gym visit", E[0], 10, 4 * D + 4 * H, "completed")
    past("h5b", "Brisk walk", E[5], 5, 4 * D + 11 * H, "completed")
    past("h6", "Read 20 pages", E[4], 5, 5 * D + 6 * H, "completed")
    past("h6b", "Sketch for 30 minutes", E[8], 5, 5 * D + 12 * H, "completed")
    past("h6c", "Yoga or stretch", E[6], 5, 6 * D + 3 * H, "completed")
    past("h6d", "Fresh air break", E[9], 5, 6 * D + 9 * H, "completed")
    past("h7", "Tidy the room", E[3], 5, 8 * D + 2 * H, "failed", "food")
    past("h8", "Cook dinner", E[1], 5, 9 * D + 3 * H, "completed")
    past("h9", "Deep work block", E[2], 10, 11 * D + 1 * H, "completed")

    def running(name, icon, stake, created_ago, duration, deadline_in, by_date=False):
        t = Task(id=str(uuid.uuid4()), user_id=user.id, name=name, icon=icon, status="active", by_date=by_date, stake_cents=stake * 100,
                 charity_id="ocean", created_at=now - created_ago, deadline_at=now + deadline_in, duration_ms=duration)
        db.session.add(t)
        db.session.flush()
        ledger.transfer(wallet, escrow, t.stake_cents, f"stake:{t.id}", t.id, now)

    running("Morning workout", E[0], 10, 20 * 60000, 45 * 60000, 25 * 60000)
    running("Cook dinner", E[1], 15, 10 * 60000, 2 * H, 110 * 60000)
    running("Work on my app", E[2], 20, 6 * H, 3 * D + 6 * H, 3 * D, by_date=True)
    running("Clean the home", E[3], 12, 5 * 60000, 7 * D, 7 * D - 5 * 60000, by_date=True)

    for t, at, text, type_, icon in sorted(done, key=lambda x: -x[1]):            # one line per result in the last week
        if now - at <= 7 * D:
            activity.add(user.id, type_, icon, text, at, t.id)
    activity.add(user.id, "funds", "💰", "Account funded with $115.00", now - 7 * D)
    db.session.flush()


def reseed_demo_if_stale(user, now):
    if user.is_demo and (user.seeded_at is None or now - user.seeded_at > DEMO_REFRESH_MS):
        seed_demo(user, now)
