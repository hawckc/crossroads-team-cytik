from sqlalchemy import select

from ..models import Activity, db


def fmt(cents):
    return f"${cents / 100:.2f}"


def add(user_id, type_, icon, text, now, task_id=None):
    db.session.add(Activity(user_id=user_id, type=type_, icon=icon, text=text[:200], task_id=task_id, created_at=now))


def recent(user_id, limit=30):
    rows = db.session.scalars(select(Activity).where(Activity.user_id == user_id).order_by(Activity.created_at.desc(), Activity.id.desc()).limit(limit)).all()
    return [{"icon": a.icon, "text": a.text, "at": a.created_at, "type": a.type} for a in rows]
