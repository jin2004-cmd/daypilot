/* DayPilot · 视图层（今日 / AI规划 / 复盘 / 数据 / 设置） */
window.DP = window.DP || {};

(function () {
  var currentTab = "today";
  var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var RING_C = 2 * Math.PI * 40; // 进度环周长

  var plan = { hours: 4, busy: false, result: null, report: null, picked: [] };
  var reviewBusy = false;
  var loadingTimer = null;

  /* ---------- 工具 ---------- */
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var toastTimer = null;
  function toast(msg) {
    var t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function openModal(title, body, buttons) {
    el("modal").innerHTML = "<h3>" + esc(title) + "</h3><div class='modal-body'>" + body + "</div>" +
      "<div class='btn-row'>" + (buttons || "<button class='btn btn-primary btn-block' onclick='DP.ui.closeModal()'>好的</button>") + "</div>";
    el("modal-mask").classList.remove("hidden");
  }
  function closeModal() { el("modal-mask").classList.add("hidden"); }

  function pChip(p) {
    var cls = p === "高" ? "p-high" : p === "低" ? "p-low" : "p-mid";
    return "<span class='chip " + cls + "'>" + p + "</span>";
  }

  function startLoading(steps) {
    var i = 0;
    var box = el("loading-text");
    if (box) box.textContent = steps[0];
    stopLoading();
    loadingTimer = setInterval(function () {
      i = (i + 1) % steps.length;
      var b = el("loading-text");
      if (b) b.textContent = steps[i];
    }, 1000);
  }
  function stopLoading() { if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; } }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    var t = DP.store.settings().theme || "auto";
    var dark = t === "dark" || (t === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("dark", dark);
  }

  /* ---------- 手势：左滑删除 / 右滑完成 ---------- */
  function bindSwipe() {
    var items = document.querySelectorAll(".task-item[data-id]");
    Array.prototype.forEach.call(items, function (item) {
      var id = item.getAttribute("data-id");
      var sx = 0, dx = 0, tracking = false;
      item.addEventListener("touchstart", function (e) {
        sx = e.touches[0].clientX; dx = 0; tracking = true;
      }, { passive: true });
      item.addEventListener("touchmove", function (e) {
        if (!tracking) return;
        dx = e.touches[0].clientX - sx;
        if (Math.abs(dx) > 8) item.style.transform = "translateX(" + (dx * 0.55) + "px)";
      }, { passive: true });
      item.addEventListener("touchend", function () {
        tracking = false;
        item.style.transform = "";
        if (dx > 90) {
          DP.store.toggleTask(DP.store.dateStr(), id);
          afterToggle();
        } else if (dx < -90) {
          DP.store.deleteTask(DP.store.dateStr(), id);
          toast("🗑 已删除");
          route("today");
        }
        dx = 0;
      });
    });
  }

  /* ---------- 完成反馈：震动 + 全清庆祝 ---------- */
  function afterToggle() {
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) {} }
    var st = DP.store.dayStats(DP.store.dateStr());
    route("today");
    if (st.total > 0 && st.done === st.total) setTimeout(confetti, 280);
  }

  function confetti() {
    var colors = ["#4f6df5", "#ffd166", "#16a34a", "#e5484d", "#3b82f6", "#a855f7"];
    for (var i = 0; i < 42; i++) {
      (function (i) {
        var p = document.createElement("div");
        p.className = "confetti-piece";
        p.style.left = (Math.random() * 100) + "vw";
        p.style.background = colors[i % colors.length];
        p.style.width = (6 + Math.random() * 6) + "px";
        p.style.height = (10 + Math.random() * 8) + "px";
        p.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
        p.style.animationDelay = (Math.random() * 0.35) + "s";
        p.style.transform = "rotate(" + Math.floor(Math.random() * 360) + "deg)";
        document.body.appendChild(p);
        setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 3600);
      })(i);
    }
    toast("🎉 今日事今日毕！");
  }

  /* ---------- 数字滚动动画 ---------- */
  function animateCounts() {
    var nodes = document.querySelectorAll("[data-count]");
    Array.prototype.forEach.call(nodes, function (b) {
      var target = parseInt(b.getAttribute("data-count"), 10) || 0;
      var pre = b.getAttribute("data-prefix") || "";
      var suf = b.getAttribute("data-suffix") || "";
      var t0 = null, dur = 750;
      function step(ts) {
        if (!t0) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur);
        var v = Math.round(target * (1 - Math.pow(1 - p, 3)));
        b.textContent = pre + v + suf;
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  /* ---------- 导航 ---------- */
  var TABS = [
    { id: "today", ico: "📋", lbl: "今日" },
    { id: "plan", ico: "🤖", lbl: "AI规划" },
    { id: "review", ico: "🌙", lbl: "复盘" },
    { id: "stats", ico: "📊", lbl: "数据" },
    { id: "settings", ico: "⚙️", lbl: "设置" }
  ];

  function renderTabbar() {
    el("tabbar").innerHTML = TABS.map(function (t) {
      return "<div class='tab" + (t.id === currentTab ? " active" : "") + "' onclick=\"DP.ui.switchTab('" + t.id + "')\">" +
        "<span class='ico'>" + t.ico + "</span><span class='lbl'>" + t.lbl + "</span></div>";
    }).join("");
  }

  function route(tab) {
    currentTab = tab;
    renderTabbar();
    var v = el("view");
    v.className = "tab-" + tab;
    if (tab === "today") v.innerHTML = vToday();
    else if (tab === "plan") v.innerHTML = vPlan();
    else if (tab === "review") v.innerHTML = vReview();
    else if (tab === "stats") v.innerHTML = vStats();
    else if (tab === "settings") v.innerHTML = vSettings();
    if (tab === "today") bindSwipe();
    if (tab === "stats") animateCounts();
    window.scrollTo(0, 0);
  }

  /* ========== 视图：今日 ========== */
  function vToday() {
    var ds = DP.store.dateStr();
    var day = DP.store.getDay(ds);
    var st = DP.store.dayStats(ds);
    var d = new Date();
    var rate = st.total ? st.done / st.total : 0;
    var offset = RING_C * (1 - rate);
    var streak = DP.store.streak();

    var html = "<div class='page-head'><h1>今天 · " + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + WEEK[d.getDay()] + "</h1>" +
      "<div class='sub'>DayPilot 日航 · " + (DP.llm.isLive() ? "DeepSeek 已接入" : "Mock 演示模式") + "</div></div>";

    html += "<div class='today-layout'><div class='card hero'>" +
      "<div class='ring-wrap'><svg width='92' height='92'>" +
      "<circle cx='46' cy='46' r='40' stroke='#eef1fe' stroke-width='8' fill='none'/>" +
      "<circle cx='46' cy='46' r='40' stroke='" + (rate >= 1 ? "#16a34a" : "#4f6df5") + "' stroke-width='8' fill='none' stroke-linecap='round' " +
      "stroke-dasharray='" + RING_C.toFixed(1) + "' stroke-dashoffset='" + offset.toFixed(1) + "'/></svg>" +
      "<div class='ring-num'><b>" + st.done + "/" + st.total + "</b><span>已完成</span></div></div>" +
      "<div class='hero-info'><h2>" + (st.total === 0 ? "今天还没安排" : rate >= 1 ? "今日事今日毕 🎉" : rate >= 0.5 ? "过半了，继续" : "稳步前进中") + "</h2>" +
      "<div class='muted'>" + (st.total === 0 ? "让 AI 帮你把目标拆成今天的事" : "完成率 " + Math.round(rate * 100) + "% · 预计 " + day.tasks.reduce(function (s, t) { return s + (t.done ? 0 : t.minutes); }, 0) + " 分钟收尾") + "</div>" +
      (streak > 0 ? "<span class='streak-badge'>🔥 连续全清 " + streak + " 天</span>" : "") +
      "</div></div>";

    if (st.total === 0) {
      html += "<div class='card empty'><div class='emoji'>🧭</div>" +
        "<p>早上花 1 分钟规划，晚上少 1 小时后悔。<br>选一个方式开始今天：</p>" +
        "<div class='btn-row'><button class='btn btn-primary' onclick='DP.ui.useTemplate()'>🎓 秋招模板</button>" +
        "<button class='btn' onclick=\"DP.ui.switchTab('plan')\">🤖 AI 规划</button></div></div>";
    } else {
      var sorted = day.tasks.slice().sort(function (a, b) {
        var w = { "高": 0, "中": 1, "低": 2 };
        return (a.done - b.done) || (w[a.priority] - w[b.priority]);
      });
      html += "<div class='task-list'>" + sorted.map(function (t) {
        return "<div class='task-item" + (t.done ? " done" : "") + "' data-id='" + t.id + "'>" +
          "<div class='task-check' onclick=\"DP.ui.toggleTask('" + t.id + "')\">✓</div>" +
          "<div class='task-body'><div class='task-title' onclick=\"DP.ui.openEdit('" + t.id + "')\">" + esc(t.title) + "</div>" +
          "<div class='task-meta'>" + pChip(t.priority) + "<span class='chip chip-time'>⏱ " + t.minutes + " 分钟</span></div></div>" +
          "<button class='task-del' onclick=\"DP.ui.delTask('" + t.id + "')\">×</button></div>";
      }).join("") + "</div>";

      html += "<div class='today-side'><div class='card'><div class='card-title'>➕ 临时加一件</div>" +
        "<div class='btn-row' style='align-items:stretch'>" +
        "<input type='text' id='quick-input' placeholder='任务内容…' style='flex:3'>" +
        "<select id='quick-priority' style='flex:1'><option>高</option><option selected>中</option><option>低</option></select>" +
        "<button class='btn btn-primary' style='flex:1' onclick='DP.ui.addQuickTask()'>添加</button></div></div>";

      html += "<div class='btn-row'>" +
        "<button class='btn' onclick='DP.ui.syncICS()'>📅 同步到日历</button>" +
        "<button class='btn btn-primary' onclick=\"DP.ui.switchTab('review')\">🌙 晚间复盘</button></div></div>";
    }
    html += "</div>";
    return html;
  }

  /* ========== 视图：AI 规划 ========== */
  function vPlan() {
    var goals = DP.store.goals().join("\n");
    var html = "<div class='page-head'><h1>🤖 AI 规划今天</h1><div class='sub'>目标池 → DeepSeek 拆解 → eval 质量门 → 今日清单</div></div>";

    html += "<div class='card'><div class='card-title'>🎯 我的目标池</div>" +
      "<textarea id='goals-input' rows='4' placeholder='每行一个目标…'>" + esc(goals) + "</textarea>" +
      "<div style='margin-top:10px'><button class='btn btn-ghost' onclick='DP.ui.saveGoals()'>💾 保存目标池</button></div></div>";

    html += "<div class='card'><div class='card-title'>⏳ 今天可用时长</div>" +
      "<div class='slider-row'><input type='range' min='1' max='10' step='0.5' value='" + plan.hours + "' oninput=\"DP.ui.setHours(this.value)\">" +
      "<span class='slider-val' id='hours-val'>" + plan.hours + "h</span></div>" +
      "<button class='btn btn-primary btn-block' style='margin-top:14px' " + (plan.busy ? "disabled" : "") + " onclick='DP.ui.runPlan()'>✨ 生成今日计划</button></div>";

    if (plan.busy) {
      html += "<div class='card loading-steps'><div class='spinner'></div><div class='step-text' id='loading-text'>🤖 AI 正在拆解目标…</div></div>" +
        "<div class='card'><div class='skel skel-row'></div><div class='skel skel-row' style='width:94%'></div><div class='skel skel-row' style='width:86%'></div></div>";
    }

    if (!plan.busy && plan.result) {
      var r = plan.report;
      var badgeCls = r.finalPass ? "ok" : "warn";
      var badgeTxt = r.finalPass
        ? (r.retries === 0 ? "✅ eval 质量门：一次通过" : "🔁 eval 质量门：拦截不合规输出，重试 " + r.retries + " 次后通过")
        : "⚠️ eval：多次重试未完全达标，已采用最佳结果";
      html += "<div class='eval-badge " + badgeCls + "'>" + badgeTxt + "<span class='score'>" + r.finalScore + "/10</span></div>";
      if (r.retries > 0 && r.attempts[0].issues.length) {
        html += "<div class='eval-issues'>首次输出被拦截原因：" + r.attempts[0].issues.map(esc).join("；") + "</div>";
      }
      html += "<div class='card' style='margin-top:12px'><div class='card-title'>📋 AI 建议清单（点选采纳）</div>";
      html += plan.result.map(function (t, i) {
        return "<div class='plan-pick" + (plan.picked[i] ? " on" : "") + "' onclick='DP.ui.togglePick(" + i + ")'>" +
          "<div class='dot'>✓</div><div class='task-body'><div class='task-title'>" + esc(t.title) + "</div>" +
          "<div class='task-meta'>" + pChip(t.priority) + "<span class='chip chip-time'>⏱ " + t.minutes + " 分钟</span></div></div></div>";
      }).join("");
      html += "<button class='btn btn-primary btn-block' style='margin-top:10px' onclick='DP.ui.adoptPlan()'>📥 加入今日清单</button></div>";
    }
    return html;
  }

  /* ========== 视图：复盘 ========== */
  function vReview() {
    var ds = DP.store.dateStr();
    var day = DP.store.getDay(ds);
    var st = DP.store.dayStats(ds);

    var html = "<div class='page-head'><h1>🌙 晚间复盘</h1><div class='sub'>AI 教练根据今日完成度打分 · 诊断 · 给明日建议</div></div>";

    html += "<div class='card'><div class='card-title'>📌 今日战况</div>" +
      "<div class='muted'>完成 " + st.done + " / " + st.total + " 项 · 完成率 " + Math.round(st.rate * 100) + "%</div></div>";

    if (!day.review) {
      html += "<button class='btn btn-primary btn-block' " + (reviewBusy ? "disabled" : "") + " onclick='DP.ui.runReview()'>" +
        (reviewBusy ? "复盘中…" : "✨ 生成 AI 复盘") + "</button>";
      if (reviewBusy) html += "<div class='card loading-steps' style='margin-top:14px'><div class='spinner'></div><div class='step-text' id='loading-text'>🌙 AI 教练复盘ing…</div></div>";
    } else {
      var rv = day.review;
      html += "<div class='card'><div class='score-dial'><span class='num'>" + rv.score + "</span><span class='of'> / 10</span></div>" +
        "<div class='review-block'><div class='rb-title'>💬 总体点评</div><p>" + esc(rv.comment) + "</p></div>" +
        "<div class='review-block'><div class='rb-title'>🔍 诊断</div><p>" + esc(rv.diagnosis) + "</p></div>" +
        "<div class='review-block'><div class='rb-title'>🚀 明日建议</div><ul>" +
        rv.suggestions.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul></div>" +
        "<hr class='sep'><button class='btn btn-ghost btn-block' onclick='DP.ui.rerunReview()'>🔄 重新生成</button></div>";
    }

    var hist = DP.store.lastNDays(7).filter(function (d) { return d.total > 0; });
    if (hist.length) {
      html += "<div class='card' style='margin-top:14px'><div class='card-title'>🗓 近 7 天完成率</div>" +
        hist.map(function (d) {
          return "<div class='history-item'><span class='date'>" + d.label + "</span>" +
            "<div class='bar'><i style='width:" + Math.round(d.rate * 100) + "%'></i></div>" +
            "<span class='pct'>" + Math.round(d.rate * 100) + "%</span></div>";
        }).join("") + "</div>";
    }
    return html;
  }

  /* ========== 视图：数据 ========== */
  function vStats() {
    var days7 = DP.store.lastNDays(7);
    var streak = DP.store.streak();
    var totT = 0, doneT = 0;
    days7.forEach(function (d) { totT += d.total; doneT += d.done; });
    var rate7 = totT ? Math.round(doneT / totT * 100) : 0;
    var todayDs = DP.store.dateStr();

    var html = "<div class='page-head'><h1>📊 数据看板</h1><div class='sub'>行为量化 · eval 日志全量留痕</div></div>";

    html += "<div class='stat-grid'>" +
      "<div class='stat-cell'><b data-count='" + streak + "' data-prefix='🔥 '>0</b><span>连续全清(天)</span></div>" +
      "<div class='stat-cell'><b data-count='" + rate7 + "' data-suffix='%'>0</b><span>7日完成率</span></div>" +
      "<div class='stat-cell'><b data-count='" + doneT + "'>0</b><span>7日完成项</span></div></div>";

    html += "<div class='card'><div class='card-title'>📈 近 7 天</div><div class='week-chart'>" +
      days7.map(function (d) {
        var h = Math.max(4, Math.round(d.rate * 90));
        return "<div class='week-col" + (d.date === todayDs ? " today" : "") + "'>" +
          "<div class='col-bar' style='height:" + h + "px' title='" + d.done + "/" + d.total + "'></div>" +
          "<div class='col-label'>" + d.label + "</div></div>";
      }).join("") + "</div></div>";

    html += "<button class='btn btn-primary btn-block' onclick='DP.ui.runWeekly()'>📝 生成本周周报</button>";

    var logs = DP.store.evalLogs();
    html += "<div class='card' style='margin-top:14px'><div class='card-title'>🔍 Eval 评估日志（LLM 输出质量留痕）</div>";
    if (!logs.length) html += "<div class='muted'>还没有记录。去「AI规划」生成一次今日计划，质量门的工作过程会记在这里。</div>";
    else html += logs.slice(0, 10).map(function (l) {
      var dt = new Date(l.ts);
      var time = (dt.getMonth() + 1) + "/" + dt.getDate() + " " + String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      return "<div class='eval-log-item'><div class='el-head'><span>" + (l.name === "plan" ? "📋 规划" : l.name === "review" ? "🌙 复盘" : l.name === "weekly" ? "📝 周报" : esc(l.name)) +
        " · " + (l.finalPass ? "✅ 通过" : "⚠️ 未达标") + "</span><span>" + (l.finalScore != null ? l.finalScore + "/10" : "") + "</span></div>" +
        "<div class='el-detail'>" + time + " · " + (l.mode === "live" ? "DeepSeek" : "Mock") + " · 重试 " + l.retries + " 次" +
        (l.issues && l.issues.length ? "<br>首次拦截：" + l.issues.map(esc).join("；") : "") + "</div></div>";
    }).join("");
    html += "</div>";
    return html;
  }

  /* ========== 视图：设置 ========== */
  function vSettings() {
    var s = DP.store.settings();
    var live = DP.llm.isLive();
    var html = "<div class='page-head'><h1>⚙️ 设置</h1></div>";

    html += "<div class='card'><div class='card-title'>🧠 AI 引擎 &nbsp;" +
      (live ? "<span class='mode-pill live'>● DeepSeek 已接入</span>" : "<span class='mode-pill mock'>● Mock 演示模式</span>") + "</div>" +
      "<label class='field'><span class='label'>DeepSeek API Key（仅存在本机浏览器）</span>" +
      "<input type='password' id='set-key' value='" + esc(s.apiKey) + "' placeholder='sk-…'></label>" +
      "<label class='field'><span class='label'>Base URL</span><input type='url' id='set-base' value='" + esc(s.baseUrl) + "'></label>" +
      "<label class='field'><span class='label'>模型</span><input type='text' id='set-model' value='" + esc(s.model) + "'></label>" +
      "<div class='btn-row'><button class='btn btn-primary' onclick='DP.ui.saveSettings()'>💾 保存</button>" +
      "<button class='btn' onclick='DP.ui.testApi()'>🔌 测试连接</button></div>" +
      "<div class='muted' style='margin-top:10px'>不填 Key 也能完整体验全部功能（Mock 模式）；填入后自动切换真实 DeepSeek 接口。</div></div>";

    html += "<div class='card'><div class='card-title'>🎨 外观</div><div class='btn-row'>" +
      [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(function (m) {
        var on = (s.theme || "auto") === m[0];
        return "<button class='btn" + (on ? " btn-primary" : "") + "' onclick=\"DP.ui.setTheme('" + m[0] + "')\">" + m[1] + "</button>";
      }).join("") + "</div></div>";

    html += "<div class='card'><div class='card-title'>💾 数据</div>" +
      "<div class='btn-row'><button class='btn' onclick='DP.ui.exportData()'>📤 导出 JSON</button>" +
      "<button class='btn' onclick=\"document.getElementById('import-file').click()\">📥 导入 JSON</button></div>" +
      "<input type='file' id='import-file' accept='.json' class='hidden' onchange='DP.ui.importData(event)'>" +
      "<hr class='sep'><button class='btn btn-ghost btn-block' style='color:#e5484d' onclick='DP.ui.resetData()'>🗑 清空并重置全部数据</button></div>";

    html += "<div class='card'><div class='card-title'>ℹ️ 关于 DayPilot 日航</div>" +
      "<div class='muted' style='line-height:1.8'>早规划 · 晚复盘 · 数据说话。<br>" +
      "带 LLM 输出质量评估流水线（规则校验 + 模型打分 + 自动重试）的个人效能 Agent。<br>" +
      "数据 100% 存本机，开源免费。</div></div>";
    return html;
  }

  /* ========== 交互 ========== */
  DP.ui = {
    switchTab: function (tab) { route(tab); },
    closeModal: closeModal,

    toggleTask: function (id) {
      DP.store.toggleTask(DP.store.dateStr(), id);
      afterToggle();
    },
    delTask: function (id) {
      DP.store.deleteTask(DP.store.dateStr(), id);
      route("today");
    },
    addQuickTask: function () {
      var inp = el("quick-input");
      var title = inp.value.trim();
      if (!title) { toast("先写点内容"); return; }
      DP.store.addTask(DP.store.dateStr(), { title: title, priority: el("quick-priority").value, minutes: 30 });
      toast("已加入今日清单");
      route("today");
    },
    useTemplate: function () {
      DP.store.addTasks(DP.store.dateStr(), DP.templates.qiuzhaoTasks);
      DP.store.markOnboarded();
      toast("🎓 秋招模板已就位，开干！");
      route("today");
    },
    syncICS: function () {
      var ds = DP.store.dateStr();
      var tasks = DP.store.getDay(ds).tasks;
      if (DP.ics.download(tasks, ds)) toast("📅 已导出日历文件，打开即可写入手机日历");
      else toast("今天还没有任务");
    },

    saveGoals: function () {
      var lines = el("goals-input").value.split("\n").map(function (s) { return s.trim(); });
      DP.store.setGoals(lines);
      toast("目标池已保存");
    },
    setHours: function (v) {
      plan.hours = parseFloat(v);
      el("hours-val").textContent = plan.hours + "h";
    },
    togglePick: function (i) {
      plan.picked[i] = !plan.picked[i];
      route("plan");
    },

    runPlan: async function () {
      var goals = DP.store.goals();
      if (!goals.length) { toast("先保存目标池"); return; }
      plan.busy = true; plan.result = null; plan.report = null;
      route("plan");
      startLoading(["🤖 AI 正在拆解目标…", "🔍 L1 规则校验中…", "⚖️ L2 质量打分中…", "🔁 质量门复核中…"]);
      try {
        var res = await DP.eval.gate({
          name: "plan",
          generate: function (attempt) { return DP.llm.generatePlan(goals, plan.hours, attempt); },
          validate: function (t) { return DP.eval.validatePlan(t, Math.round(plan.hours * 60)); },
          judge: function (t) { return DP.llm.judgePlan(t, goals); },
          threshold: 7, maxRetries: 2
        });
        plan.result = res.result;
        plan.report = res.report;
        plan.picked = res.result.map(function () { return true; });
        DP.store.setPlanReport(DP.store.dateStr(), res.report);
        DP.store.logEval({
          name: "plan", retries: res.report.retries, finalPass: res.report.finalPass,
          finalScore: res.report.finalScore, mode: res.report.mode,
          issues: res.report.attempts[0] ? res.report.attempts[0].issues : []
        });
      } catch (e) {
        toast("生成失败：" + e.message);
      }
      plan.busy = false;
      stopLoading();
      route("plan");
    },

    adoptPlan: function () {
      var chosen = plan.result.filter(function (t, i) { return plan.picked[i]; });
      if (!chosen.length) { toast("至少选 1 件"); return; }
      DP.store.addTasks(DP.store.dateStr(), chosen);
      toast("📥 已加入今日清单，开干！");
      plan.result = null; plan.report = null;
      route("today");
    },

    runReview: async function () {
      var day = DP.store.getDay();
      if (!day.tasks.length) { toast("今天还没有任务，先规划一下"); return; }
      reviewBusy = true;
      route("review");
      startLoading(["🌙 AI 教练复盘ing…", "🔍 输出结构校验中…"]);
      try {
        // 2026-10-16 修复：原来这段是写在 app.js 里的简版校验（只查 3 项、异常不重试）。
        // 现在改走 DP.eval.gate，与规划共用同一套门。
        // threshold: null = 只做格式门——复盘的分数是给用户的诊断，低分是合法结果，不能拦截。
        var res = await DP.eval.gate({
          name: "review",
          generate: function (attempt) { return DP.llm.generateReview(day, DP.store.goals(), attempt); },
          validate: function (r) { return DP.eval.validateReview(r); },
          threshold: null, maxRetries: 2
        });
        var review = res.result;
        if (!review) review = { score: 5, comment: "复盘生成异常，这是兜底结果。", diagnosis: "LLM 输出连续未通过结构校验或调用异常。", suggestions: ["明天再试一次复盘"] };
        DP.store.setReview(DP.store.dateStr(), review);
        DP.store.logEval({
          name: "review", retries: res.report.retries, finalPass: res.report.finalPass,
          finalScore: review.score, mode: res.report.mode,
          issues: res.report.attempts[0] ? res.report.attempts[0].issues : []
        });
      } catch (e) {
        toast("复盘失败：" + e.message);
      }
      reviewBusy = false;
      stopLoading();
      route("review");
    },
    rerunReview: function () {
      DP.store.setReview(DP.store.dateStr(), null);
      DP.ui.runReview();
    },

    runWeekly: async function () {
      toast("📝 周报生成中…");
      try {
        // 2026-10-16 修复：周报此前零校验零重试，现在纳入 eval 门（只做格式门）
        var res = await DP.eval.gate({
          name: "weekly",
          generate: function (attempt) { return DP.llm.generateWeekly(DP.store.lastNDays(7), attempt); },
          validate: function (r) { return DP.eval.validateWeekly(r); },
          threshold: null, maxRetries: 2
        });
        var report = res.result;
        if (!report) { toast("周报生成失败，请稍后重试"); return; }
        DP.store.logEval({
          name: "weekly", retries: res.report.retries, finalPass: res.report.finalPass,
          finalScore: null, mode: res.report.mode,
          issues: res.report.attempts[0] ? res.report.attempts[0].issues : []
        });
        openModal("📝 本周周报", esc(report),
          "<button class='btn' onclick='DP.ui.closeModal()'>关闭</button>" +
          "<button class='btn btn-primary' onclick='DP.ui.copyText(" + JSON.stringify(JSON.stringify(report)) + ")'>📋 复制</button>");
      } catch (e) {
        toast("生成失败：" + e.message);
      }
    },
    copyText: function (text) {
      var t = JSON.parse(text);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { toast("已复制"); }, function () { toast("复制失败"); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败"); }
        document.body.removeChild(ta);
      }
    },

    saveSettings: function () {
      DP.store.setSettings({
        apiKey: el("set-key").value.trim(),
        baseUrl: el("set-base").value.trim() || "https://api.deepseek.com",
        model: el("set-model").value.trim() || "deepseek-chat"
      });
      toast("已保存");
      route("settings");
    },
    testApi: async function () {
      DP.ui.saveSettings();
      toast("🔌 测试连接中…");
      try {
        await DP.llm.testConnection();
        toast("✅ DeepSeek 连接成功");
      } catch (e) {
        toast("❌ " + e.message);
      }
    },
    exportData: function () {
      var blob = new Blob([DP.store.exportJSON()], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "daypilot-backup-" + DP.store.dateStr().replace(/-/g, "") + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast("已导出备份文件");
    },
    importData: function (evt) {
      var file = evt.target.files && evt.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          DP.store.importJSON(reader.result);
          toast("✅ 导入成功");
          route("today");
        } catch (e) { toast("❌ 导入失败：" + e.message); }
      };
      reader.readAsText(file);
      evt.target.value = "";
    },
    resetData: function () {
      openModal("确认清空？", "将删除本机全部任务、复盘与设置，且不可恢复。",
        "<button class='btn' onclick='DP.ui.closeModal()'>取消</button>" +
        "<button class='btn btn-primary' style='background:#e5484d' onclick='DP.ui.doReset()'>确认清空</button>");
    },
    doReset: function () {
      DP.store.resetAll();
      plan.result = null; plan.report = null;
      closeModal();
      toast("已重置");
      route("today");
    },

    setTheme: function (mode) {
      DP.store.setSettings({ theme: mode });
      applyTheme();
      route("settings");
    },

    openEdit: function (id) {
      var day = DP.store.getDay();
      var t = null;
      day.tasks.forEach(function (x) { if (x.id === id) t = x; });
      if (!t) return;
      openModal("✏️ 编辑任务",
        "<label class='field'><span class='label'>任务内容</span><input type='text' id='edit-title' value='" + esc(t.title) + "'></label>" +
        "<div class='btn-row' style='align-items:stretch'>" +
        "<select id='edit-priority' style='flex:1'>" +
        ["高", "中", "低"].map(function (p) { return "<option" + (p === t.priority ? " selected" : "") + ">" + p + "</option>"; }).join("") +
        "</select>" +
        "<input type='text' id='edit-minutes' inputmode='numeric' style='flex:1' value='" + t.minutes + "'></div>" +
        "<div class='muted' style='margin-top:8px'>左边选优先级，右边填预估分钟数</div>",
        "<button class='btn' onclick='DP.ui.closeModal()'>取消</button>" +
        "<button class='btn btn-primary' onclick=\"DP.ui.saveEdit('" + id + "')\">保存</button>");
    },
    saveEdit: function (id) {
      var title = el("edit-title").value.trim();
      if (!title) { toast("内容不能为空"); return; }
      var mins = parseInt(el("edit-minutes").value, 10) || 30;
      mins = Math.max(5, Math.min(240, mins));
      DP.store.editTask(DP.store.dateStr(), id, { title: title, priority: el("edit-priority").value, minutes: mins });
      closeModal();
      toast("已保存");
      route("today");
    },

    skipOnboard: function () {
      DP.store.markOnboarded();
      closeModal();
    },
    startTemplate: function () {
      DP.store.markOnboarded();
      closeModal();
      DP.ui.useTemplate();
    }
  };

  /* ---------- 启动 ---------- */
  DP.store.init();
  applyTheme();
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    } catch (e) {}
  }
  route("today");
  if (!DP.store.isOnboarded()) {
    openModal("🧭 欢迎使用 DayPilot 日航",
      "每天 3 步，让 AI 带你过一天：<br><br>" +
      "🌅 <b>早</b> · AI 把目标拆成今日 3-5 件事<br>" +
      "☀️ <b>白天</b> · 勾选打卡，一键同步手机日历<br>" +
      "🌙 <b>晚</b> · AI 复盘打分，给明日建议<br><br>" +
      "所有 AI 输出都要过 <b>eval 质量门</b>（规则校验 + 模型打分），不达标自动重试——全程在「数据」页留痕。",
      "<button class='btn' onclick='DP.ui.skipOnboard()'>随便看看</button>" +
      "<button class='btn btn-primary' onclick='DP.ui.startTemplate()'>🎓 秋招模板开始</button>");
  }
})();
