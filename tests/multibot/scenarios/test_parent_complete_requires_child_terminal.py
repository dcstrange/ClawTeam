"""
Scenario: parent_complete_requires_child_terminal

Guardrail for recursive collaboration:
1) Parent task cannot be finalized while it has active child tasks.
2) Delegator may explicitly override with force=true.
"""

import pytest
import requests

from simbot import FixedStrategy, SimBot


@pytest.fixture
def delegator(api_url):
    bot = SimBot(
        name="S9-Delegator",
        email="s9-delegator@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Task coordination", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def parent_executor(api_url):
    bot = SimBot(
        name="S9-Parent-Executor",
        email="s9-parent-executor@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def child_executor(api_url):
    bot = SimBot(
        name="S9-Child-Executor",
        email="s9-child-executor@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def _create_parent_with_active_child(
    api_url: str,
    delegator: SimBot,
    parent_executor: SimBot,
    child_executor: SimBot,
) -> tuple[str, str]:
    create_resp = requests.post(
        f"{api_url}/api/v1/tasks/create",
        json={
            "prompt": "Coordinate child tasks and finalize when all done",
            "capability": "general",
            "parameters": {},
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert create_resp.status_code == 201, create_resp.text
    parent_task_id = create_resp.json()["data"]["taskId"]

    delegate_parent = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/delegate",
        json={"toBotId": parent_executor.bot_id},
        headers=delegator._headers(),
        timeout=10,
    )
    assert delegate_parent.status_code == 200, delegate_parent.text

    parent_executor.accept_task(parent_task_id, executor_session_key=parent_executor.generate_session_key())

    delegate_child = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/delegate",
        json={
            "toBotId": child_executor.bot_id,
            "subTaskPrompt": "Implement child output for parent aggregation",
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert delegate_child.status_code == 200, delegate_child.text
    child_task_id = delegate_child.json()["data"]["taskId"]

    child_executor.accept_task(child_task_id, executor_session_key=child_executor.generate_session_key())

    return parent_task_id, child_task_id


def test_parent_complete_blocked_until_children_terminal(
    api_url: str,
    delegator: SimBot,
    parent_executor: SimBot,
    child_executor: SimBot,
):
    parent_task_id, child_task_id = _create_parent_with_active_child(
        api_url=api_url,
        delegator=delegator,
        parent_executor=parent_executor,
        child_executor=child_executor,
    )

    blocked = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/complete",
        json={"status": "completed", "result": {"summary": "premature finalize"}},
        headers=delegator._headers(),
        timeout=10,
    )
    assert blocked.status_code == 409, blocked.text
    blocked_payload = blocked.json()
    assert blocked_payload["success"] is False
    assert blocked_payload["error"]["code"] == "PENDING_CHILD_TASKS"

    child_done = requests.post(
        f"{api_url}/api/v1/tasks/{child_task_id}/complete",
        json={"status": "completed", "result": {"summary": "child done"}},
        headers=delegator._headers(),
        timeout=10,
    )
    assert child_done.status_code == 200, child_done.text

    parent_done = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/complete",
        json={"status": "completed", "result": {"summary": "all child tasks settled"}},
        headers=delegator._headers(),
        timeout=10,
    )
    assert parent_done.status_code == 200, parent_done.text


def test_parent_complete_force_can_override_child_gate(
    api_url: str,
    delegator: SimBot,
    parent_executor: SimBot,
    child_executor: SimBot,
):
    parent_task_id, _child_task_id = _create_parent_with_active_child(
        api_url=api_url,
        delegator=delegator,
        parent_executor=parent_executor,
        child_executor=child_executor,
    )

    forced = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/complete",
        json={
            "status": "completed",
            "force": True,
            "result": {"summary": "forced finalize despite active child"},
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert forced.status_code == 200, forced.text
