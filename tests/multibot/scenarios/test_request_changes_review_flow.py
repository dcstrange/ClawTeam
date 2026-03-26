"""
Scenario: request_changes_review_flow

End-to-end regression guardrails:
1) pending_review supports a third review action: request-changes.
2) request-changes reopens execution (pending_review -> processing) with feedback.
3) dashboard public request-changes bypass is forbidden.
"""

import requests
import pytest

from simbot import FixedStrategy, SimBot


@pytest.fixture
def delegator(api_url):
    bot = SimBot(
        name="S10-Delegator",
        email="s10-delegator@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Task mgmt", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def executor(api_url):
    bot = SimBot(
        name="S10-Executor",
        email="s10-executor@test.com",
        capabilities=[{"name": "general", "description": "General execution", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def _as_dict(content):
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            import json
            parsed = json.loads(content)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def test_pending_review_request_changes_flow(api_url: str, delegator: SimBot, executor: SimBot):
    delegated = delegator.delegate_task(
        to_bot_id=executor.bot_id,
        prompt="Write a concise implementation summary",
        capability="general",
        parameters={},
        task_type="new",
    )
    task_id = delegated["data"]["taskId"]

    executor.accept_task(task_id, executor_session_key=executor.generate_session_key())

    submit_v1 = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/submit-result",
        json={"result": {"summary": "v1 output"}},
        headers=executor._headers(),
        timeout=10,
    )
    assert submit_v1.status_code == 200, submit_v1.text

    # Non-delegator cannot request changes.
    unauthorized_request_changes = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/request-changes",
        json={"feedback": "please revise"},
        headers=executor._headers(),
        timeout=10,
    )
    assert unauthorized_request_changes.status_code == 403, unauthorized_request_changes.text
    unauthorized_payload = unauthorized_request_changes.json()
    assert unauthorized_payload["success"] is False
    assert unauthorized_payload["error"]["code"] == "UNAUTHORIZED_TASK"

    # Dashboard bypass must remain blocked.
    bypass_request_changes = requests.post(
        f"{api_url}/api/v1/tasks/all/{task_id}/request-changes",
        json={"feedback": "bypass attempt"},
        timeout=10,
    )
    assert bypass_request_changes.status_code == 403, bypass_request_changes.text
    bypass_payload = bypass_request_changes.json()
    assert bypass_payload["success"] is False
    assert bypass_payload["error"]["code"] == "DELEGATOR_PROXY_REQUIRED"

    feedback = "Please add edge-case handling and resubmit."
    request_changes = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/request-changes",
        json={"feedback": feedback},
        headers=delegator._headers(),
        timeout=10,
    )
    assert request_changes.status_code == 200, request_changes.text
    request_changes_payload = request_changes.json()
    assert request_changes_payload["success"] is True
    assert request_changes_payload["data"]["status"] == "processing"
    assert request_changes_payload["data"]["reviewAction"] == "changes_requested"

    task_after_request_changes = delegator.get_task(task_id).get("data", {})
    assert task_after_request_changes["status"] == "processing"
    assert task_after_request_changes["rejectionReason"] == feedback

    # Executor should receive explicit changes_requested review event.
    inbox = executor.poll_inbox(limit=20)
    change_msgs = [
        m for m in inbox
        if m.get("taskId") == task_id
        and _as_dict(m.get("content")).get("reviewAction") == "changes_requested"
    ]
    assert change_msgs, "executor inbox must include changes_requested review event"
    assert _as_dict(change_msgs[0].get("content")).get("changeRequest") == feedback

    # Executor revises and re-submits, then delegator approves.
    submit_v2 = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/submit-result",
        json={"result": {"summary": "v2 output with edge cases"}},
        headers=executor._headers(),
        timeout=10,
    )
    assert submit_v2.status_code == 200, submit_v2.text

    approve = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/approve",
        json={},
        headers=delegator._headers(),
        timeout=10,
    )
    assert approve.status_code == 200, approve.text

    final_task = delegator.get_task(task_id).get("data", {})
    assert final_task["status"] == "completed"
    assert (final_task.get("result") or {}).get("summary") == "v2 output with edge cases"


def test_submit_result_forbidden_on_self_assigned_task(api_url: str, delegator: SimBot):
    # Create + delegate-to-self through API server path to simulate misconfigured flow.
    create_resp = requests.post(
        f"{api_url}/api/v1/tasks/create",
        json={
            "prompt": "Self-assigned task should not enter review flow",
            "capability": "general",
            "parameters": {},
        },
        headers=delegator._headers(),
        timeout=10,
    )
    assert create_resp.status_code == 201, create_resp.text
    task_id = create_resp.json()["data"]["taskId"]

    delegate_self = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/delegate",
        json={"toBotId": delegator.bot_id},
        headers=delegator._headers(),
        timeout=10,
    )
    assert delegate_self.status_code == 200, delegate_self.text

    delegator.accept_task(task_id, executor_session_key=delegator.generate_session_key())

    submit_self = requests.post(
        f"{api_url}/api/v1/tasks/{task_id}/submit-result",
        json={"result": {"summary": "self submitted final"}},
        headers=delegator._headers(),
        timeout=10,
    )
    assert submit_self.status_code == 409, submit_self.text
    payload = submit_self.json()
    assert payload["success"] is False
    assert payload["error"]["code"] == "SELF_REVIEW_FORBIDDEN"

    task_after = delegator.get_task(task_id).get("data", {})
    assert task_after["status"] == "processing"
