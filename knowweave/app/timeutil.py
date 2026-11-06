"""时区换算工具。

数据库统一存储带时区的 UTC 时间，按业务时区（默认北京时间）展示与做日历分组。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from .config import settings


def local_zone() -> ZoneInfo:
    return ZoneInfo(settings.timezone)


def now_local() -> datetime:
    return datetime.now(local_zone())


def today_local() -> date:
    return now_local().date()


def to_local(value: datetime) -> datetime:
    """SQLite 等驱动读出的时间可能丢失时区，按 UTC 解释后再换到业务时区。"""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(local_zone())
