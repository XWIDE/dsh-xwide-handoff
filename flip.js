// [19 2026-11-19] fastFlipInPlace — 原地秒级翻篇（零 LLM，卡片即摘要）。
// 协议参照 @falling-ts/dsh-force-compact/src/engine/builtin.js 头部注释（本机实测）：
//   compaction/start → compaction/summary → user/message{surfaceOp:replace} → compaction/end
//   四条 append 一个同步批跑完，括号绝不跨 turn 边界；官方事件类型保证重建加载闸不 brick。
// 计价/选区直接 import force-compact 的导出（逐字节一致的官方估算器），拿不到包＝跳过翻篇。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let fcCache = null; // { builtin, region, summarizer } | false
async function loadFc() {
  if (fcCache !== null) return fcCache;
  try {
    const req = createRequire(import.meta.url);
    const pkgDir = dirname(req.resolve("@falling-ts/dsh-force-compact/package.json"));
    const u = (p) => new URL(`file:///${join(pkgDir, p).replace(/\\/g, "/")}`).href;
    const builtin = await import(u("src/engine/builtin.js"));
    const region = await import(u("src/engine/region.js"));
    const summarizer = await import(u("src/engine/summarizer.js"));
    fcCache = { builtin, region, summarizer };
  } catch {
    fcCache = false;
  }
  return fcCache;
}

function randHex(n) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return s.slice(0, n);
}

// 简化版 currentOpenTurn（官方未导出）：反向扫事件找未闭合 turn/start 的 turn 号。
function openTurnOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || typeof e !== "object") continue;
    if (e.type === "turn/end" || e.type === "turn/start") {
      const t = e.data && Number.isFinite(e.data.turn) ? e.data.turn : undefined;
      return e.type === "turn/start" ? t : undefined;
    }
  }
  return undefined;
}

// busy-lock：最后一个 session/end-seed 之后存在未闭合 compaction/start＝拒。
function hasOpenBracket(events) {
  let lastSeed = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i] && events[i].type === "session/end-seed") { lastSeed = i; break; }
  }
  let open = null;
  for (let i = lastSeed + 1; i < events.length; i += 1) {
    const t = events[i] && events[i].type;
    if (t === "compaction/start") open = events[i];
    else if (t === "compaction/end") open = null;
  }
  return open !== null;
}

/**
 * 原地翻篇：把老历史（retainTokens 预算之前的表面节点）shadow 掉，摘要＝交接卡原文。
 * @returns {{ok:boolean, reason?:string, shadowed?:number, tokens?:number, ms?:number}}
 */
export async function fastFlipInPlace({ agent, session, cardText, retainTokens, dbg }) {
  const t0 = Date.now();
  const log = typeof dbg === "function" ? dbg : () => {};
  const fc = await loadFc();
  if (!fc) { log("翻篇跳过：拿不到 force-compact 引擎包"); return { ok: false, reason: "no-fc-package" }; }
  const meter = agent && agent.ctx && typeof agent.ctx.get === "function" ? agent.ctx.get("tokenMeter") : undefined;
  if (!meter || typeof meter.measure !== "function") { log("翻篇跳过：realm 无 tokenMeter"); return { ok: false, reason: "no-meter" }; }
  let measurement;
  try { measurement = meter.measure(session); } catch { measurement = undefined; }
  if (!measurement || !Array.isArray(measurement.nodes) || measurement.nodes.length < 2) {
    log("翻篇跳过：无 measurement 快照"); return { ok: false, reason: "no-measurement" };
  }
  const region = typeof fc.region.selectRetainingLatestTokens === "function"
    ? fc.region.selectRetainingLatestTokens(session, retainTokens, measurement)
    : null; // 官方选区（含工具配对平衡吸附）；拿不到走下方 fallback
  let start = region && region.start, end = region && region.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    // fallback：从 measurement.nodes 尾向头累加预算，取分界（不做工具配对吸附＝保守取 user/message）
    const nodes = measurement.nodes;
    let acc = 0, cutIdx = -1;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      acc += Number(nodes[i].tokens) > 0 ? Number(nodes[i].tokens) : 0;
      if (acc >= Math.max(1, retainTokens)) { cutIdx = i; break; }
    }
    if (cutIdx <= 0) { log("翻篇跳过：预算内无可压前缀"); return { ok: false, reason: "no-region" }; }
    let e2 = cutIdx - 1;
    const eventsAll = session.snapshotEvents();
    while (e2 > 0 && !(eventsAll[nodes[e2].seq] && eventsAll[nodes[e2].seq].type === "user/message")) e2 -= 1;
    if (e2 <= 0) { log("翻篇跳过：无 user/message 分界"); return { ok: false, reason: "no-boundary" }; }
    start = nodes[0].seq; end = nodes[e2].seq;
  }
  // 稳定性复核：两个边界必须仍在当前 surface.nodes（索引序）
  const surf = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : [];
  const fi = surf.indexOf(start), li = surf.lastIndexOf(end);
  if (fi < 0 || li < 0 || fi > li) { log(`翻篇跳过：边界已移动 ${start}..${end}`); return { ok: false, reason: "bounds-moved" }; }
  const events = session.snapshotEvents();
  if (hasOpenBracket(events)) { log("翻篇跳过：存在未闭合压缩括号"); return { ok: false, reason: "busy-lock" }; }
  const regionObj = { start, end };
  const projected = fc.builtin.projectRegion(session, regionObj);
  const shadowedSeqs = projected.shadowedSeqs;
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) { log("翻篇跳过：选区无 shadow 节点"); return { ok: false, reason: "empty-region" }; }
  let price = null;
  try { price = fc.builtin.priceRegionFromMeasurement(session, regionObj, measurement); } catch (e) { log(`翻篇跳过：计价抛错 ${String((e && e.message) || e)}`); }
  if (!Number.isFinite(price) || price <= 0) { log("翻篇跳过：计价不可用（拒写假价单）"); return { ok: false, reason: "no-price" }; }
  // 卡片必须明显小于被压段，否则翻了白翻
  if (cardText.length / 4 >= price) { log(`翻篇跳过：卡片(${Math.round(cardText.length / 4)}tok)不小于被压段(${price}tok)`); return { ok: false, reason: "no-shrink" }; }

  const compactionId = `xwh-${Date.now().toString(36)}-${randHex(6)}`;
  const turn = openTurnOf(events);
  const blocks = [{ type: "text", text: cardText }];
  const content = fc.summarizer.frameSummary(blocks);
  try {
    const startEvent = session.append("compaction/start", { compactionId, ...(turn === undefined ? {} : { turn }) });
    let summaryEvent;
    try {
      summaryEvent = session.append("compaction/summary", {
        compactionId,
        summary: blocks,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount: price,
        provider: "local-handoff-card",
        model: "none",
      });
    } catch (e) {
      session.append("compaction/end", { compactionId, ...(turn === undefined ? {} : { turn }), error: String((e && e.message) || e) });
      log(`翻篇失败(summary append)：${String((e && e.message) || e)}`); return { ok: false, reason: "append-summary" };
    }
    try {
      session.append("user/message", {
        id: `xwh-msg-${Date.now().toString(36)}-${randHex(4)}`,
        role: "user",
        content,
        source: Object.freeze({ kind: "compact-checkpoint", compactionId }),
      }, {
        surfaceOp: { op: "replace", startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
      });
    } catch (e) {
      session.append("compaction/end", { compactionId, ...(turn === undefined ? {} : { turn }), error: String((e && e.message) || e) });
      log(`翻篇失败(replace append)：${String((e && e.message) || e)}`); return { ok: false, reason: "append-replace" };
    }
    try { session.append("compaction/end", { compactionId, ...(turn === undefined ? {} : { turn }) }); }
    catch { log("警告：compaction/end 未落（下次加载可能显锁）"); }
  } catch (e) {
    log(`翻篇失败(start append)：${String((e && e.message) || e)}`); return { ok: false, reason: "append-start" };
  }
  const ms = Date.now() - t0;
  log(`翻篇完成 shadow=${shadowedSeqs.length} tokens=${price} 用时ms=${ms}`);
  return { ok: true, shadowed: shadowedSeqs.length, tokens: price, ms };
}
