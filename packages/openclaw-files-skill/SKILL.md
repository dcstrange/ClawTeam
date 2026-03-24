---
name: clawteam-files
description: Manage task artifacts and cloud files in ClawTeam via Gateway File APIs
metadata: {"openclaw": {"primaryEnv": "CLAWTEAM_GATEWAY_URL", "homepage": "https://github.com/clawteam/clawteam-platform"}}
user-invocable: true
---

# ClawTeam Files Skill

Use this skill for file and artifact operations in ClawTeam.

It is the companion skill for `clawteam` (core delegation/collaboration skill).
When a task mentions attachments, uploaded files, cloud space, workspace files, or artifact IDs,
use this skill first.

First action for file-related tasks: list task files and resolve node IDs explicitly.

## Gateway URL

All requests go through Gateway:

```bash
GATEWAY=http://localhost:3100
```

## Scope Rules (must follow)

- Prefer task-scoped routes: `/gateway/tasks/<taskId>/files/*`
- Do not assume uploaded files exist in local OS workspace
- Executor submit-result must reference `artifactNodeIds`
- Only delegator chain can publish task outputs to `team_shared`

## Core Operations

### 0. Bootstrap (required for attachment tasks)

```bash
curl -s "$GATEWAY/gateway/tasks/<taskId>/files"
```

If the task mentions a filename (for example `snake-game.html`), find its node ID from this list before doing any local search.

### 1. List task files

```bash
curl -s "$GATEWAY/gateway/tasks/<taskId>/files"
```

### 2. Find file node by name

```bash
curl -s "$GATEWAY/gateway/tasks/<taskId>/files" \
  | jq -r '.data.items[] | select(.name=="snake-game.html") | .id'
```

### 3. Read artifact content

Doc artifact:

```bash
curl -s "$GATEWAY/gateway/tasks/<taskId>/files/docs/<docId>/raw"
```

Binary/file artifact as JSON base64:

```bash
curl -s "$GATEWAY/gateway/tasks/<taskId>/files/download/<nodeId>?format=json"
```

### 4. Create artifacts

Create doc:

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/files/docs" \
  -H 'Content-Type: application/json' \
  -d '{"title":"analysis.md","content":"YOUR_OUTPUT"}'
```

Upload file:

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/files/upload" \
  -H 'Content-Type: application/json' \
  -d '{"name":"result.txt","mimeType":"text/plain","contentBase64":"<BASE64>"}'
```

### 5. Move / copy / delete

Move:

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/files/move" \
  -H 'Content-Type: application/json' \
  -d '{"nodeId":"<nodeId>","targetParentId":"<folderId>"}'
```

Copy:

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/files/copy" \
  -H 'Content-Type: application/json' \
  -d '{"sourceNodeId":"<nodeId>","targetParentId":"<folderId>"}'
```

Delete:

```bash
curl -s -X DELETE "$GATEWAY/gateway/tasks/<taskId>/files/<nodeId>"
```

### 6. Publish to team_shared (delegator only)

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/files/publish" \
  -H 'Content-Type: application/json' \
  -d '{"sourceNodeId":"<nodeId>"}'
```

## Handoff to submit-result

After creating artifacts, submit through core skill route:

```bash
curl -s -X POST "$GATEWAY/gateway/tasks/<taskId>/submit-result" \
  -H 'Content-Type: application/json' \
  -d '{"result":{"summary":"Final output","artifactNodeIds":["<nodeId>"]}}'
```

If executor cannot find a file, do not keep searching local workspace blindly.
First list task files with this skill and resolve node IDs explicitly.
