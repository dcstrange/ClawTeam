# ClawTeam Spec Hub（LLM 检索入口）

> 目标：把 `docs/` 从“资料集合”整理为“可检索、可追责、可维护”的规范入口。  
> 使用场景：开发决策、联调排障、LLM 检索增强、文档持续治理。

## 使用方式（推荐顺序）

1. 先读 [LLM 检索规范](./LLM_RETRIEVAL_SPEC.md)
2. 再读 [文档结构审计与目标架构](./DOCS_STRUCTURE_AUDIT_SPEC.md)
3. 需要程序化检索时读取 [retrieval-manifest.yaml](./retrieval-manifest.yaml)

## 文档分级规则

- `Tier A / Canonical`：规范性文档；发生冲突时优先级最高。
- `Tier B / Operational`：操作手册、排障指南；服务执行与排查。
- `Tier C / Historical`：方案探索、调研记录；仅作背景参考，不作为实现依据。

## 冲突处理规则

1. `Code > Tier A > Tier B > Tier C`
2. 若文档与代码冲突，以代码为准，并记录文档修订任务。
3. 涉及任务状态机、路由判定、权限校验、会话绑定时，必须交叉验证代码实现。

## 当前建议的主入口

- 协作强约束：`docs/协作原则.md`
- 任务执行与状态：`docs/task-operations/`
- Gateway 代理与路由：`docs/Gateway/`（注意部分文件存在历史内容）
- 代码级权威来源：
  - `packages/api/src/task-coordinator/routes/index.ts`
  - `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`
  - `packages/clawteam-gateway/src/server/router-api.ts`
  - `packages/clawteam-gateway/src/routing/router.ts`
  - `packages/openclaw-plugin/index.ts`
