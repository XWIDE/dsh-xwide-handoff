// dsh-xwide-handoff · CLIENT 半（浏览器端）
//
// 职责一：把「新建**可见**会话」这件事放在 GUI 亲生 API 上做（服务端 create 造的是裸会话，
// 列表里看不见）。协议：服务端 /handoff 在结果文本里追加一行
//   HANDOFF-PAYLOAD-V1 {"title":"…","cwd":"C:\\…","agentPreset":"…","stamp":"…","card":"…"}
// 本半扫到这条 payload 后：
//   1) sessions.create({cwd, agentPreset}) —— 与 GUI「新建对话」按钮同一条 API：可见、零上下文；
//      agentPreset 传不上就退回只传 cwd（保持当前默认智能体），并打日志。
//   2) prompt(卡片, "queue")               —— 卡片作为第一句填好；
//   3) binding.session.rename(标题)        —— Alt+G 改名同一条 RPC；
//   4) best-effort 打开新会话（探测候选 API，探不到就留在列表里由你点一下）；
//   5) 自愈重钉：目标标题被官方取名覆盖 → 重钉（上限 repinLimit）。
//
// 职责二：设置页分区（settings.section）。读写走 ctx.configForms.get(NS_SETTINGS)——
// 命名空间 = 装载行 entry id（harness 0.1.7 由 entry id 推导表单命名空间）。写回的键落进
// settings.yaml，覆盖 cordis.patch.yml 装载行里的基线；清空一项 = 回落基线。改动重载后生效。
window.__ModuleLoader__.load({
  id: "dsh-xwide-handoff",
  factory: (require) => {
    const module = { exports: {} };

    // ── 平台外部（web 预载基线包；缺席时逐层降级，绝不抛错）────────────────
    let React = null;
    try {
      React = require("react");
    } catch {}
    const h = React && typeof React.createElement === "function" ? React.createElement : null;
    let createSnapshotStore = null;
    try {
      createSnapshotStore = require("@deepseek-ai/dsh-client-store").createSnapshotStore;
    } catch {}

    const NS = "settings.xwideHandoff"; // 本分区文案字典命名空间
    const NS_SETTINGS = "dsh-xwide-handoff"; // 宿主设置命名空间 = 装载行 entry id

    const zh = {
      nav: "交接插件",
      intro: "把「/handoff 交接」调成你喜欢的样子：命令名、新会话怎么建、卡片内容、自动备好阈值。写进 settings.yaml，覆盖 cordis.patch.yml 基线；清空一项即回落基线。改动重载后生效。",
      loading: "读取设置中…",
      unavailable: "设置服务不可用（该 composition 没有 configForms 或命名空间未注册）。",
      enabled: { label: "启用插件", hint: "关掉后不再注册 /handoff，watcher 全部停摆。" },
      commandName: { label: "命令名", hint: "斜杠命令的名字，默认 handoff（即 /handoff）。" },
      childMode: { label: "新会话模式", hint: "GUI 亲生=浏览器半建新会话（列表可见，推荐）；服务端=直接建会话（可能要刷新才出现）；fork=继承全部历史（上下文不清零）。" },
      autoReady: { label: "到阈值自动备好", hint: "A 半自动：上下文到阈值自动把新会话备好（建好/命名/置顶/填卡），不替你切会话。" },
      readyPct: { label: "触发阈值 (%)", hint: "inputTokens ÷ 窗口 ≥ 这个百分比就自动备好。填 0–100，如 70。" },
      contextWindow: { label: "上下文窗口 (tokens)", hint: "本地模型窗口，默认 262144。" },
      readyCooldownMs: { label: "全局冷却 (毫秒)", hint: "两次自动备好之间的最小间隔，默认 600000（10 分钟）。" },
      compact: { label: "卡片内本地压缩", hint: "对近满上下文做本地压缩是分钟级（单卡）；关掉则跳过压缩，用官方 /compact 自行控制。" },
      recentUserMessages: { label: "卡片带最近原话条数", hint: "「最近你的原话」一节逐条带几条，默认 6。" },
      titleTemplate: { label: "标题模板", hint: "必须含 {seq}，如 调节Qwen3.8 Agent对接本地模型_{seq}。" },
      seqWidth: { label: "序号位数", hint: "递增序号的位数，默认 2（01、02…）。" },
      maxTitleChars: { label: "标题最长字符", hint: "超过会截断，默认 64。" },
      repinLimit: { label: "自愈重钉上限", hint: "新会话被官方改名后最多重钉几次，默认 3；0=关闭自愈。" },
      keepFork: { label: "fork 模式保留源会话", hint: "仅 childMode=fork 时有意义。" },
      cardSectionsGuide: { label: "卡片·接手须知段", hint: "关掉后卡片不再带「接手须知」清单。" },
      cardSectionsFiles: { label: "卡片·动过文件段", hint: "关掉后卡片不再列「本轮动过的文件」。" },
      cardSectionsUsage: { label: "卡片·上下文用量段", hint: "关掉后卡片不再带源会话用量数据。" },
      counterFile: { label: "计数器文件路径", hint: "留空 = 用默认 ~/.dsh/xwide-handoff-counter.json。" },
    };
    const en = {
      nav: "Handoff (X-WIDE)",
      intro: "Tune /handoff: command name, how the new chat is created, card contents, auto-ready threshold. Values persist to settings.yaml and override the cordis.patch.yml baseline; clear a field to fall back. Reload to apply.",
      loading: "Loading settings…",
      unavailable: "Settings service unavailable (no configForms in this composition, or namespace not registered).",
      enabled: { label: "Enable plugin", hint: "When off, /handoff is not registered and all watchers stop." },
      commandName: { label: "Command name", hint: "Slash-command name, default handoff (i.e. /handoff)." },
      childMode: { label: "New-chat mode", hint: "gui-native = browser half creates a VISIBLE chat (recommended); server = server-side create (list may need refresh); fork = inherit full history (context NOT cleared)." },
      autoReady: { label: "Auto-ready at threshold", hint: "Semi-auto: prepares a new chat when context crosses the threshold (create/name/pin/seed card) without switching sessions." },
      readyPct: { label: "Trigger threshold (%)", hint: "inputTokens ÷ window ≥ this percent triggers auto-ready. 0–100, e.g. 70." },
      contextWindow: { label: "Context window (tokens)", hint: "Model window, default 262144." },
      readyCooldownMs: { label: "Global cooldown (ms)", hint: "Minimum gap between auto-readies, default 600000 (10 min)." },
      compact: { label: "Local compaction in card", hint: "Compacting a near-full context takes minutes on a single GPU; off = skip (use official /compact)." },
      recentUserMessages: { label: "Recent user messages in card", hint: "How many verbatim user messages the card carries, default 6." },
      titleTemplate: { label: "Title template", hint: "Must contain {seq}, e.g. MyProject_{seq}." },
      seqWidth: { label: "Seq width", hint: "Digits in the incrementing counter, default 2 (01, 02…)." },
      maxTitleChars: { label: "Max title chars", hint: "Titles longer than this are truncated, default 64." },
      repinLimit: { label: "Self-heal rename limit", hint: "Max re-pins after the host renames the new chat, default 3; 0 = off." },
      keepFork: { label: "Keep source session in fork", hint: "Only meaningful when childMode=fork." },
      cardSectionsGuide: { label: "Card · guide section", hint: "Off = omit the onboarding checklist." },
      cardSectionsFiles: { label: "Card · touched-files section", hint: "Off = omit the changed-files list." },
      cardSectionsUsage: { label: "Card · usage section", hint: "Off = omit source-session context usage stats." },
      counterFile: { label: "Counter file path", hint: "Empty = default ~/.dsh/xwide-handoff-counter.json." },
    };

    // ── 设置分区组件（React.createElement / h，照 dsh-force-compact 的分区写法）──
    const wrapStyle = { display: "flex", flexDirection: "column", gap: 2, maxWidth: 860 };
    const titleStyle = { fontSize: 18, fontWeight: 600, margin: "0 0 4px" };
    const introStyle = { fontSize: 13, opacity: 0.75, lineHeight: 1.6, margin: "0 0 10px" };
    const rowStyle = { display: "grid", gridTemplateColumns: "220px 220px 1fr", gap: 12, alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(127,127,127,0.15)" };
    const labelStyle = { fontSize: 13.5, fontWeight: 550 };
    const hintStyle = { fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 };
    const inputStyle = { width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 13, borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit" };

    function XwideHandoffSection(props) {
      const { useXwideHandoff, update, mutatePath, t } = props;
      const snap = useXwideHandoff((s) => s);
      if (snap.status === "unavailable") {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: hintStyle }, t("unavailable")));
      }
      if (snap.status === "loading" || snap.value === undefined) {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: introStyle }, t("intro")), h("p", { style: hintStyle }, t("loading")));
      }
      const value = snap.value;
      const disabled = !snap.writable;
      const label = (k) => {
        const e = t(k);
        return typeof e === "string" ? e : (e && e.label) || String(k);
      };
      const hint = (k) => {
        const e = t(k);
        return (e && typeof e === "object" && e.hint) || "";
      };
      const boolRow = (key, on, onToggle) =>
        h("div", { key, style: rowStyle },
          h("span", { style: labelStyle }, label(key)),
          h("span", {},
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer" } },
              h("input", { type: "checkbox", checked: !!on, disabled, onChange: (e) => onToggle(e.target.checked) }),
              h("span", { style: { fontSize: 12.5, opacity: 0.7 } }, on ? "on" : "off"))),
          h("span", { style: hintStyle }, hint(key)));
      const textRow = (key, raw, commit, placeholder) =>
        h("div", { key, style: rowStyle },
          h("span", { style: labelStyle }, label(key)),
          h("span", {}, h("DraftInput", { value: raw === undefined ? "" : String(raw), disabled, placeholder: placeholder || "", onCommit: (v) => commit(v) })),
          h("span", { style: hintStyle }, hint(key)));
      const selectRow = (key, current, options, commit) =>
        h("div", { key, style: rowStyle },
          h("span", { style: labelStyle }, label(key)),
          h("span", {},
            h("select", {
              value: String(current == null ? options[0].value : current),
              disabled,
              style: inputStyle,
              onChange: (e) => commit(e.target.value),
            }, options.map((o) => h("option", { key: o.value, value: o.value }, o.label)))),
          h("span", { style: hintStyle }, hint(key)));

      const sections = value.cardSections && typeof value.cardSections === "object" ? value.cardSections : {};
      return h("div", { style: wrapStyle },
        h("h2", { style: titleStyle }, t("nav")),
        h("p", { style: introStyle }, t("intro")),
        boolRow("enabled", value.enabled, (v) => update("enabled", v)),
        textRow("commandName", value.commandName, (v) => update("commandName", v.trim() || null), "handoff"),
        selectRow("childMode", value.childMode, [
          { value: "none", label: "GUI 亲生 / gui-native (visible)" },
          { value: "create", label: "服务端 / server-side create" },
          { value: "fork", label: "fork（带历史）" },
        ], (v) => update("childMode", v)),
        boolRow("autoReady", value.autoReady, (v) => update("autoReady", v)),
        textRow("readyPct", value.readyPct === undefined ? "" : Math.round(Number(value.readyPct) * 100), (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || v.trim() === "") return update("readyPct", null);
          const p = n > 1.5 ? n / 100 : n; // 接受 70 与 0.7 两种写法
          return update("readyPct", Math.min(0.99, Math.max(0.05, p)));
        }, "70"),
        textRow("contextWindow", value.contextWindow, (v) => {
          const n = Math.trunc(Number(v));
          return update("contextWindow", Number.isFinite(n) && n > 1000 ? n : null);
        }, "262144"),
        textRow("readyCooldownMs", value.readyCooldownMs, (v) => {
          const n = Math.trunc(Number(v));
          return update("readyCooldownMs", Number.isFinite(n) && n >= 0 ? n : null);
        }, "600000"),
        boolRow("compact", value.compact, (v) => update("compact", v)),
        textRow("recentUserMessages", value.recentUserMessages, (v) => {
          const n = Math.trunc(Number(v));
          return update("recentUserMessages", Number.isFinite(n) && n > 0 ? n : null);
        }, "6"),
        textRow("titleTemplate", value.titleTemplate, (v) => update("titleTemplate", v.includes("{seq}") ? v : null), "项目名_{seq}"),
        textRow("seqWidth", value.seqWidth, (v) => {
          const n = Math.trunc(Number(v));
          return update("seqWidth", Number.isFinite(n) && n > 0 ? n : null);
        }, "2"),
        textRow("maxTitleChars", value.maxTitleChars, (v) => {
          const n = Math.trunc(Number(v));
          return update("maxTitleChars", Number.isFinite(n) && n > 8 ? n : null);
        }, "64"),
        textRow("repinLimit", value.repinLimit, (v) => {
          const n = Math.trunc(Number(v));
          return update("repinLimit", Number.isFinite(n) && n >= 0 ? n : null);
        }, "3"),
        boolRow("keepFork", value.keepFork, (v) => update("keepFork", v)),
        boolRow("cardSectionsGuide", sections.guide !== false, (v) => mutatePath(["cardSections", "guide"], v)),
        boolRow("cardSectionsFiles", sections.files !== false, (v) => mutatePath(["cardSections", "files"], v)),
        boolRow("cardSectionsUsage", sections.usage !== false, (v) => mutatePath(["cardSections", "usage"], v)),
        textRow("counterFile", value.counterFile, (v) => update("counterFile", v.trim() || null), "~/.dsh/xwide-handoff-counter.json"));
    }

    /** 草稿文本框：本地编辑，失焦/回车才写回（避免逐字符打宿主）。 */
    function DraftInput(props) {
      const { value, disabled, placeholder, onCommit } = props;
      const [buf, setBuf] = React.useState(String(value == null ? "" : value));
      React.useEffect(() => setBuf(String(value == null ? "" : value)), [value]);
      return h("input", {
        type: "text",
        value: buf,
        disabled,
        placeholder: placeholder || "",
        style: inputStyle,
        onChange: (e) => setBuf(e.target.value),
        onBlur: () => {
          if (String(value == null ? "" : value) !== buf) onCommit(buf);
        },
        onKeyDown: (e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        },
      });
    }

    function apply(ctx, config = {}) {
      // ── 设置分区（独立 try：任何缺席都不影响交接主逻辑）────────────────
      try {
        // [dsh-fix 2026-10-12] 这里原来是 `break;` —— JS 里 break 只能出现在循环/switch 内，
        // 在 try 块里是 SyntaxError，会让整个 client.js 加载失败（实测报 "Illegal break statement"）。
        // 原意是「依赖缺席就放弃设置分区、继续交接主逻辑」，所以用 throw 交给下面的 catch 接。
        if (!h || !React || typeof ctx.get !== "function" || !ctx.get("slots") || !ctx.get("locale") || !ctx.get("configForms"))
          throw new Error("设置分区依赖缺席（缺 slots/locale/configForms 或 React 运行时）");
        if (!createSnapshotStore) createSnapshotStore = fallbackSnapshotStore;
        const scope = ctx.configForms.get(NS_SETTINGS);
        const store = createSnapshotStore({ status: "loading", value: undefined, writable: false });
        const derive = () => {
          try {
            const s = scope.getSnapshot();
            if (s && typeof s === "object") {
              store.update((d) => {
                d.status = s.status;
                d.value = s.value;
                d.writable = s.writable;
              });
            }
          } catch {}
        };
        const unsub = scope.subscribe(derive);
        derive();
        ctx.effect(() => (typeof unsub === "function" ? unsub : () => {}), "xwide-handoff: settings subscription");
        ctx.effect(() => {
          const disposeDict = ctx.locale.register(NS, { zh, en });
          return () => {
            if (typeof disposeDict === "function") disposeDict();
          };
        }, "xwide-handoff: settings dictionaries");
        const t = ctx.locale.bind(NS);
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "dsh-xwide-handoff",
          order: 30,
          label: () => {
            const v = t("nav");
            return typeof v === "string" ? v : "Handoff";
          },
          inject: () => ({
            hooks: { xwideHandoff: store },
            t,
            update: (field, val) => (val === null || val === undefined ? scope.unset(field) : scope.set(field, val)),
            mutatePath: (path, val) => scope.mutate([{ op: val === null ? "unset" : "set", path, value: val }]),
          }),
        }, XwideHandoffSection));
        console.log("[xwide-handoff] 设置分区已注册（settings.section → configForms:" + NS_SETTINGS + "）");
      } catch (e) {
        console.log("[xwide-handoff] 设置分区跳过: " + ((e && e.message) || e));
      }

      // ── 交接主逻辑 ────────────────────────────────────────────────────
      try {
        const sessions = ctx.get("sessions");
        if (!sessions) {
          console.log("[xwide-handoff] no sessions service（浏览器半跳过）");
          return;
        }
        const MARKER = "HANDOFF-PAYLOAD-V1 ";
        // [防重放·红线] 只认「新鲜」payload：stamp 距现在必须 ≤ 这个毫秒数。
        // 事故教训（2026-10-13）：去重只靠 localStorage xwh.seen，换浏览器/清缓存后 seen 为空，
        // 历史会话里的旧 HANDOFF-PAYLOAD-V1 被逐条重放 → 批量建会话、批量改名，侧栏被打穿。
        // 现在：stamp 由服务端写（index.js: `stamp: new Date().toISOString()`），解析不了/缺席/过期
        // 一律拒绝建会话（只记 seen，不再重复打日志）。这是**结构性**防线，与 localStorage 无关。
        const PAYLOAD_MAX_AGE_MS = 5 * 60 * 1000;
        const repinLimit = Number.isInteger(config.repinLimit) && config.repinLimit >= 0 ? config.repinLimit : 3;
        const SEED_PREAMBLE =
          "【交接卡·只读】这是上一个会话自动注入的交接卡。你只需要回复一句『已接收交接，等待指令』；" +
          "不要分析卡片内容、不要给任何选项、不要自行开工。我的下一句指令才是任务。\n\n";

        const load = (k, d) => {
          try {
            const v = JSON.parse(localStorage.getItem(k) || "null");
            return v && typeof v === "object" ? v : d;
          } catch {
            return d;
          }
        };
        const save = (k, v) => {
          try {
            localStorage.setItem(k, JSON.stringify(v));
          } catch {}
        };
        const seen = new Set(load("xwh.seen", []));
        const want = load("xwh.want", {}); // childId -> 目标标题
        const pin = load("xwh.pin", {}); // childId -> 已重钉次数

        /** 从会话事件里倒着找最新一条 payload。 */
        function extractPayload(s) {
          try {
            const evs =
              typeof s.snapshotEvents === "function" ? s.snapshotEvents() : typeof s.messages === "function" ? s.messages() : [];
            for (let i = evs.length - 1; i >= 0; i -= 1) {
              const data = evs[i] && evs[i].data;
              if (!data) continue;
              let texts = [];
              if (Array.isArray(data.content))
                texts = data.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
              else if (typeof data.text === "string") texts = [data.text];
              for (const t of texts) {
                const idx = t.indexOf(MARKER);
                if (idx < 0) continue;
                try {
                  const p = JSON.parse(t.slice(idx + MARKER.length).split("\n")[0].trim());
                  if (p && typeof p.title === "string" && typeof p.card === "string") return p;
                } catch {}
              }
            }
          } catch {}
          return null;
        }

        /** best-effort 打开/聚焦新会话：候选 API 逐个试，全失败就留在列表里。 */
        function tryOpen(id) {
          const tries = [
            () => sessions.activate && sessions.activate(id),
            () => sessions.open && sessions.open(id),
            () => sessions.focus && sessions.focus(id),
            () => sessions.select && sessions.select(id),
            () => ctx.get("navigation") && ctx.get("navigation").openSession && ctx.get("navigation").openSession(id),
          ];
          for (const fn of tries) {
            try {
              const r = fn();
              if (r) {
                console.log("[xwide-handoff] 已请求打开新会话：" + id);
                return true;
              }
            } catch {}
          }
          console.log("[xwide-handoff] 未找到「打开会话」的公开 API —— 新会话已建好并命名，请在列表点一下");
          return false;
        }

        async function processPayload(parentId, p) {
          const key = parentId + "|" + String(p.stamp || p.title);
          if (seen.has(key)) return;
          // ── 新鲜度闸门（先于任何建会话动作）────────────────────────────
          // 无戳 / 戳不可解析 / 超龄 → 直接丢弃：历史里的旧交接卡永远不可能触发建新会话。
          const stampMs = typeof p.stamp === "string" ? Date.parse(p.stamp) : NaN;
          const age = Number.isFinite(stampMs) ? Date.now() - stampMs : NaN;
          if (!Number.isFinite(age) || age > PAYLOAD_MAX_AGE_MS || age < -5 * 60 * 1000) {
            seen.add(key);
            save("xwh.seen", [...seen].slice(-50));
            console.log(`[xwide-handoff] 忽略非新鲜 payload（${parentId}，stamp=${p.stamp || "(缺失)"}）`);
            return;
          }
          seen.add(key);
          save("xwh.seen", [...seen].slice(-50));
          const cwdOk = typeof p.cwd === "string" && /^[a-zA-Z]:[\\/]/.test(p.cwd);
          let newId = "";
          // ① 带当前模型/智能体新建（DeepSeek 用 DeepSeek，千问用千问），失败退回只传 cwd
          const req = {};
          if (cwdOk) req.cwd = p.cwd;
          if (typeof p.agentPreset === "string" && p.agentPreset) req.agentPreset = p.agentPreset;
          try {
            const created = await sessions.create(req);
            newId = (created && created.value && created.value.sessionId) || "";
            if (!newId)
              console.log(
                "[xwide-handoff] create(带preset) 失败: " +
                  JSON.stringify((created && created.error && (created.error.message || created.error.code)) || created),
              );
          } catch (e) {
            console.log("[xwide-handoff] create(带preset) 异常: " + ((e && e.message) || e));
          }
          if (!newId) {
            try {
              const created2 = await sessions.create(cwdOk ? { cwd: p.cwd } : {});
              newId = (created2 && created2.value && created2.value.sessionId) || "";
              if (newId) console.log("[xwide-handoff] 已退回「只传 cwd」新建：" + newId);
            } catch (e2) {
              console.log("[xwide-handoff] create(只cwd) 异常: " + ((e2 && e2.message) || e2));
            }
          }
          if (!newId) return;
          want[newId] = p.title;
          save("xwh.want", want);
          // ② 填好第一句
          try {
            const r = await sessions.get(newId).prompt([{ type: "text", text: SEED_PREAMBLE + p.card }], "queue");
            if (r && r.ok === false)
              console.log("[xwide-handoff] prompt 失败: " + ((r.error && (r.error.message || r.error.code)) || "?"));
          } catch (e) {
            console.log("[xwide-handoff] prompt 异常: " + ((e && e.message) || e));
          }
          // ③ 命名（Alt+G 同一条 RPC）
          try {
            await sessions.using(newId, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(p.title));
            console.log(`[xwide-handoff] 交接新会话已建：${newId} 命名「${p.title}」`);
          } catch (e) {
            console.log("[xwide-handoff] rename 异常: " + ((e && e.message) || e));
          }
          // ④ 打开（best-effort）
          setTimeout(() => tryOpen(newId), 600);
        }

        function scan() {
          try {
            const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
            const ids = (snap && snap.ids) || [];
            const byId = (snap && snap.byId) || {};
            for (const id of ids) {
              const row = byId[id];
              if (!row || row.blank) continue;
              if (row.updatedAt && Date.now() - row.updatedAt > 15 * 60 * 1000) continue;
              try {
                sessions.using(id, { source: "workspaceOperation" }, (ref) => {
                  const s = ref && ref.binding && ref.binding.session;
                  if (!s) return;
                  const p = extractPayload(s);
                  if (p) void processPayload(id, p).catch((e) => console.log("[xwide-handoff] process 异常: " + ((e && e.message) || e)));
                });
              } catch {}
            }
            // ⑤ 自愈重钉
            for (const cid of Object.keys(want)) {
              const r = byId[cid];
              if (!r) continue;
              const t = String(r.title || "");
              if (!t || t === want[cid]) continue;
              const n = pin[cid] || 0;
              if (n >= repinLimit) continue;
              pin[cid] = n + 1;
              save("xwh.pin", pin);
              try {
                sessions.using(cid, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(want[cid]));
                console.log(`[xwide-handoff] 自愈重钉：${cid} -> 「${want[cid]}」（第${n + 1}次，原「${t}」）`);
              } catch (e) {
                console.log("[xwide-handoff] 自愈重钉异常: " + ((e && e.message) || e));
              }
            }
          } catch {}
        }

        // [修复 2026-10-13 18:35] 停用「每 5 秒扫全量会话 + 重放历史交接卡」自动扫描器。
        // 事故记录见 profile\cordis.patch.yml:577-581：去重只靠 localStorage(xwh.seen)，写入路径
        // 一变 seen=空 → 历史 HANDOFF-PAYLOAD-V1 被逐条重放（批量建会话 + 改名）→ sessions.list
        // 变化 → subscribe 回调再扫 = 正反馈死循环 → 渲染进程持续重算 → 界面卡死 / 心跳丢 /
        // 断开连接再重连。当前 childMode=create（服务端直接建会话），浏览器半边不需要自动扫描。
        // 恢复方式：把下面 9 行取消注释（原件备份在 default-workspace\_fix-backup-20261013-1835\client.js.bak）。
        // try {
        //   ctx.on("session/create", () => setTimeout(scan, 1500));
        // } catch {}
        // try {
        //   if (sessions.list && sessions.list.subscribe) sessions.list.subscribe(() => setTimeout(scan, 800));
        // } catch {}
        // setInterval(scan, 5000);
        // setTimeout(scan, 3000);
        console.log("[xwide-handoff] web half active（自动扫描已停用 2026-10-13；仅保留设置分区）");
      } catch (e) {
        console.log("[xwide-handoff] client init skipped: " + ((e && e.message) || e));
      }
    }

    /** createSnapshotStore 缺席时的极简兜底（订阅语义同形，无 React 批处理）。 */
    function fallbackSnapshotStore(initial) {
      let state = { ...initial };
      const subs = new Set();
      return {
        get: () => state,
        update: (fn) => {
          const next = { ...state };
          fn(next);
          state = next;
          for (const s of subs) {
            try {
              s();
            } catch {}
          }
        },
        subscribe: (fn) => {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      };
    }

    module.exports.apply = apply;
    module.exports.inject = ["sessions", "slots", "locale", "configForms"];
    return module.exports;
  },
});
