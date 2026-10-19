/* DayPilot eval 门 — 回归自测（2026-10-16 缺陷修复验证）
 * 用 node 跑：只加载 js/eval.js，用假的 window / DP.llm 做纯逻辑验证。
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// eval.js 里写的是 `window.DP = ...` 然后直接用全局 `DP`，
// 所以 sandbox 自身必须就是 window（跟浏览器一致），否则 DP 拿不到。
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "js/eval.js"), "utf8"), sandbox);
const DP = sandbox.DP;
const E = DP.eval;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}

console.log("\n【1】validateReview —— 格式校验覆盖项");
const badReview = { score: 12, comment: "", suggestions: ["ok"] };
const r1 = E.validateReview(badReview);
check("缺 diagnosis / score 越界 / comment 空 都能被检出", r1.pass === false && r1.issues.length >= 3, r1.issues);
const goodReview = { score: 8, comment: "今天执行不错。", diagnosis: "高优先级全清。", suggestions: ["a", "b", "c"] };
check("合法复盘通过", E.validateReview(goodReview).pass === true);
check("suggestions 含空条目被检出", E.validateReview({ score: 5, comment: "c", diagnosis: "d", suggestions: ["a", ""] }).pass === false);

console.log("\n【2】validateWeekly —— 长度区间");
check("空周报被拦截", E.validateWeekly("").pass === false);
check("过短(<30字)被拦截", E.validateWeekly("本周完成3项").pass === false);
const okWeekly = "本周共规划 12 项任务，完成 9 项，完成率 75%。最佳单日 10/12。完成 AI 复盘 4 次。趋势：执行节奏健康，建议下周维持任务粒度，适当增加挑战性目标。";
check("合法周报通过", E.validateWeekly(okWeekly).pass === true);
check("过长(>400字)被拦截", E.validateWeekly("字".repeat(401)).pass === false);

console.log("\n【3】classifyError —— 异常可重试判定");
check("401 判定为不可重试", E.classifyError(new Error("API 错误 401：Unauthorized")).retriable === false);
check("429 判定为可重试", E.classifyError(new Error("API 错误 429：rate limited")).retriable === true);
check("500 判定为可重试", E.classifyError(new Error("API 错误 500：server error")).retriable === true);
check("非 JSON 输出判定为可重试", E.classifyError(new Error("模型输出不是合法 JSON")).retriable === true);
check("网络中断判定为可重试", E.classifyError(new Error("Failed to fetch")).retriable === true);

(async function () {
  console.log("\n【4】gate() —— 网络/JSON 异常现在会重试（原缺陷）");
  let calls = 0;
  const resA = await E.gate({
    name: "t-transient",
    generate: async function () {
      calls++;
      if (calls === 1) throw new Error("Failed to fetch");
      return [{ title: "写周报", priority: "高", minutes: 60 }, { title: "跑步", priority: "中", minutes: 30 }, { title: "读书", priority: "低", minutes: 30 }];
    },
    validate: function (t) { return E.validatePlan(t, 480); },
    judge: function () { return { score: 8, comment: "ok" }; },
    threshold: 7, maxRetries: 2
  });
  check("第一次抛网络错后仍重试并最终通过", calls === 2 && resA.ok === true, { calls, ok: resA.ok });
  check("report 记录了 1 次异常", resA.report.errors === 1, resA.report.errors);

  console.log("\n【5】gate() —— 鉴权错误不重试（重试没意义）");
  let authCalls = 0;
  const resB = await E.gate({
    name: "t-auth",
    generate: async function () { authCalls++; throw new Error("API 错误 401：Invalid API key"); },
    validate: function () { return { pass: true, issues: [] }; },
    threshold: null, maxRetries: 2
  });
  check("401 只调用 1 次就中止", authCalls === 1, { authCalls });
  check("401 结果为未通过", resB.ok === false);

  console.log("\n【6】gate() —— threshold:null 只做格式门（复盘/周报语义）");
  let rcalls = 0;
  const resC = await E.gate({
    name: "review",
    generate: async function (attempt) {
      rcalls++;
      if (attempt === 0) return { score: 3, comment: "x" };       // 缺 diagnosis/suggestions
      return { score: 3, comment: "今天完成率低。", diagnosis: "关键任务被遗留。", suggestions: ["先做难事", "减少任务数"] };
    },
    validate: function (r) { return E.validateReview(r); },
    threshold: null, maxRetries: 2
  });
  check("格式不合规触发重试", rcalls === 2, { rcalls });
  check("最终通过", resC.ok === true);
  check("score=3 的低分复盘没有被质量门拦截（诊断是合法结果）", resC.result.score === 3, resC.result.score);

  console.log("\n【7】gate() —— 规划仍保留质量门（分数低要重生成）");
  let pcalls = 0;
  await E.gate({
    name: "plan",
    generate: async function () {
      pcalls++;
      return [{ title: "写周报", priority: "高", minutes: 60 }, { title: "跑步", priority: "中", minutes: 30 }, { title: "读书", priority: "低", minutes: 30 }];
    },
    validate: function (t) { return E.validatePlan(t, 480); },
    judge: function () { return { score: 4, comment: "质量偏低" }; },
    threshold: 7, maxRetries: 2
  });
  check("分数 4 < 阈值 7 → 触发全部重试", pcalls === 3, { pcalls });

  console.log("\n———— 结果：" + pass + " 通过 / " + fail + " 失败 ————\n");
  process.exit(fail ? 1 : 0);
})();
