# 设计：原地秒级翻篇交接（零 LLM 压缩，卡片即摘要）

## 需求（用户原话钉死）
- 自动交接＝**原地交接**：不建新会话（工具/系统提示 ~2万 token≈15% 不重背）
- **零 LLM 压缩请求**、秒级完成
- 界面百分比**真下降**（如 58% → ~17%）
- 老历史「翻篇」作废；交接卡就是摘要；对话继续
- 红线：不破坏手动 /handoff（稳定 ~20s）

## 机制（已从 force-compact 源码验证可行性）
参照官方插件 `@falling-ts/dsh-force-compact` 的 `src/engine/builtin.js`（文件头注释＝协议全文）：

1. 持久化原语 = 给会话 append 一条 `user/message`，带 `surfaceOp:{op:'replace'}`，shadow 老 seq 范围。
2. 前后必须用官方事件词表括号：`compaction/start → compaction/summary → user/message{replace} → compaction/end`。
   - 必须官方类型：自定义类型经 `append` 落盘缺 `ignorable` 标记 → 未来 harness 重建时加载闸拒绝 → 日志 brick。
3. **4 条 append 一个同步批跑完**，括号绝不能跨 turn 边界（`turn/start crosses an open compaction` = 整个会话日志卸载失败）。force-compact 在 `agent/status` idle 触发。
4. `compaction/summary.shadowedTokenCount`＝「影子价单」，token-meter surface fold 拿它对账；定价必须与官方估算器逐字节一致，否则百分比算错。
   - **估算器可直接 import force-compact 导出**：`estimateContentBlocks`（builtin.js:167 export）、`selectEarliestByTokens` / `selectRetainingLatestLatestTokens`（region.js export）。
   - `runTransaction` 本体未导出 → 照抄适配（builtin.js :91+ 起，含 stability re-check：异步后 surface 动了就放弃本批）。
5. 摘要文本＝插件 `buildCard` 现成交接卡（零 LLM）。

## 接入点
`index.js` `autoReadyOnce`（autoExecute 路径）：落卡后调用新函数 `fastFlipInPlace(agent, session, cardText)`：
选区（保留最近 N 条 surface 节点）→ 同步批 4 append → dbg 记用时。
删除 6dd8fb3 加的 realm-compactNow 后台块（用户已否决压缩路线）。

## 安全红线
- 先造一次性短会话实测（写完重启该会话能加载＋%掉＋继续对话正常＝判定器）
- 动任何真实会话前 `.bak-<时间戳>`；日志写坏＝不可逆
- 只在 idle 时跑；stability re-check 失败就放弃，不重试同批

## 读数背景
- compactNow(官方) 本机单槽 llama.cpp = 分钟级（6万 token 预填 @113 tok/s）→ 已被否决
- 新会话路线 = 每次重背 2 万 token 工具 → 已被否决
- 本方案是唯一同时满足「原地＋秒级＋掉%＋零压缩」的路
