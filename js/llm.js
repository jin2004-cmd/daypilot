/* DayPilot · LLM 调用层
 * 双模运行：
 *   live  — 设置里填入 DeepSeek API Key 后，走真实接口（OpenAI 兼容协议）
 *   mock  — 无 Key 时的内置模拟引擎，全流程可跑通，eval 行为一致
 */
window.DP = window.DP || {};

DP.llm = (function () {

  function S() { return DP.store.settings(); }
  function isLive() { return !!(S().apiKey && S().apiKey.trim()); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- 真实 DeepSeek 调用 ---------- */
  async function chatLive(system, user) {
    var url = (S().baseUrl || "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions";
    var resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + S().apiKey.trim()
      },
      body: JSON.stringify({
        model: S().model || "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) throw new Error("API 错误 " + resp.status + "：" + (await resp.text()).slice(0, 200));
    var data = await resp.json();
    var content = data.choices && data.choices[0] && data.choices[0].message.content;
    return parseJSON(content);
  }

  function parseJSON(text) {
    if (!text) throw new Error("模型返回为空");
    var cleaned = String(text).replace(/```json|```/g, "").trim();
    var s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    var a = cleaned.indexOf("["), b = cleaned.lastIndexOf("]");
    try {
      if (a >= 0 && (s < 0 || a < s)) return JSON.parse(cleaned.slice(a, b + 1));
      return JSON.parse(cleaned.slice(s, e + 1));
    } catch (err) {
      throw new Error("模型输出不是合法 JSON");
    }
  }

  /* ---------- 规划 ---------- */
  var PLAN_SYS = "你是 DayPilot 日航的每日规划 Agent。把用户的目标池拆解成【今天】可执行的 3-5 个任务。" +
    "硬性要求：1) 任务必须具体、有动作、当天能完成；2) 标题不超过 20 字；3) priority 只能是 高/中/低，高优先级 1-2 个；" +
    "4) minutes 为预估分钟数(5-240)，所有任务总时长不得超过用户给的可用分钟数；" +
    '5) 只输出 JSON：{"tasks":[{"title":"...","priority":"高","minutes":60}]}';

  async function generatePlan(goals, hours, attempt) {
    if (isLive()) {
      var user = "目标池：\n" + goals.map(function (g, i) { return (i + 1) + ". " + g; }).join("\n") +
        "\n今日可用时长：" + Math.round(hours * 60) + " 分钟";
      if (attempt > 0) user += "\n（上一次输出未通过质量校验，请严格遵守全部硬性要求重新生成）";
      var data = await chatLive(PLAN_SYS, user);
      return data.tasks || data;
    }
    return mockPlan(goals, hours, attempt);
  }

  // Mock：第 0 次故意生成不合规输出（演示 eval 拦截），重试后合规
  async function mockPlan(goals, hours, attempt) {
    await sleep(900 + Math.random() * 600);
    var pool = DP.templates.mockPlanPool.slice();
    // 洗牌
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    if (attempt === 0) {
      // 故意犯规：6 个任务 + 总时长超预算 → 触发 L1 拦截
      var bad = pool.slice(0, 6).map(function (t) {
        return { title: t.title, priority: t.priority, minutes: t.minutes + 20 };
      });
      return bad;
    }
    // 合规输出：按预算挑 4 个
    var budget = Math.round(hours * 60 * 0.9);
    var picked = [], total = 0;
    for (var k = 0; k < pool.length && picked.length < 4; k++) {
      if (total + pool[k].minutes <= budget) { picked.push(pool[k]); total += pool[k].minutes; }
    }
    if (picked.length < 3) picked = pool.slice(0, 3);
    return picked.map(function (t) { return { title: t.title, priority: t.priority, minutes: t.minutes }; });
  }

  /* ---------- 质量打分（L2 Judge） ---------- */
  var JUDGE_SYS = "你是严格的日计划质量评审。从可执行性、优先级结构、时长合理性、与目标的相关性四个维度给计划打分。" +
    '只输出 JSON：{"score": 0到10的整数, "comment": "一句话评语，不超过50字"}';

  async function judgePlan(tasks, goals) {
    if (isLive()) {
      var user = "目标池：" + goals.join("；") + "\n计划：" +
        tasks.map(function (t) { return "[" + t.priority + "] " + t.title + "（" + t.minutes + "分钟）"; }).join("；");
      try {
        var data = await chatLive(JUDGE_SYS, user);
        return { score: Math.max(0, Math.min(10, parseInt(data.score, 10) || 0)), comment: String(data.comment || "") };
      } catch (e) {
        return DP.eval.heuristicScore(tasks, goals, 0); // 降级
      }
    }
    await sleep(600);
    return DP.eval.heuristicScore(tasks, goals, 0);
  }

  /* ---------- 复盘 ---------- */
  var REVIEW_SYS = "你是 DayPilot 的晚间复盘教练。根据今日任务完成情况输出复盘。" +
    '只输出 JSON：{"score": 1到10的整数, "comment": "总体点评80字内", "diagnosis": "问题诊断60字内，无问题则写亮点", "suggestions": ["明日建议1","明日建议2","明日建议3"]}';

  async function generateReview(day, goals, attempt) {
    if (isLive()) {
      var user = "目标池：" + goals.join("；") + "\n今日任务：\n" +
        day.tasks.map(function (t) {
          return "- [" + t.priority + "] " + t.title + "（" + t.minutes + "分钟）" + (t.done ? " ✅完成" : " ❌未完成");
        }).join("\n");
      // 2026-10-16：重试时把上一次失败原因告诉模型，与规划一致
      if (attempt > 0) user += "\n（上一次输出未通过结构校验，请严格遵守 JSON 结构与字数限制重新输出）";
      return await chatLive(REVIEW_SYS, user);
    }
    return mockReview(day);
  }

  async function mockReview(day) {
    await sleep(1100 + Math.random() * 600);
    var total = day.tasks.length;
    var done = day.tasks.filter(function (t) { return t.done; }).length;
    var rate = total ? done / total : 0;
    var T = DP.templates;
    var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

    var score, comment;
    if (rate >= 0.8) { score = 8 + Math.floor(Math.random() * 3); comment = pick(T.mockReviewGood); }
    else if (rate >= 0.5) { score = 5 + Math.floor(Math.random() * 3); comment = pick(T.mockReviewMid); }
    else { score = 2 + Math.floor(Math.random() * 3); comment = pick(T.mockReviewBad); }

    var highUndone = day.tasks.filter(function (t) { return t.priority === "高" && !t.done; });
    var diagnosis;
    if (!total) diagnosis = "今天没有任务记录，先让 AI 规划明天吧。";
    else if (highUndone.length) diagnosis = "高优先级任务「" + highUndone[0].title.slice(0, 16) + "」被遗留，存在优先级错配——明天把最难的事放在上午第一件事。";
    else if (rate >= 0.8) diagnosis = "亮点：高优先级任务全部清空，执行节奏健康。";
    else diagnosis = "低优先级任务完成较多但关键推进不足，明天清单先做减法。";

    var suggestions = [
      "明早开工先做 1 件高优先级任务，再碰消息和杂事",
      rate < 0.8 ? "明天任务数压到 " + Math.max(3, done) + " 件以内，先把完成率拉回 80%" : "保持当前节奏，可给明天加 1 件挑战性任务",
      "睡前花 3 分钟让 AI 预排明天，减少早晨决策成本"
    ];

    return { score: score, comment: comment, diagnosis: diagnosis, suggestions: suggestions };
  }

  /* ---------- 周报 ---------- */
  async function generateWeekly(days7, attempt) {
    var totalT = 0, doneT = 0, reviews = 0;
    days7.forEach(function (d) { totalT += d.total; doneT += d.done; if (d.hasReview) reviews++; });
    var rate = totalT ? Math.round(doneT / totalT * 100) : 0;
    var best = days7.slice().sort(function (a, b) { return b.rate - a.rate || b.done - a.done; })[0];

    if (isLive()) {
      var user = "近7天数据：" + days7.map(function (d) {
        return d.date + " 完成" + d.done + "/" + d.total;
      }).join("；") + "\n请输出 150 字内的中文周报，含数据总结、趋势判断、下周 1 条核心建议。";
      // 2026-10-16：重试时说明上一次失败原因
      if (attempt > 0) user += "\n（上一次输出未通过校验，请严格按 JSON 结构输出 30-400 字的 report 字段）";
      var txt = await chatLive("你是个人效能周报撰写助手，只输出JSON：{\"report\":\"...\"}", user);
      return txt && txt.report;
    }
    await sleep(900);
    return "【DayPilot 周报】\n" +
      "本周共规划 " + totalT + " 项任务，完成 " + doneT + " 项，完成率 " + rate + "%。\n" +
      (best && best.total ? "最佳单日：" + best.date + "（" + best.done + "/" + best.total + "）。\n" : "") +
      "完成 AI 复盘 " + reviews + " 次。\n" +
      (rate >= 80 ? "趋势：执行节奏健康，建议下周维持任务粒度，适当增加挑战性目标。" :
       rate >= 50 ? "趋势：完成率中等，建议下周把每日任务数做减法，优先保住高优先级事项。" :
       "趋势：完成率偏低，建议下周降低单日规划量，先恢复「规划→完成」的正反馈循环。");
  }

  /* ---------- 连接测试 ---------- */
  async function testConnection() {
    if (!isLive()) throw new Error("尚未填写 API Key，当前为 Mock 模式");
    var data = await chatLive("只输出JSON：{\"ok\":true}", "ping");
    return data;
  }

  return {
    isLive: isLive,
    generatePlan: generatePlan,
    judgePlan: judgePlan,
    generateReview: generateReview,
    generateWeekly: generateWeekly,
    testConnection: testConnection
  };
})();
