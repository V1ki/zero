# Memory 使用反馈回路

记忆检索此前只有"向量相似 + 新近度衰减"两个信号,记忆被使用得多少对排序零影响。
本文描述 2026-08 引入的使用反馈回路:采集"这条记忆真的被用到了"的信号,
以小权重并入检索评分,并为后续治理回路(淘汰持续无用的记忆)预留数据。

## 架构总览

```
信号采集                    统计存储                     消费
─────────                  ─────────                   ─────────
S1 injected (注入时)   ──►  usage-stats.json   ──►  回路A:检索排序(已上线)
S2 read (memory_read)  ──►  { id → 衰减计数 }  ──►  回路B:治理路由(预留)
S3 回声检测 (turn 后)  ──►  sidecar,与正文解耦  ──►  回路C:离线标定(预留)
```

## 信号类别

| 信号 | 采集点 | 计入 |
|------|--------|------|
| `injected` | `session-turn.ts` 注入循环(会话内天然去重) | 仅观测,不进评分 |
| `read` | `memory_read` 工具(主动回读 = 最强使用证据) | 正向,权重 ×2 |
| `used` | 回声检测:注入记忆的特征词出现在本 turn 助手输出(文本+工具入参) | 正向,权重 ×1 |
| `harmful` / `unused` | 预留:归因 judge / 用户重问(P3) | 不进评分,留给治理 |

特征词 = 出现在记忆里但**不出现在用户消息里**的 token(CJK 二元组 + ≥4 字符拉丁词,
带停用表),排除"模型复述用户原话"这一最大混淆源。高精度低召回:检到才记,检不到不作负判。

## 评分接入

```
score = 0.7 × vector + 0.2 × recency + 0.1 × usage    (CONTEXT_PARAMS.retrieval)
usage = min(1, (2 × read + used) / 5)                 线性饱和
```

安全性质:usage 封顶 0.1,而 `minScore = 0.7` 对合成分把关——
低相关记忆即使满 usage 也到不了门槛,usage 只做同等相关间的排序偏置。

## 存储与失效语义

- 统计存于 `.zero/memory/usage-stats.json`(sidecar),**不写记忆 frontmatter、不碰 `updatedAt`**,
  因此不会触发 re-embed,也不污染新近度语义。
- 计数为指数衰减(半衰期 30 天,与新近度一致):停止被使用的记忆权重自动回落。
- 同 `(kind, sessionId, memoryId)` 只计一次,防单会话重复动作刷分。
- 落盘防抖(30s)+ shutdown 显式 flush;文件损坏从空开始,任何一层失败都不影响记忆主链路。

## 后续规划(未实现)

- **S4 模型自报**:捎带 turn 末 nudge / 会话末评估的既有 LLM 调用做逐注入归因。
- **S5 归因 judge**:复用 session-judge 模式,离线对注入事件输出
  `used_helpful / used_harmful / injected_unused`,负向信号写入 harmful/unused 计数。
- **回路B(治理)**:harmful/unused 比率超阈值的记忆进入治理队列(flag 给 UI,建议 supersede/archive),
  而不是静默降权——持续有害是数据质量问题,应走既有谱系/治理机制。
- **回路C(标定)**:消融回放(同 turn 去掉注入块重跑)校准各信号权重。
