# Source Card Miner Implementation Log

## 2026-05-12 Session Source Miner MVP

实现目标：把指定历史 session 或当前 session 的已有 trace/run.log/messages/artifacts
提炼成 Source Card Draft，保持显式触发、草稿优先、候选卡需确认、安全脱敏。

## 已实现

- 新增 `SessionSourceMiner`：
  - 输入明确 `sessionId`。
  - 只读取既有 session evidence：messages、trace entries、run.log、已引用 artifact。
  - 通过启发式识别 source kind、adapter mode、capabilities、schema keys、privacy、
    credential binding 迹象。
  - 输出 `SourceCardDraft`，包含 `proposedCard`、`evidenceRefs`、`missingFields`、
    `riskFlags`、`dedupeCandidates`、`confidence`、`sourceSessionId`、`generatedAt` 和
    trigger snapshot。
- 新增 draft validation 与 candidate 创建：
  - `validateDraft()` 复用现有 Source Card validation，并补充 draft shape 和敏感材料检查。
  - `createCandidateFromDraft()` 只有在 `confirm=true` 后才写入 candidate Source Card。
  - draft 命中 dedupe candidates 时，需要显式 `dedupeDecision`；本阶段只实现 `new_card`。
- 扩展 `source_card` tool：
  - `generate_draft`
  - `validate_draft`
  - `create_candidate_from_draft`
- 新增 Web API：
  - `POST /api/source-card-drafts`
  - `POST /api/source-card-drafts/validate`
  - `POST /api/source-card-drafts/candidates`
- 启动 wiring：
  - `ZeroOS.sourceCardMiner`
  - `SourceCardTool(sourceCardService, sourceCardMiner)`

## 安全边界

- 不做后台定时扫描。
- 不执行 CLI/API/browser/fetch。
- 不做 health probe。
- 不读取新的邮箱正文、附件或真实股票数据。
- 不自动 promote，不创建 active Source Card。
- Draft 和 candidate API/tool 输出会脱敏 token/cookie/password/authorization、
  `credentialRef`、`credentialLeaseId`、`vault://`、`external:` 等凭证材料。
- private/restricted draft 默认 metadata-only，attachments blocked。

## 后续建议

- 后续如果支持 append adapter revision/evidence，应作为单独审批动作实现，不复用
  candidate 创建路径。
- 可以在 UI 中增加 Source Card Draft reviewer 页面，展示 evidence refs、missing fields、
  risk flags、dedupe choices 和 candidate 确认按钮。

## 2026-05-12 Session Source Miner Hardening

审查修复目标：保持 Session Source Miner MVP 的既有方向不变，同时加固 candidate
创建准入和 private/restricted evidence 摘要。

## 修复点

- candidate 创建时服务端重新计算 dedupe：
  - `createCandidateFromDraft()` 不再信任请求体里的 `draft.dedupeCandidates`。
  - 准入判断基于当前 `SourceCardManager.list()` 重新匹配已有 Source Card。
  - 当前存在 dedupe candidates 时仍必须传入 `dedupeDecision`。
  - MVP 仍只允许 `dedupeDecision: new_card` 写入 candidate。
  - `append_adapter_revision` 和 `append_evidence` 继续返回 not implemented。
  - `proposedCard.id` 已存在时仍直接拒绝。
- private/restricted evidence summary 改为 metadata-only：
  - 不再回显正文、附件内容、raw payload 或任意历史私密文本片段。
  - 只输出 evidence source、tool use/tool result/schema keys/endpoint signal/CLI signal/redaction
    这类元数据级信号。
  - public source draft 继续保留较有用的摘要，但仍经过凭证/密钥脱敏。

## 保持不变的边界

- 不做后台扫描。
- 不做 health probe。
- 不执行 CLI/API/browser/fetch。
- 不运行 `himalaya`。
- 不读取新的邮箱正文或附件。
- 不拉取真实股票数据。
- 不新增 `SourceResolver` 或 `source_query`。
- 不自动 promote，不创建 active Source Card。
