# FAQ: Executor Bot 自委托给自己（self-delegation）

## 症状

Dashboard 中出现 fromBot 和 toBot 相同的 sub-task，且状态一直为 Pending：

```
ceb897bf  FE → FE  sub-task  Pending
eebecb1f  AC → AC  sub-task  Pending
```

## 根因

三个因素共同导致：

1. **Executor 模版包含 DELEGATION 指令** — `task_system_prompt_executor.md` 告诉 executor bot 可以 sub-delegate 工作给其他 bot
2. **`/gateway/bots` 返回所有 bot 包括自己** — executor bot 调用 `/gateway/bots` 查看可用 bot 列表时，看到自己也在列表中
3. **API 没有 self-delegation 校验** — `delegate()` 方法不检查 `fromBotId === toBotId`

LLM 在执行任务时，如果认为需要 sub-delegate，就调用 `/gateway/bots`，看到自己，选择委托给自己 → 创建了 fromBot === toBot 的 sub-task。

## 修复

### 1. Gateway `/gateway/bots` 过滤自己

`packages/clawteam-gateway/src/gateway/gateway-proxy.ts`：

```typescript
let bots = unwrap(res.data);
if (Array.isArray(bots) && deps.clawteamBotId) {
  bots = bots.filter((b: any) => b.id !== deps.clawteamBotId && b.botId !== deps.clawteamBotId);
}
```

Bot 在查询可用 bot 列表时不会看到自己，从根源上避免 LLM 选择自己。

### 2. Executor 模版加 self-delegation 警告

`packages/openclaw-plugin/task_system_prompt_executor.md` 的 DELEGATION 段落：

```
DELEGATION (if you need to sub-delegate part of the work):
  NEVER delegate to yourself. You must pick a DIFFERENT bot.
  curl -s {{GATEWAY_URL}}/gateway/bots
```

## 相关文件

- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` — `/gateway/bots` 路由
- `packages/openclaw-plugin/task_system_prompt_executor.md` — Executor 角色模版
