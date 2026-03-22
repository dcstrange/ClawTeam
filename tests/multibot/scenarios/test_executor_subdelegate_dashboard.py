"""
Scenario: executor_subdelegate_dashboard

End-to-end regression guardrails:
1) executor submit-result must carry a final non-empty result
2) dashboard public approve/reject bypass is forbidden
3) normal review path still works via delegator bot endpoint
"""

import pytest
import requests

from simbot import SimBot, FixedStrategy


@pytest.fixture
def delegator(api_url):
    bot = SimBot(
        name="S7-Delegator",
        email="s7-delegator@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Task mgmt", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def executor(api_url):
    bot = SimBot(
        name="S7-Executor",
        email="s7-executor@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def test_executor_subdelegate_dashboard_review_guardrails(api_url: str, delegator: SimBot, executor: SimBot):
    # Step 1: Delegator creates task for executor
    delegated = delegator.delegate_task(
        to_bot_id=executor.bot_id,
        prompt="Write a concise implementation summary",
        capability="general",
        parameters={},
        task_type="new",
    )
    task_id = delegated["data"]["taskId"]

    # Step 2: Executor accepts task
    executor.accept_task(task_id, executor_session_key=executor.generate_session_key())

    # Step 3: Empty/non-final submit-result is rejected
    bad_submit = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/submit-result",
        json={"result": {}},
        headers=executor._headers(),
        timeout=10,
    )
    assert bad_submit.status_code == 400
    bad_payload = bad_submit.json()
    assert bad_payload["success"] is False
    assert bad_payload["error"]["code"] == "INVALID_SUBMITTED_RESULT"

    # Step 4: Valid final submit-result succeeds
    good_submit = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/submit-result",
        json={"result": {"summary": "Final answer delivered", "outcome": "success"}},
        headers=executor._headers(),
        timeout=10,
    )
    assert good_submit.status_code == 200, good_submit.text

    # Step 5: Dashboard bypass endpoints are blocked
    bypass_approve = requests.post(
        f"{api_url}/api/v1/tasks/all/{task_id}/approve",
        json={},
        timeout=10,
    )
    assert bypass_approve.status_code == 403
    assert bypass_approve.json()["error"]["code"] == "DELEGATOR_PROXY_REQUIRED"

    bypass_reject = requests.post(
        f"{api_url}/api/v1/tasks/all/{task_id}/reject",
        json={"reason": "Bypass attempt"},
        timeout=10,
    )
    assert bypass_reject.status_code == 403
    assert bypass_reject.json()["error"]["code"] == "DELEGATOR_PROXY_REQUIRED"

    # Step 6: Delegator review path still works
    approve = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/approve",
        json={},
        headers=delegator._headers(),
        timeout=10,
    )
    assert approve.status_code == 200, approve.text

    final_task = delegator.get_task(task_id).get("data", {})
    assert final_task["status"] == "completed"
