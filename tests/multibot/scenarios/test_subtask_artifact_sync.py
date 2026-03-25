"""
Scenario: subtask_artifact_sync

Goal:
- A child task artifact should be mirrored into parent task file scope after child approval.
- Root delegator should see child artifact from parent Task Files view.
- Direct child task file listing by non-participant should remain forbidden.
"""

import base64

import pytest
import requests

from simbot import SimBot, FixedStrategy


@pytest.fixture
def root_delegator(api_url):
    bot = SimBot(
        name="S8-Root-Delegator",
        email="s8-root@test.com",
        capabilities=[{"name": "manage_tasks", "description": "Root delegator", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def parent_executor(api_url):
    bot = SimBot(
        name="S8-Parent-Executor",
        email="s8-parent-executor@test.com",
        capabilities=[{"name": "general", "description": "Parent executor", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


@pytest.fixture
def child_executor(api_url):
    bot = SimBot(
        name="S8-Child-Executor",
        email="s8-child-executor@test.com",
        capabilities=[{"name": "general", "description": "Child executor", "parameters": {}, "async": False, "estimatedTime": "5s"}],
        strategy=FixedStrategy({"general": {"ok": True}}),
        api_url=api_url,
    )
    bot.register()
    return bot


def _upload_text_artifact(api_url: str, bot: SimBot, task_id: str, file_name: str, content: str) -> str:
    payload = {
        "name": file_name,
        "mimeType": "text/x-python",
        "contentBase64": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
        "scope": "task",
        "scopeRef": task_id,
    }
    resp = requests.post(
        f"{api_url}/api/v1/files/upload",
        json=payload,
        headers=bot._headers(),
        timeout=10,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]["node"]["id"]


def test_subtask_artifact_is_mirrored_to_parent_scope(
    api_url: str,
    root_delegator: SimBot,
    parent_executor: SimBot,
    child_executor: SimBot,
):
    # Parent task: Root -> ParentExecutor
    parent_task = root_delegator.delegate_task(
        to_bot_id=parent_executor.bot_id,
        prompt="Parent task that will spawn one sub-task",
        capability="general",
        parameters={},
        task_type="new",
    )
    parent_task_id = parent_task["data"]["taskId"]

    parent_executor.accept_task(parent_task_id, executor_session_key=parent_executor.generate_session_key())

    # Parent executor writes one parent-scoped artifact (decimal_to_binary.py)
    parent_artifact_node_id = _upload_text_artifact(
        api_url=api_url,
        bot=parent_executor,
        task_id=parent_task_id,
        file_name="decimal_to_binary.py",
        content="print('parent artifact')\n",
    )

    # Sub-task: ParentExecutor -> ChildExecutor
    sub_task = parent_executor.delegate_task(
        to_bot_id=child_executor.bot_id,
        prompt="Write binary to decimal converter",
        capability="general",
        parameters={},
        task_type="sub-task",
        parent_task_id=parent_task_id,
    )
    sub_task_id = sub_task["data"]["taskId"]

    child_executor.accept_task(sub_task_id, executor_session_key=child_executor.generate_session_key())

    # Child executor uploads sub-task artifact (binary_to_decimal.py)
    child_artifact_node_id = _upload_text_artifact(
        api_url=api_url,
        bot=child_executor,
        task_id=sub_task_id,
        file_name="binary_to_decimal.py",
        content="print('child artifact')\n",
    )

    # Child executor submits result for review with sub-task artifact
    child_submit = requests.post(
        f"{api_url}/api/v1/tasks/{sub_task_id}/submit-result",
        json={"result": {"summary": "sub-task done", "artifactNodeIds": [child_artifact_node_id]}},
        headers=child_executor._headers(),
        timeout=10,
    )
    assert child_submit.status_code == 200, child_submit.text

    # Parent executor approves child task; this should trigger mirroring into parent task scope
    child_approve = requests.post(
        f"{api_url}/api/v1/tasks/{sub_task_id}/approve",
        json={},
        headers=parent_executor._headers(),
        timeout=10,
    )
    assert child_approve.status_code == 200, child_approve.text

    # Root delegator lists parent task files: should contain both parent + mirrored child artifact
    parent_files = requests.get(
        f"{api_url}/api/v1/files",
        params={"scope": "task", "scopeRef": parent_task_id, "limit": 200},
        headers=root_delegator._headers(json=False),
        timeout=10,
    )
    assert parent_files.status_code == 200, parent_files.text
    parent_items = parent_files.json()["data"]["items"]

    names = {item["name"] for item in parent_items}
    assert "decimal_to_binary.py" in names
    assert "binary_to_decimal.py" in names

    mirrored_item = next(item for item in parent_items if item["name"] == "binary_to_decimal.py")
    metadata = mirrored_item.get("metadata") or {}
    assert metadata.get("mirroredFromTaskId") == sub_task_id
    assert metadata.get("mirroredFromNodeId") == child_artifact_node_id
    assert metadata.get("mirroredToParentTaskId") == parent_task_id

    # Original parent artifact remains intact
    assert any(item["id"] != mirrored_item["id"] for item in parent_items if item["name"] == "decimal_to_binary.py")

    # Root delegator can read child task scope through ancestor-chain visibility.
    child_files_as_root = requests.get(
        f"{api_url}/api/v1/files",
        params={"scope": "task", "scopeRef": sub_task_id, "limit": 200},
        headers=root_delegator._headers(json=False),
        timeout=10,
    )
    assert child_files_as_root.status_code == 200, child_files_as_root.text
    child_items = child_files_as_root.json()["data"]["items"]
    child_names = {item["name"] for item in child_items}
    assert "binary_to_decimal.py" in child_names

    # But write still requires direct task participant: root delegator upload to child scope should fail.
    forbidden_upload = requests.post(
        f"{api_url}/api/v1/files/upload",
        json={
            "name": "root_should_not_write_child_scope.txt",
            "mimeType": "text/plain",
            "contentBase64": base64.b64encode(b"forbidden").decode("utf-8"),
            "scope": "task",
            "scopeRef": sub_task_id,
        },
        headers=root_delegator._headers(),
        timeout=10,
    )
    assert forbidden_upload.status_code == 403
    forbidden_payload = forbidden_upload.json()
    assert forbidden_payload["success"] is False
    assert forbidden_payload["error"]["message"] == "Actor is not task participant"

    # Sanity: original node IDs still exist in their respective scopes.
    # Parent node should still be present as uploaded by parent executor.
    assert any(item["id"] == parent_artifact_node_id for item in parent_items)
