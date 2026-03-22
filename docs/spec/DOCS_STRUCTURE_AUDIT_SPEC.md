# 文档结构审计与目标架构 Spec

> 审计日期：2026-03-22  
> 审计范围：`docs/` 全目录（66 个文件，含 API、架构、Gateway、Task 操作、FAQ、references、openclaw 方案）

## 1. 结论摘要

当前 `docs/` **信息丰富但结构不够“规范化”**，对人类可读性尚可，对 LLM 检索不够友好，主要问题是：

- 规范文档与历史方案混放
- 同一主题存在多版本表述，且部分内容与代码已不一致
- 入口文档存在失效链接与失真导航
- 文件命名与目录命名不统一（含 typo 与带空格目录）

总体评估：

- 可读性：`B`
- 可维护性：`C+`
- LLM 可检索性：`C`
- 代码一致性：`C`

## 2. 主要发现（含证据）

### F1. 顶层入口存在失效链接

- `docs/README.md` 指向不存在文件：
- `design/V2_REQUIREMENTS.md`
- `design/DEVELOPMENT_PLAN.md`
- `archive/`

影响：LLM 进入错误路径后会“补全想象”，降低回答准确性。

### F2. 关键流程存在“新旧语义混杂”

在多份文档中仍出现旧流程关键字：

- `POST /api/v1/tasks/:taskId/start`
- `POST /delegate-intent`（Router API 旧入口）
- `[CLAWTEAM_META]`、`_clawteam_*`（旧插件注入约定）

但当前代码已采用新语义：

- `accept` 直接进入 `processing`
- inbox 驱动的 `/:taskId/delegate-intent`
- `<!--CLAWTEAM:...-->` token + curl `sessionKey` 注入

### F3. 同主题文档重复，且“权威来源”不清晰

例：任务路由同时出现在以下目录：

- `docs/architecture/ROUTING_LAYER.md`
- `docs/Gateway/TaskRouter.md`
- `docs/task-operations/ROUTING.md`

问题：三者并未明确主从关系，检索时容易命中过时片段。

### F4. 历史调研与实施规范未隔离

- `docs/references/` 与 `docs/openclaw session_spawn扩展方案/` 包含大量“方案讨论/对比/历史实现”
- 但未被明确标注为 `Historical` 或 `非规范`

影响：LLM 容易把历史方案当作当前实现。

### F5. 命名不一致影响检索召回与路径稳定性

- `docs/Gateway/api_endopint.md`（endpoint 拼写错误）
- `docs/openclaw session_spawn扩展方案/`（目录名含空格）
- 中英文命名风格混用、同义词路径分散

影响：关键词检索、脚本化处理、向量切片聚类效果下降。

### F6. 大文档过长，缺乏检索友好分块

多个文档超过 15KB~35KB（如 `TYPESCRIPT_INTERFACES.md`、`OVERVIEW.md`、`PRIMITIVE_SYSTEM_AUDIT.md`），适合阅读但不利于精确检索与上下文预算控制。

## 3. 目标信息架构（IA）

本仓库建议采用三层结构，不强制立即迁移原文档：

- `Spec Hub`（本目录 `docs/spec/`）：唯一检索入口、规范约束、主题映射、机器清单
- `Domain Docs`（现有业务目录）：按领域维护内容
- `Historical`（现有 references 与方案目录）：明确“仅背景参考”

建议语义分层：

- `Tier A`：Canonical（规范/契约）
- `Tier B`：Operational（流程/排障）
- `Tier C`：Historical（历史/探索）

## 4. 规范化改造原则

### P1. 先“标注分层”，再“迁移文件”

优先通过 manifest 与索引定义权威关系，而不是立即大规模改路径。

### P2. 文档冲突按统一优先级处理

`Code > Tier A > Tier B > Tier C`

### P3. 每个主题必须有“唯一主入口”

例如：

- 任务生命周期主入口：`docs/task-operations/README.md`
- Gateway 端点主入口：`docs/Gateway/api_endopint.md`（后续建议更名）
- LLM 检索主入口：`docs/spec/README.md`

### P4. 文档元数据可机器消费

新增 `retrieval-manifest.yaml`，为每个文档标注：

- `doc_type`
- `tier`
- `status`
- `tags`
- `code_sources`
- `keywords`

## 5. 近期执行清单（建议）

### Phase 1（已在本次变更落地）

- 建立 `docs/spec/` 入口
- 输出结构审计 Spec
- 输出 LLM 检索 Spec
- 输出 machine-readable manifest

### Phase 2（建议下一步）

- 修复 `docs/README.md` 全部失效链接
- 将 `api_endopint.md` 更名为 `api_endpoint.md` 并保留兼容跳转说明
- 在 `references/` 与 `openclaw session_spawn扩展方案/` 顶部增加 `Historical` 标识

### Phase 3（建议中期）

- 将超长文档拆分为“总览 + 子专题”
- 关键规范文档引入统一 front-matter（`status`, `last_verified`）
- 建立文档一致性 CI（失效链接 + 关键词冲突扫描）

## 6. LLM 检索建议（执行层）

当问答涉及高风险语义（状态机、权限、恢复、会话绑定）时：

1. 先看 `docs/spec/LLM_RETRIEVAL_SPEC.md` 选路
2. 再读对应主题文档
3. 最后用代码文件做一致性确认

不建议仅基于 `references/` 或历史方案目录直接回答实现问题。
