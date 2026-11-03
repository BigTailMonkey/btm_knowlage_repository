"""Database bootstrap and session management."""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def configure(database_url: str | None = None):
    """（Re)bind the engine. Used by the app factory and tests."""
    global _engine, _SessionLocal
    url = database_url or settings.database_url
    if _engine is not None:
        _engine.dispose()
    if url.startswith("sqlite:///"):
        db_path = Path(url.replace("sqlite:///", "", 1))
        db_path.parent.mkdir(parents=True, exist_ok=True)
    kwargs = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        kwargs["pool_pre_ping"] = True
    _engine = create_engine(url, **kwargs)
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def get_engine():
    if _engine is None:
        configure()
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    if _SessionLocal is None:
        configure()
    return _SessionLocal  # type: ignore[return-value]


def SessionLocal() -> Session:
    return get_session_factory()()


def init_db(seed: bool = True):
    Base.metadata.create_all(bind=get_engine())
    if seed:
        from .seed import seed_if_empty

        with SessionLocal() as db:
            seed_if_empty(db)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
