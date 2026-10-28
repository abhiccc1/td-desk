from __future__ import annotations

from contextlib import asynccontextmanager

import shared.session_client as session_client
from shared.schemas.auth import SessionBundle, SessionState


class _FakePipeline:
    def __init__(self, client: _FakeRedis):
        self._client = client
        self._commands: list[tuple[str, tuple, dict]] = []

    def hincrby(self, *args, **kwargs):
        self._commands.append(("hincrby", args, kwargs))
        return self

    def hset(self, *args, **kwargs):
        self._commands.append(("hset", args, kwargs))
        return self

    def expire(self, *args, **kwargs):
        self._commands.append(("expire", args, kwargs))
        return self

    def delete(self, *args, **kwargs):
        self._commands.append(("delete", args, kwargs))
        return self

    def publish(self, *args, **kwargs):
        self._commands.append(("publish", args, kwargs))
        return self

    async def execute(self):
        for name, args, kwargs in self._commands:
            if name == "hincrby":
                self._client.version += 1
            elif name == "hset":
                self._client.mapping = dict(kwargs["mapping"])
            elif name == "delete":
                self._client.deleted_keys.extend(args)
        return []


class _FakeRedis:
    def __init__(self):
        self.version = 0
        self.mapping: dict[str, str] = {}
        self.deleted_keys: list[str] = []

    def pipeline(self) -> _FakePipeline:
        return _FakePipeline(self)

    async def hget(self, *_args, **_kwargs):
        return str(self.version)


@asynccontextmanager
async def _fake_get_redis(_redis_url: str):
    yield _fake_get_redis.client


_fake_get_redis.client = _FakeRedis()


async def test_store_session_strips_broker_credentials_from_redis(monkeypatch):
    monkeypatch.setattr(session_client, "get_redis", _fake_get_redis)

    bundle = SessionBundle(
        state=SessionState.ACTIVE,
        access_token="should-not-persist",
        sid="should-not-persist",
        base_url="https://example.com",
        server_id="server-1",
    )

    await session_client.store_session("redis://test", bundle)

    assert bundle.version == 1
    assert _fake_get_redis.client.mapping["access_token"] == ""
    assert _fake_get_redis.client.mapping["sid"] == ""
    assert "cache:auth:kotak" in _fake_get_redis.client.deleted_keys
