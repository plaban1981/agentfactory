"""In-memory task store."""

_tasks: list[str] = []


def add_task(title: str) -> None:
    _tasks.append(title)


def delete_task(title: str) -> None:
    if title in _tasks:
        _tasks.remove(title)


def list_tasks() -> list[str]:
    return list(_tasks)
