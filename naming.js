/**
 * dsh-named-handoff · 命名规则（纯函数，零依赖、可单测）
 *
 * 设计要点（踩过的坑，写在这是为了下次别改回去）：
 *  1. 序号**不能**从源会话标题的尾号推算。交接出去的源会话每次都是新开的，
 *     标题没有尾号 → 永远算回 `_01`（实测十次交接全叫同一个名字）。
 *     序号必须来自**落盘计数器**（本模块只负责算，落盘在 index.js）。
 *  2. DSH 官方取名服务会主动覆盖已钉住的标题（其 refresh() 注释自认
 *     "overwriting a pinned user title is the point"），所以标题要**能被它自己取到**：
 *     注入卡片的第一行就是目标标题原文 → 官方启发式直接取到我们要的名字。
 *     因此标题必须**短、无生僻符号**（不要 ← ｜ 【】 | # 等，启发式会在符号处截断）。
 *  3. 标题长度上限默认 64 字符，超出截断；空白折叠成单个空格。
 */

export const DEFAULT_TEMPLATE = "{base}_{seq}";
export const DEFAULT_SEQ_WIDTH = 2;
export const DEFAULT_MAX_TITLE_CHARS = 64;

/** 折叠空白 + 去掉会干扰官方取名的符号，限制长度。永不抛错。 */
export function sanitizeSegment(text, max = 28) {
  let s = String(text ?? "");
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  // 去掉成对符号/箭头/竖线/井号等：官方取名启发式常在这些位置截断
  s = s.replace(/[←→｜|【】\[\](){}<>#*`~"'`\\/^&+=@%$!?！？，。：；、（）《》…—·「」『』]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (max > 0 && s.length > max) s = s.slice(0, max).trim();
  return s;
}

/**
 * 取基名：优先会话最新标题 → 工作目录名 → fallback。
 * @param {{titles?: string[], cwd?: string, fallback?: string}} input
 */
export function resolveBase({ titles = [], cwd = "", fallback = "handoff" } = {}) {
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    const t = sanitizeSegment(titles[i], 40);
    if (t) return stripSeqTail(t);
  }
  const dir = sanitizeSegment(basenameOf(String(cwd || "")), 40);
  if (dir) return stripSeqTail(dir);
  return sanitizeSegment(fallback, 20) || "handoff";
}

/** 剥掉已有尾号（`_01` / `-3`），避免 `_01_02` 叠加。 */
export function stripSeqTail(text) {
  return String(text ?? "")
    .replace(/[-_]\d{1,4}\s*$/g, "")
    .trim();
}

function basenameOf(p) {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** 序号补零：1 -> "01"（width=2）。 */
export function padSeq(n, width = DEFAULT_SEQ_WIDTH) {
  const w = Number.isInteger(width) && width > 0 ? width : DEFAULT_SEQ_WIDTH;
  const s = String(Math.max(0, Math.trunc(Number(n) || 0)));
  return s.length >= w ? s : s.padStart(w, "0");
}

/** 本地时间戳 `MMDD-HHmm`（用于模板里的 {time}）。 */
export function formatStamp(date = new Date()) {
  const p = (v) => String(v).padStart(2, "0");
  return `${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/**
 * 渲染标题。模板可用 `{base} {seq} {note} {time}`。
 * 结果保证：单行、无危险符号、长度受限、以 `_NN` 结尾（模板含 {seq} 时）。
 */
export function renderTitle({
  template = DEFAULT_TEMPLATE,
  base = "handoff",
  seq = 1,
  note = "",
  time = formatStamp(),
  seqWidth = DEFAULT_SEQ_WIDTH,
  maxChars = DEFAULT_MAX_TITLE_CHARS,
} = {}) {
  const tpl = String(template && String(template).includes("{seq}") ? template : DEFAULT_TEMPLATE);
  const noteClip = sanitizeSegment(note, 20);
  const baseClean = sanitizeSegment(base, 40) || "handoff";
  let out = tpl
    .replaceAll("{base}", baseClean)
    .replaceAll("{seq}", padSeq(seq, seqWidth))
    .replaceAll("{note}", noteClip)
    .replaceAll("{time}", sanitizeSegment(time, 12));
  out = sanitizeSegment(out, maxChars);
  return out || `handoff_${padSeq(seq, seqWidth)}`;
}

/**
 * 从已用序号数组里算下一个序号（纯函数；落盘由调用方负责）。
 * @param {number[]} used 已出现过的序号（可含空洞）
 * @param {number} max 上限，默认 99
 */
export function nextSeqFrom(used = [], max = 99) {
  const nums = (Array.isArray(used) ? used : [])
    .map((v) => Math.trunc(Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0);
  const top = nums.length ? Math.max(...nums) : 0;
  return Math.min(top + 1, max);
}

/** 会话标题事件是否来自**非用户**来源（= 官方解钉/自动取名发生，需要自愈重钉）。 */
export function isNonUserTitleEvent(event) {
  if (!event || event.type !== "session/title") return false;
  const kind = event.data && event.data.source && event.data.source.kind;
  return kind !== "user";
}

/** 用户原话过滤：跳过系统注入的控制型内容（它们不是"你的话"）。 */
export function isSyntheticUserText(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  // [dsh-fix 2026-10-12] 原来的 6 个头挡不住实测注入。证据：handoff-2026-10-12T13-32-28-450Z.md
  //   的「最近你的原话」6 条里有 3 条（第 2/4/6 条）整段是 <hindsight_knowledge_refresh> 系统提醒，
  //   真原话只剩 3 条 —— 卡片一半字数被垃圾吃掉，接手方读不到有效信息。
  //   <hindsight_knowledge> / <available_skills> / 记忆摘要块同理，都会以 user/message 注入。
  const heads = [
    "<system-reminder>",
    "<acp ",
    "<project-context>",
    "<hindsight_knowledge_refresh>",
    "<hindsight_knowledge>",
    "<available_skills>",
    "Current runtime context",
    "You are repeating the exact same tool call",
    "【灵枢最近记忆】",
    "以下由 untrusted-memory",
    "# 交接卡",
    "## 交接卡",
  ];
  if (heads.some((h) => t.startsWith(h))) return true;
  // 这些可能挂在别的内容后面（前缀先行），用包含判断兜一层。
  const contains = [
    "Additional instructions from",
    "<hindsight_knowledge_refresh>",
    "<hindsight_knowledge>",
    "You are repeating the exact same tool call",
  ];
  if (contains.some((h) => t.includes(h))) return true;
  return false;
}
