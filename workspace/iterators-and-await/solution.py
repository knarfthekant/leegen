import asyncio
from typing import AsyncIterator, Iterable, Iterator, Protocol, TypeVar

T = TypeVar("T")


class Connection(Protocol):
    async def readline(self) -> str | None: ...
    def close(self) -> None: ...


class Peekable:
    """A sync iterator that can look one step ahead without consuming."""

    def __init__(self, items: Iterable[T]) -> None:
        raise NotImplementedError

    def __iter__(self) -> "Peekable":
        raise NotImplementedError

    def __next__(self) -> T:
        raise NotImplementedError

    def peek(self) -> T:
        raise NotImplementedError


def take(items: Iterable[T], k: int) -> Iterator[T]:
    """Yield at most k items from items, reading lazily."""
    raise NotImplementedError
    yield  # keep this a generator function


async def fair_countdown(n: int) -> AsyncIterator[int]:
    """Yield n, n-1, ..., 1, awaiting asyncio.sleep(0) before EACH item."""
    raise NotImplementedError
    yield


async def burst(n: int) -> AsyncIterator[int]:
    """Yield n, n-1, ..., 1 with no await at all. Used as the control group."""
    raise NotImplementedError
    yield


async def drain(conn: Connection) -> AsyncIterator[str]:
    """Yield stripped non-empty lines, closing conn exactly once."""
    raise NotImplementedError
    yield
