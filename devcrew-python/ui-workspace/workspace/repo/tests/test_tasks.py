from src.tasks import add_task, list_tasks


def test_add_and_list():
    add_task('write docs')
    assert 'write docs' in list_tasks()
