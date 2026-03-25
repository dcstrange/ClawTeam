# 2026-03-25 — file-service 分支设计与实现汇总

## 概述

本分支在 `debug_0318` 修复基础上，重点推进了三条主线：

1. **File Service 从“能力补丁”升级为“协作主通道”**（API/Gateway/Skill/Dashboard 全链路）
2. **任务协作闭环强化**（子任务产物镜像、审批与人类介入链路收敛）
3. **Dashboard 可用性与可读性重构**（Task 详情、Activity/History、Cloud Files、i18n、深浅色视觉优化）

## 关键设计沉淀

### 1) 文件协作模型

- 新增并启用独立 skill：`packages/openclaw-files-skill/SKILL.md`，与 `openclaw-skill` 职责拆分：
  - `openclaw-skill` 负责任务协作原语（delegate/ask/review）
  - `openclaw-files-skill` 负责文件读写、上传、发布、下载
- File Service 保持三层 scope：`bot_private` / `task` / `team_shared`，并继续默认私有、发布到共享的治理模型。
- Gateway 增补并统一 `/gateway/tasks/:taskId/files/*` 与 `/gateway/files/*` 代理族，覆盖 folders/docs/upload/download/move/copy/publish/delete/get。

### 2) 子任务产物与父任务可见性

- 新增规则：**子任务审批通过后，产物自动镜像到父任务文件空间**。
- 目标：避免“产物只留在子任务，父任务不可见”导致交付断链。
- 回归脚本：`tests/multibot/scenarios/test_subtask_artifact_sync.py`。

### 3) 任务协作约束继续收敛

- 委托/子委托、审批代理链、身份校验、need-human-input 与 pending_review 冲突纠偏等设计在本分支持续固化。
- Dashboard 直连 approve/reject 继续保持禁用，审批入口保持 delegator bot 代理链原则。

### 4) Dashboard 设计重构

- Task Detail：
  - Activity Tree/Message History 语义重做（人类介入标识、审批状态表达、侧边详情交互）
  - Task Files 卡片增强（move/copy/delete、子任务/父任务镜像可见性说明）
  - 支持下载任务历史（Activity Tree 导出）
- Tasks 页面：
  - 信息层级降噪（筛选侧栏 + 主内容区）
  - 列表/看板信息密度重排
  - 视觉动效、深色模式对比度与排版优化
- Cloud Files：
  - 新增独立云文件页面，支持 private/public/team/task 四视图
  - 支持批量选择下载、ZIP 打包、路径结构预览后确认下载

### 5) i18n 一体化

- Dashboard 主要页面与组件统一接入中英切换与术语映射（`term('task')` 等）。

## 本分支新增/强化的设计约定（摘要）

- 子任务不是“临时分叉”，而是完整 task 实体，必须独立追踪与可审计。
- 执行者提交结果不直接面向 dashboard 人工审批，必须经 delegator 代理链。
- 文件默认私有，团队共享通过 publish 显式升级。
- 子任务产物经审批后向父任务镜像，确保最终交付可见性。
- 批量下载在前端打包 ZIP，且按路径信息还原目录结构，预览与实际打包路径一致。

## 涉及模块（按层）

- API：
  - `packages/api/src/file-service/routes.ts`
  - `packages/api/src/task-coordinator/completer.ts`
  - `packages/api/src/messages/routes.ts`
- Gateway：
  - `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`
  - `packages/clawteam-gateway/src/gateway/response-formatter.ts`
- Skills/Plugin：
  - `packages/openclaw-skill/SKILL.md`
  - `packages/openclaw-files-skill/SKILL.md`
  - `packages/openclaw-plugin/task_system_prompt_sender.md`
  - `packages/openclaw-plugin/task_system_prompt_executor.md`
- Dashboard：
  - `packages/dashboard/src/pages/*`
  - `packages/dashboard/src/components/*`
  - `packages/dashboard/src/lib/i18n.tsx`
  - `packages/dashboard/src/lib/file-download.ts`

## 建议回归集（最小）

1. 子任务审批通过后父任务可见产物（镜像）
2. Dashboard Task Files/Cloud Files 的 ZIP 预览与下载路径一致
3. approve/reject 代理链不被 dashboard 旁路
4. pending_review + need-human-input 冲突自动纠偏仍可恢复推进
