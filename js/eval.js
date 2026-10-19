/* DayPilot · Eval 评估流水线
 * 双层质量门：
 *   L1 规则校验（确定性）：结构、字段、时长预算、重复项
 *   L2 质量打分（LLM-as-Judge / 启发式）：0-10 分
 * 不达标 → 自动重试（最多 maxRetries 次），全程留痕可审计
 */
window.DP = window.DP || {};

DP.eval = (function () {

  /**
   * L1 规则校验：规划结果必须满足的硬约束
   * @returns {{pass:boolean, issues:string[]}}
   */
  function validatePlan(tasks, maxMinutes) {
    var issues = [];
    if (!Array.isArray(tasks)) {
      return { pass: false, issues: ["输出不是任务数组（JSON 结构错误）"] };
    }
    if (tasks.length < 3) issues.push("任务数过少（" + tasks.length + " < 3），规划不充分");
    if (tasks.length > 5) issues.push("任务数过多（" + tasks.length + " > 5），超出单日可执行粒度");

    var total = 0;
    var seen = {};
    tasks.forEach(function (t, i) {
      var tag = "任务" + (i + 1);
      if (!t || typeof t !== "object") { issues.push(tag + "：不是合法对象"); return; }
      if (!t.title || !String(t.title).trim()) issues.push(tag + "：缺少标题");
      else if (String(t.title).length > 30) issues.push(tag + "：标题超过 30 字，不够精炼");
      if (["高", "中", "低"].indexOf(t.priority) < 0) issues.push(tag + "：优先级非法（必须为 高/中/低）");
      var m = parseInt(t.minutes, 10);
      if (!m || m < 5 || m > 240) issues.push(tag + "：预估时长非法（需 5-240 分钟）");
      else total += m;
      if (t.title) {
        var k = String(t.title).trim();
        if (seen[k]) issues.push(tag + "：与其它任务标题重复");
        seen[k] = true;
      }
    });
    if (maxMinutes && total > maxMinutes) {
      issues.push("总时长 " + total + " 分钟超出可用预算 " + maxMinutes + " 分钟（规划超载）");
    }
    return { pass: issues.length === 0, issues: issues, totalMinutes: total };
  }

  /* ---------- 复盘 / 周报校验（2026-10-16 补齐） ----------
   * 设计说明：这两类输出只做「格式门」，不做「质量门」。
   *   规划是「生成物」——质量不达标就该重新生成；
   *   复盘 / 周报是「诊断与总结」——低分本身就是合法结果（那天确实没做好），
   *   拦截低分等于把真实诊断藏起来。所以只校验结构与字段。
   * 调用时用 threshold: null 表达「只做格式门」。
   */
  function validateReview(out) {
    var issues = [];
    if (!out || typeof out !== "object") return { pass: false, issues: ["复盘输出不是合法对象"] };

    var s = parseInt(out.score, 10);
    if (!(s >= 1 && s <= 10)) issues.push("score 非法（需 1-10 整数）：" + String(out.score));

    if (!out.comment || !String(out.comment).trim()) issues.push("缺少总体点评 comment");
    else if (String(out.comment).length > 120) issues.push("comment 过长（" + String(out.comment).length + " > 120 字）");

    if (!out.diagnosis || !String(out.diagnosis).trim()) issues.push("缺少问题诊断 diagnosis");
    else if (String(out.diagnosis).length > 120) issues.push("diagnosis 过长（" + String(out.diagnosis).length + " > 120 字）");

    if (!Array.isArray(out.suggestions) || out.suggestions.length < 2) issues.push("suggestions 少于 2 条");
    else if (out.suggestions.some(function (x) { return !x || !String(x).trim(); })) issues.push("suggestions 含空条目");

    return { pass: issues.length === 0, issues: issues };
  }

  function validateWeekly(report) {
    var issues = [];
    var txt = (typeof report === "string") ? report : (report && report.report);
    if (!txt || !String(txt).trim()) return { pass: false, issues: ["周报为空"] };
    txt = String(txt).trim();
    if (txt.length < 30) issues.push("周报过短（" + txt.length + " 字 < 30）");
    else if (txt.length > 400) issues.push("周报过长（" + txt.length + " 字 > 400）");
    return { pass: issues.length === 0, issues: issues };
  }

  /* ---------- 异常分类：决定「网络 / JSON 抖动」要不要重试 ----------
   * 2026-10-16 修复：原来 opts.generate 抛错会直接冒泡出 gate()，
   * 网络中断 / 模型返回非 JSON / 限流，全都算「失败」，一次都不重试。
   */
  function classifyError(err) {
    var msg = String((err && err.message) || err || "");
    // 鉴权类：重试没有意义，直接中止，让用户去改 Key
    if (/API 错误 (401|403)/.test(msg) || /invalid api key|unauthorized|Incorrect API/i.test(msg)) {
      return { retriable: false, kind: "auth", message: msg };
    }
    // 限流 / 服务端错误 / 网络中断 / 输出非 JSON：可重试的瞬时故障
    if (/API 错误 (429|5\d\d)/.test(msg) || /模型输出不是合法 JSON/.test(msg) ||
        /Failed to fetch|NetworkError|network|timeout|ECONN|ETIMEDOUT/i.test(msg)) {
      return { retriable: true, kind: "transient", message: msg };
    }
    return { retriable: true, kind: "unknown", message: msg };
  }

  /**
   * L2 启发式打分（Mock 模式 / LLM judge 的降级方案）
   * 维度：时长利用率、优先级结构、目标覆盖度
   */
  function heuristicScore(tasks, goals, maxMinutes) {
    if (!Array.isArray(tasks) || !tasks.length) return { score: 0, comment: "无有效任务" };
    var score = 10;
    var notes = [];

    var total = tasks.reduce(function (s, t) { return s + (parseInt(t.minutes, 10) || 0); }, 0);
    if (maxMinutes) {
      var util = total / maxMinutes;
      if (util < 0.4) { score -= 2; notes.push("时长利用率偏低（" + Math.round(util * 100) + "%），规划偏保守"); }
      else if (util > 1) { score -= 4; notes.push("超出时间预算"); }
      else notes.push("时长利用率 " + Math.round(util * 100) + "%");
    }

    var high = tasks.filter(function (t) { return t.priority === "高"; }).length;
    if (high === 0) { score -= 2; notes.push("缺少高优先级任务，重点不突出"); }
    else if (high > 2) { score -= 1; notes.push("高优先级任务偏多，注意精力分配"); }
    else notes.push("优先级结构合理");

    if (goals && goals.length) {
      var text = tasks.map(function (t) { return t.title; }).join(" ");
      var covered = goals.filter(function (g) {
        return g.split(/[，,：:（(]/)[0].split(/\s+/).some(function (kw) {
          return kw.length >= 2 && text.indexOf(kw.slice(0, 4)) >= 0;
        });
      }).length;
      if (covered === 0) { score -= 3; notes.push("任务与目标池脱节"); }
      else notes.push("覆盖 " + covered + "/" + goals.length + " 个目标方向");
    }

    score = Math.max(1, Math.min(10, score));
    return { score: score, comment: notes.join("；") };
  }

  /**
   * 质量门主流程：生成 → L1 校验 → L2 打分 → 不达标重试
   * @param {object} opts { name, generate(attempt), validate(result), judge(result), threshold, maxRetries }
   * @returns {Promise<{ok, result, report}>}
   */
  async function gate(opts) {
    // threshold 传 null → 只做格式门，不做质量门（复盘 / 周报用）
    var threshold = opts.threshold === undefined ? 7 : opts.threshold;
    var maxRetries = opts.maxRetries == null ? 2 : opts.maxRetries;
    var attempts = [];
    var best = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      var result, v, j, rec;

      // 2026-10-16 修复：generate 抛错不再直接冒泡，而是计入一次尝试
      try {
        result = await opts.generate(attempt);
        v = opts.validate(result);
        j = (v.pass && opts.judge) ? await opts.judge(result) : null;
      } catch (err) {
        var c = classifyError(err);
        attempts.push({
          attempt: attempt + 1,
          pass: false,
          score: 0,
          comment: c.message,
          issues: ["调用异常（" + c.kind + "）"],
          error: { kind: c.kind, retriable: c.retriable, message: c.message }
        });
        if (!c.retriable) break; // 401/403 之类，重试也没用，直接中止
        continue;
      }

      var score = j ? j.score : null;
      var pass = v.pass && (threshold === null || score === null || score >= threshold);
      attempts.push({
        attempt: attempt + 1,
        pass: pass,
        issues: v.issues || [],
        score: score,
        comment: j ? j.comment : ""
      });

      if (!best || (v.pass && (!j || score > (best._score || -1)))) {
        best = result;
        if (best && typeof best === "object") best._score = j ? score : 0;
      }
      if (pass) break;
    }

    var finalRec = attempts[attempts.length - 1] || { pass: false };
    var report = {
      name: opts.name,
      attempts: attempts,
      retries: attempts.length - 1,
      finalPass: !!finalRec.pass,
      finalScore: finalRec.score == null ? null : finalRec.score,
      mode: DP.llm && DP.llm.isLive() ? "live" : "mock",
      threshold: threshold,
      errors: attempts.filter(function (a) { return a.error; }).length
    };

    if (best && typeof best === "object" && best._score !== undefined) delete best._score;
    return { ok: !!finalRec.pass, result: best, report: report };
  }

  return {
    validatePlan: validatePlan,
    validateReview: validateReview,
    validateWeekly: validateWeekly,
    classifyError: classifyError,
    heuristicScore: heuristicScore,
    gate: gate
  };
})();
