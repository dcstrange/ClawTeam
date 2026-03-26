"""
Scenario: multi_participant_collaboration

Regression guardrails for dashboard-created multi-participant collaboration tasks:
1) strict participant roster limits delegate/sub-delegate targets
2) parent collaboration roster is inherited by sub-tasks
"""

import requests
import pytest

from simbot import SimBot, FixedStrategy


@pytest.fixture
def delegator(api_url):
    bot = SimBot(
        name="S8-Delegator",
        email="s8-delegator@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Task mgmt", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def executor_a(api_url):
    bot = SimBot(
        name="S8-Executor-A",
        email="s8-exec-a@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def executor_b(api_url):
    bot = SimBot(
        name="S8-Executor-B",
        email="s8-exec-b@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def outsider(api_url):
    bot = SimBot(
        name="S8-Outsider",
        email="s8-outsider@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def test_multi_participant_scope_and_inheritance(
    api_url: str,
    delegator: SimBot,
    executor_a: SimBot,
    executor_b: SimBot,
    outsider: SimBot,
):
    participant_ids = [executor_a.bot_id, executor_b.bot_id]
    participant_bots = [
        {"botId": executor_a.bot_id, "botName": "A", "botOwner": executor_a.email},
        {"botId": executor_b.bot_id, "botName": "B", "botOwner": executor_b.email},
    ]

    create_resp = requests.post(
        f"{api_url}/api/v1/tasks/create",
        json={
            "prompt": "Coordinate between multiple bots and produce final output",
            "capability": "general",
            "parameters": {
                "collaboration": {
                    "mode": "delegator_multi_participants",
                    "strictParticipantScope": True,
                    "participantBotIds": participant_ids,
                    "participantBots": participant_bots,
                },
                "delegateIntent": {
                    "toBotId": executor_a.bot_id,
                    "participantBotIds": participant_ids,
                    "participantBots": participant_bots,
                    "source": "test_multi_participant_collaboration",
                },
            },
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert create_resp.status_code == 201, create_resp.text
    task_id = create_resp.json()["data"]["taskId"]

    direct_delegate = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/delegate",
        json={"toBotId": executor_a.bot_id},
        headers=delegator._headers(),
        timeout=10,
    )
    assert direct_delegate.status_code == 200, direct_delegate.text

    executor_a.accept_task(task_id, executor_session_key=executor_a.generate_session_key())

    sub_delegate_ok = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/delegate",
        json={
            "toBotId": executor_b.bot_id,
            "subTaskPrompt": "Implement a focused sub-task result",
        },
        headers=executor_a._headers(),
        timeout=10,
    )
    assert sub_delegate_ok.status_code == 200, sub_delegate_ok.text
    child_task_id = sub_delegate_ok.json()["data"]["taskId"]

    child_task = executor_a.get_task(child_task_id).get("data", {})
    child_params = child_task.get("parameters", {})
    child_collab = child_params.get("collaboration", {})
    inherited_ids = set(child_collab.get("participantBotIds", []))
    assert set(participant_ids).issubset(inherited_ids)
    assert child_collab.get("strictParticipantScope") is True

    sub_delegate_blocked = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/delegate",
        json={
            "toBotId": outsider.bot_id,
            "subTaskPrompt": "Attempt outside participant roster",
        },
        headers=executor_a._headers(),
        timeout=10,
    )
    assert sub_delegate_blocked.status_code == 400, sub_delegate_blocked.text
    blocked_payload = sub_delegate_blocked.json()
    assert blocked_payload["success"] is False
    assert "outside collaboration participant roster" in blocked_payload["error"]["message"]

