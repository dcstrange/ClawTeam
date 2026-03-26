"""
Scenario: subdelegate_executor_session_reuse

Regression guardrail:
When delegating multiple sub-tasks to the same executor under the same parent
task chain, child tasks should carry targetSessionKey so routing can reuse the
executor's existing sub-session instead of spawning a new one.
"""

import requests
import pytest

from simbot import SimBot, FixedStrategy


@pytest.fixture
def delegator(api_url):
    bot = SimBot(
        name="S9-Delegator",
        email="s9-delegator@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Task mgmt", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def executor(api_url):
    bot = SimBot(
        name="S9-Executor",
        email="s9-executor@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def test_subdelegate_reuses_executor_session_on_same_parent(
    api_url: str,
    delegator: SimBot,
    executor: SimBot,
):
    # Step 1: Create and delegate the parent task to executor
    parent_resp = delegator.delegate_task(
        to_bot_id=executor.bot_id,
        prompt="Parent task for multi-round collaboration",
        capability="general",
        parameters={},
        task_type="new",
    )
    parent_task_id = parent_resp["data"]["taskId"]

    # Step 2: Executor accepts parent with a known session key
    executor_session_key = executor.generate_session_key()
    executor.accept_task(parent_task_id, executor_session_key=executor_session_key)

    # Step 3: Create first child sub-task to same executor
    child1_resp = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/delegate",
        json={
            "toBotId": executor.bot_id,
            "subTaskPrompt": "Round 1: implement first incremental deliverable",
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert child1_resp.status_code == 200, child1_resp.text
    child1_task_id = child1_resp.json()["data"]["taskId"]

    child1_task = delegator.get_task(child1_task_id).get("data", {})
    assert child1_task.get("type") == "sub-task"
    assert child1_task.get("parentTaskId") == parent_task_id
    assert child1_task.get("parameters", {}).get("targetSessionKey") == executor_session_key

    # Step 4: Executor accepts child1 with same session key (normal in-session follow-up)
    executor.accept_task(child1_task_id, executor_session_key=executor_session_key)

    # Step 5: Create second child sub-task to same executor under same parent
    child2_resp = requests.post(
        f"{api_url}/api/v1/tasks/{parent_task_id}/delegate",
        json={
            "toBotId": executor.bot_id,
            "subTaskPrompt": "Round 2: apply requested revisions",
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert child2_resp.status_code == 200, child2_resp.text
    child2_task_id = child2_resp.json()["data"]["taskId"]

    child2_task = delegator.get_task(child2_task_id).get("data", {})
    assert child2_task.get("type") == "sub-task"
    assert child2_task.get("parentTaskId") == parent_task_id
    assert child2_task.get("parameters", {}).get("targetSessionKey") == executor_session_key
