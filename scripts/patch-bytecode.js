#!/usr/bin/env node
"use strict";

// 原地翻译方案由 hjkl950217 在 PR #238 提供。只改变字符串占位内的内容，
// 保留 Bun 数据布局；备份、签名和启动验证完成后才替换用户的可执行文件。
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const io = require("../bun-binary-io.js");

// spinner 完成态/进度词：传统 Layer 4 在 patch-cli.js 用结构锚定替换它们，
// bytecode 容器按常量池整串匹配即可。这些词在常量池里只作显示值（无逻辑
// 比较/对象键），整串替换安全；Baked 桶短译成双字才放得下。
// 词表与 patch-cli.js 的 statusVerbs / 动词数组同源（后者是 Layer 4 的锚点），
// 改动其中一处时两处都要跟。
const BUILTIN_SPINNER_TRANSLATIONS = [
  { en: "Baked", zh: "烤了" },
  { en: "Brewed", zh: "沏了" },
  { en: "Churned", zh: "翻搅了" },
  { en: "Cogitated", zh: "琢磨了" },
  { en: "Cooked", zh: "烹饪了" },
  { en: "Crunched", zh: "嚼了" },
  { en: "Sautéed", zh: "翻炒了" },
  { en: "Saut\\xE9ed", zh: "翻炒了" },
  { en: "Worked", zh: "忙活了" },
  { en: "Thought", zh: "思考了" },
  { en: "almost done thinking", zh: "即将完成思考" },
  { en: "thinking some more", zh: "继续思考中" },
  { en: "thinking more", zh: "深入思考" },
  { en: "still thinking", zh: "仍在思考" },
  { en: "Needs input", zh: "需要输入" },
  { en: "Ready for review", zh: "待审核" },
];

// 粘贴/截断附件的协议占位符碎片。Bun 把 `[Pasted text #${id} +${n} lines]` 这类
// 运行时解析的模板拆成常量池静态段，翻译任一静态段都会让识别附件的正则失配，
// 模型只收到占位符字面量而不是真实粘贴内容。patch-cli.js 的
// isProtectedProtocolLiteral 只覆盖明文路径，这里补齐 bytecode 池。
// 注意 ` more lines]` 是折叠行数提示的 UI 文案，可翻译，不在保护之列。
const PROTOCOL_FRAGMENTS = new Set([
  "[Pasted text #",
  " lines]",
  "[...Truncated text",
  "[Image #",
]);

// `Shell cwd was reset to <dir>` 由明文正则（Egt）消费，用于把执行目录复位；
// 翻译会让解析失配、后续命令跑到错误目录。池里暂无完整条目，守卫纯属防御。
// `Agent "`（minify 名 `Wet`）与 `" finished`（`Xir`）是逻辑前缀/后缀对：agent
// 任务列表靠 `startsWith(Wet) && endsWith(Xir)` 识别完成通知，同一常量还用于生成
// 模型可见的 `<task-notification>` 摘要。池里确有 7B `Agent "` 条目，翻译会让任务
// 识别失配、协议混入中文，必须拒绝。
const LOGIC_CONSUMED_FRAGMENTS = new Set([
  "Shell cwd was reset to ",
  'Agent "',
]);

// 池内专用译文。两类用途：
// 1) 修正主表里放不进窄槽的条目（如 ctrl+o，主表长译 24B 装不进 19B 窄槽）；
// 2) 只在 Bun 常量池里作展示片段的串——写进 cli-translations.json 会让明文路径
//    （patch-cli.js）在协议模板或提示词里误替换，故只在此维护、不走主表。
// 槽宽来自 2.1.260 实测，译文超宽会被静默跳过，改动后用测试核对。
const POOL_TRANSLATIONS = new Map([
  [" (ctrl+o to expand)", " ctrl+o展开"],
  ["Added ", "新增 "],
  [" lines", " 行"],
  [" completed", " 已完成"],
  ["timeout ", "超时 "],
  [" · timeout ", " ·超时 "],
  [" for ", "耗时"], // 5B 窄槽最多 2 个单元；`思考了 for 7s` -> `思考了耗时7s`
  ["searched for", "搜索了"],
  ["patterns", "个模式"], // 单数 `pattern` 与 Grep 工具参数共享，不动
  // 2.1.260 用户反馈缺口：Waiting for task 前缀、chord 附加指示、后台 agent
  // 启动/完成、Goal 状态词、Task Output 工具名。均只在池里作展示片段，进主表
  // 会被明文路径在协议模板/提示词里误替换。槽宽来自本机 2.1.260 实测。
  ["\xA0\xA0\xA0\xA0\xA0Waiting for task", "\xA0\xA0等待任务"],
  ["give additional instructions", "给出额外指示"],
  [" background agents launched", " 个后台 Agent 启动"],
  ['Background agent "', '后台 Agent"'],
  [" finished", " 已完成"],
  ["Goal achieved", "目标已达成"],
  ["Goal could not be achieved", "目标未能达成"],
  ["Goal not yet met… continuing", "目标尚未达成…继续"],
  ["Task Output", "任务输出"],
  // 上下文压缩后 banner `✻ Conversation compacted (ctrl+o for history)` 又显示英文：
  // 主表键 `✻ Conversation compacted (` 不匹配池条目（✻ 由组件单独渲染，@111563738
  // children:[mB,"Conversation compacted (",Aw," for history)"]），池里是 24B 的
  // `Conversation compacted (`。尾段 ` for history)` 还被 summarized hint @112441011
  // 的模板共用，头段一并翻避免中英混。`ctrl+o` 是键位变量（保留），` for history`
  // （12B）是 Compacted 状态行 detail（@111406312 `${f} for history`）。槽宽实测。
  ["Conversation compacted (", "对话已压缩（"],
  ["Conversation summarized (", "对话已摘要（"],
  [" for history)", " 查看历史）"],
  [" for history", " 查看历史"],
  // 主表精选译文（37 字符）超过 --betas 帮助描述的池占位（60B narrow，预算 30），
  // tooLong 会整条跳过；池内用预算内的短译文，主表措辞留给其他展示面。
  ["Beta headers to include in API requests (API key users only)", "API 请求的 Beta headers（仅 key 用户）"],
  // 以下主表为测试守护的精选措辞，但超出 slash 菜单池占位预算（narrow=原文字符数一半），
  // 池内用预算内短译文覆盖，主表措辞不动。
  ["Manage MCP servers", "管理 MCP 服务"],
  ["Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", "复制最后回复到剪贴板（/copy N 取第 N 条）"],
  ["Manage allow and deny tool permission rules", "管理工具权限 allow/deny 规则"],
  ["Manage Claude Code plugins", "管理插件"],
  ["Create and manage scheduled remote Claude Code agents", "管理定时运行的远程 Agent"],
  ["Order Claude Code stickers", "订购贴纸"],
  ["Install the Claude Slack app", "安装 Slack 应用"],
  ["Listen to Claude FM lo-fi radio", "收听 Claude FM"],
  ["Stop this background session; transcript and worktree are kept", "停止后台会话；保留 transcript 与 worktree"],
  ["Open Claude in Chrome settings", "Chrome 集成设置"],
  ["Set the AI model for Claude Code", "设置会话 AI 模型"],
  ["Set the terminal UI renderer (default | fullscreen)", "设置终端 UI 渲染器"],
  ["Toggle brief-only mode", "切换 brief 模式"],
  // 2.1.289 窄槽：保留主表的完整译法，这里只收录可在真实池宽内写入的短译。
  ["File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)", "启动时下载文件；格式 file_id:relative_path"],
  ["JSON Schema for structured output validation. Example: {\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}", "结构化输出用 JSON Schema 校验"],
  ["Sign in to your Anthropic account", "登录 Anthropic 账号"],
  ["Add an MCP server to Claude Code.", "添加 MCP 服务"],
  ["Print the default auto mode environment, allow, soft_deny, and hard_deny rules as JSON", "以 JSON 显示 auto mode 默认规则"],
  ["Scaffold a new plugin at ~/.claude/skills/<name>/ (auto-loads next session as <name>@skills-dir)", "在 ~/.claude/skills/<name>/ 创建插件；下次加载"],
  ["Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)", "安装 Claude Code；[target] 指定版本（stable/latest/版本号）"],
  ["Enable Claude in Chrome integration", "启用 Chrome 集成"],
  ["Disable Claude in Chrome integration", "关闭 Chrome 集成"],
  ["Enable debug mode with optional category filtering (e.g., \"api,hooks\" or \"!1p,!file\")", "启用调试，可选过滤分类（如 api,hooks）"],
  ["Comma or space-separated list of tool names to allow (e.g. \"Bash(git *) Edit\")", "允许的工具名，用逗号或空格分隔"],
  ["Comma or space-separated list of tool names to deny (e.g. \"Bash(git *) Edit\")", "禁用的工具名，用逗号或空格分隔"],
  ["Stop ultrareview", "停止审查"],
  ["Keep worktree and tmux session", "保留工作树和 tmux"],
  ["Remove worktree and tmux session", "移除工作树和 tmux"],
  ["Keep worktree", "保留工作树"],
  ["Remove worktree", "移除工作树"],
  ["Async agent", "异步代理"],
  ["shell mode", "命令模式"],
  ["Claude Code needs your input", "需要你的输入"],
  ["Not now", "暂不"],
  ["See ya!", "再见！"],
  ["Make auto mode your default permission mode?", "要将 auto mode 设为默认权限模式？"],
  ["In plan mode, Claude will:", "计划模式下，Claude 将："],
  ["Ready to code?", "开始写代码？"],
  ["Here is Claude's plan:", "Claude 的计划："],
  ["Plan saved!", "计划已保存"],
  ["Local agents", "本地代理"],
  ["Session URL", "会话网址"],
  ["Run ultraplan", "运行规划"],
  ["Stop ultraplan", "停止规划"],
  ["Ultraplan approved", "规划已批准"],
  ["Error loading Claude Code sessions", "加载会话失败"],
  ["No Claude Code sessions found", "未找到会话"],
  ["Login with Claude account", "登录 Claude 账号"],
  ["Log in to Claude", "登录 Claude"],
  ["Also try: ", "也可试："],
  ["View on GitHub", "在 GitHub 看"],
  ["Please install git and restart Claude Code.", "请安装 git 并重启 Claude Code。"],
  ["MCP servers", "MCP服务"],
  ["Agents view", "代理视图"],
  ["Total tokens:", "总 token："],
  ["Tokens per Day", "每日 token"],
  ["[Image]", "[图]"],
  ["[View Tab]", "[查看页]"],
  ["Move per-machine sections (cwd, env info, memory paths, git status) from the system prompt into the first user message. Improves cross-user prompt-cache reuse. Only applies with the default system prompt (ignored with --system-prompt).", "将本机信息从系统提示移到首条消息，复用提示缓存。仅默认提示生效；--system-prompt 下忽略。"],
  ["When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)", "恢复时创建新会话 ID，不复用原 ID（配合 --resume 或 --continue）"],
  ["Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)", "输出实时消息片段（需 --print 和 --output-format=stream-json）"],
  ["Fetch a plugin .zip from a URL for this session only (repeatable: --plugin-url A --plugin-url B)", "仅本次会话从 URL 加载插件 .zip（可重复指定 --plugin-url）"],
  ["Only use MCP servers from --mcp-config, ignoring all other MCP configurations", "仅用 --mcp-config 的 MCP 服务，忽略其他配置"],
  ["Alias for --permission-mode bypassPermissions", "--permission-mode 的别名"],
  ["Settings file or JSON string to apply to the agent view and dispatched sessions", "用于 Agent 视图和分派会话的设置文件或 JSON"],
  ["Only use MCP servers from --mcp-config in dispatched sessions", "分派会话仅用 --mcp-config 的 MCP 服务"],
  ["Print the effective auto mode config as JSON: your settings where set, defaults otherwise", "以 JSON 显示 auto mode 配置；用户设置优先"],
  ["Get AI feedback on your custom auto mode rules", "获取 auto mode 规则反馈"],
  ["Import MCP servers from Claude Desktop (Mac and WSL only)", "从 Claude Desktop 导入 MCP（Mac/WSL）"],
  ["Add an MCP server (stdio, SSE, HTTP, or WebSocket) with a JSON string", "用 JSON 添加 MCP 服务（stdio/SSE/HTTP/WebSocket）"],
  ["Authenticate with an MCP server (HTTP, SSE, or claude.ai connector)", "认证 MCP 服务（HTTP/SSE/claude.ai）"],
  ["Start the Claude Code MCP server", "启动 MCP 服务"],
  ["Manage Claude Code marketplaces", "管理插件市场"],
  ["Print the raw bugs.json payload instead of formatted findings", "输出原始 bugs.json，不格式化"],
]);

function patchStringPool(buffer, translations, { mainTableOnly = false } = {}) {
  if (!Array.isArray(translations)) throw new Error("翻译表必须是数组");
  const table = new Map();
  const protectedText = new Set(translations.filter(t => t?.skipPatch).map(t => t.en));
  for (const item of translations) {
    if (!item || typeof item.en !== "string" || typeof item.zh !== "string" || !item.en || !item.zh) {
      throw new Error("翻译条目必须包含非空 en / zh 字符串");
    }
    if (protectedText.has(item.en) || PROTOCOL_FRAGMENTS.has(item.en) || LOGIC_CONSUMED_FRAGMENTS.has(item.en)) continue;
    if (table.has(item.en) && table.get(item.en) !== item.zh) throw new Error(`翻译冲突：${item.en}`);
    table.set(item.en, item.zh);
  }
  // 内置补充词只在主表缺省时生效，避免与 cli-translations.json 冲突；
  // 主表标记 skipPatch 的条目仍受保护，内置词不得绕过。
  // mainTableOnly（no-match 探测用）跳过内置与池内注入，保证"空表必须零命中"的守卫语义。
  if (!mainTableOnly) {
    for (const item of BUILTIN_SPINNER_TRANSLATIONS) {
      if (!table.has(item.en) && !protectedText.has(item.en)) table.set(item.en, item.zh);
    }
    // 池内专用译文直接写入池表（可覆盖主表同名值）；协议/逻辑守卫优先级最高。
    for (const [en, zh] of POOL_TRANSLATIONS) {
      if (!protectedText.has(en) && !PROTOCOL_FRAGMENTS.has(en) && !LOGIC_CONSUMED_FRAGMENTS.has(en)) table.set(en, zh);
    }
  }
  const lengths = new Set([...table.keys()].map(en => en.length));
  const found = new Set();
  let patched = 0, tooLong = 0;
  // ponytail: 单遍扫描 Bun 数据中的精确字符串和条目头；格式变化时扩展版本化解析器。
  for (let offset = 0; offset + 8 <= buffer.length; offset++) {
    // CachedUniquedStringImplBase (2.1.242): relative pointer, bool flags, length.
    // Later shared-pool records: length | is8Bit << 31, hash, characters.
    const cached = offset + 16 <= buffer.length && buffer.readUInt32LE(offset) === 16 &&
      buffer.readUInt32LE(offset + 4) === 0 && (buffer[offset + 8] & 0x36) === 0;
    const flags = cached ? buffer[offset + 8] : buffer[offset + 3];
    if (!cached && flags !== 0x80 && flags !== 0) continue;
    const length = buffer.readUInt32LE(offset + (cached ? 12 : 0)) & 0x7fffffff;
    if (!lengths.has(length)) continue;
    const narrow = cached ? (flags & 1) !== 0 : flags === 0x80;
    const bytes = length * (narrow ? 1 : 2);
    const start = offset + (cached ? 16 : 8);
    if (start + bytes > buffer.length) continue;
    const en = buffer.toString(narrow ? "latin1" : "utf16le", start, start + bytes);
    const zh = table.get(en);
    if (!zh) continue;
    found.add(en);
    const replacement = Buffer.from(zh, "utf16le");
    if (replacement.length > bytes) {
      tooLong++;
    } else {
      buffer.writeUInt32LE(zh.length, offset + (cached ? 12 : 0)); // UTF-16 code units.
      if (cached) buffer[offset + 8] &= ~1;
      buffer.fill(0, start, start + bytes);
      replacement.copy(buffer, start);
      patched++;
    }
    offset = start + bytes - 1;
  }
  return { patched, notFound: table.size - found.size, tooLong };
}

function readContainer(binaryPath) {
  const lief = io.loadNodeLief();
  if (!lief) throw new Error("native patch 需要 node-lief");
  const parsed = io.extractNativeBun(lief, binaryPath);
  const entry = io.findClaudeModule(parsed.bunData, parsed.bunOffsets, parsed.moduleStructSize);
  if (!entry || !io.claudeBytecodeGuardReason(entry)) throw new Error("当前程序不是已识别的 Bun bytecode 容器");
  return { ...parsed, bunData: Buffer.from(parsed.bunData) };
}

function patchBinary(binaryPath, translations, { dryRun = false, mainTableOnly = false } = {}) {
  binaryPath = fs.realpathSync(binaryPath);
  const version = io.readExecutableVersion(binaryPath);
  if (!version) throw new Error("原始 Claude Code 启动自检失败，未改动文件");
  const backupPath = binaryPath + ".zh-cn-backup";
  const sameVersionBackup = fs.existsSync(backupPath) && io.readExecutableVersion(backupPath) === version;
  const sourcePath = sameVersionBackup ? backupPath : binaryPath;
  const { bunData, format } = readContainer(sourcePath);
  const original = fs.readFileSync(sourcePath);
  const payloadOffset = original.indexOf(bunData);
  if (payloadOffset < 0 || original.indexOf(bunData, payloadOffset + 1) !== -1) {
    throw new Error("无法唯一定位 Bun 数据，未改动文件");
  }
  const summary = patchStringPool(bunData, translations, { mainTableOnly });
  if (dryRun) return { ...summary, version, mode: "dry-run" };
  if (!summary.patched) throw new Error("没有命中可翻译的字节码条目，未改动文件");
  bunData.copy(original, payloadOffset);
  const current = fs.readFileSync(binaryPath);
  const currentPayload = current.subarray(payloadOffset, payloadOffset + bunData.length);
  if (sameVersionBackup && currentPayload.equals(bunData)) return { ...summary, version, backup: backupPath, changed: false };

  const tempDir = fs.mkdtempSync(path.join(path.dirname(binaryPath), ".zh-cn-bytecode-"));
  const candidate = path.join(tempDir, format === "PE" ? "claude.exe" : "claude");
  try {
    fs.writeFileSync(candidate, original, { mode: fs.statSync(binaryPath).mode });
    if (format === "MachO") io.signAndVerifyMachO(candidate);
    if (io.readExecutableVersion(candidate) !== version) throw new Error("汉化副本启动自检失败，未改动原文件");
    const help = execFileSync(candidate, ["--help"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    if (!/[\u3400-\u9fff]/u.test(help)) throw new Error("汉化副本帮助界面未出现中文，未改动原文件");
    if (!sameVersionBackup) io.withWindowsFileRetry(() => fs.copyFileSync(binaryPath, backupPath));
    io.withWindowsFileRetry(() => fs.renameSync(candidate, binaryPath));
    return { ...summary, version, backup: backupPath, changed: true };
  } finally {
    io.withWindowsFileRetry(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  }
}

function restoreBinary(binaryPath) {
  binaryPath = fs.realpathSync(binaryPath);
  const backup = binaryPath + ".zh-cn-backup";
  const receiptPath = binaryPath + ".zh-cn-repair.json";
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const { hash } = require("./native-repair.js");
    if (hash(backup) !== receipt.sourceHash) throw new Error("备份指纹不符，未还原文件；备份已保留");
    if (hash(binaryPath) !== receipt.patchedHash) {
      // CC 已被上游重新安装或升级，不能用同版本旧备份覆盖它。
      fs.unlinkSync(backup);
      fs.unlinkSync(receiptPath);
      fs.rmSync(receiptPath + ".pending", { force: true });
      return { restored: false, reason: "current-file-changed", preservedCurrent: true };
    }
  }
  const version = io.readExecutableVersion(binaryPath);
  if (!version || io.readExecutableVersion(backup) !== version) {
    throw new Error("备份与当前程序版本不一致或无法启动，未还原文件；备份已保留");
  }
  const tempDir = fs.mkdtempSync(path.join(path.dirname(binaryPath), ".zh-cn-restore-"));
  try {
    const candidate = path.join(tempDir, path.basename(binaryPath));
    fs.copyFileSync(backup, candidate);
    io.withWindowsFileRetry(() => fs.renameSync(candidate, binaryPath));
    io.withWindowsFileRetry(() => fs.unlinkSync(backup));
    fs.rmSync(binaryPath + ".zh-cn-repair.json", { force: true });
    fs.rmSync(binaryPath + ".zh-cn-repair.json.pending", { force: true });
    return { restored: true, version };
  } finally {
    io.withWindowsFileRetry(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  }
}

function main() {
  const [command, binaryPath, translationsPath, ...flags] = process.argv.slice(2);
  if (command === "restore" && binaryPath && !translationsPath) {
    process.stdout.write(JSON.stringify(restoreBinary(binaryPath)) + "\n");
    return;
  }
  if (!["patch", "scan"].includes(command) || !binaryPath || !translationsPath || flags.some(f => !["--json", "--dry-run", "--main-table-only"].includes(f))) {
    throw new Error("Usage: patch-bytecode.js <patch|scan> <binary> <translations.json> [--dry-run] [--json] [--main-table-only]");
  }
  const translations = JSON.parse(fs.readFileSync(translationsPath, "utf8"));
  const result = patchBinary(binaryPath, translations, { dryRun: command === "scan" || flags.includes("--dry-run"), mainTableOnly: flags.includes("--main-table-only") });
  process.stdout.write(flags.includes("--json") ? JSON.stringify(result) + "\n" : String(result.patched) + "\n");
}

module.exports = { patchStringPool, patchBinary, restoreBinary };
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`bytecode patch: ${error.message}\n`);
    process.exitCode = 1;
  }
}
