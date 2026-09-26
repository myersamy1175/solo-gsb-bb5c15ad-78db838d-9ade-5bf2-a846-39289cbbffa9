/* OpenAPI 兼容性审查 —— 原生 JS 前端（无构建、无框架） */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    review: null,          // 当前审查结果（含 findings/summary/id）
    filter: { severity: "all", direction: "all", category: "all", text: "" },
    tree: { side: "new", pointer: "", data: null, loading: false },
    expandedFinding: null,
    view: "flat",          // flat=逐条发现 | groups=根因聚合
    groups: null,          // 聚合结果缓存（按当前审查）
    groupsMeta: null,
    groupsPromise: null,   // 进行中的聚合请求（防重复拉取）
    reconcile: null,       // 破坏项对账结果（针对当前审查）
  };

  const SEV_LABEL = {
    breaking: "破坏性",
    non_breaking: "兼容",
    deprecation: "废弃",
    info: "信息",
  };
  const CHANGE_LABEL = { added: "新增", removed: "删除", changed: "修改" };
  const DIRECTION_LABEL = {
    request: "请求", response: "响应", shared: "请求/响应", none: "结构",
  };
  const REL_LABEL = { primary: "主因", absorbed: "下游影响", same_cause: "同源" };
  const REL_TITLE = {
    primary: "该影响组的根因发现",
    absorbed: "父路径被整体替换/删除，该发现是其下游影响",
    same_cause: "共享/循环组件在多处引用产生的同一根因",
  };

  // ------------------------------------------------------------------ //
  // Tab 切换
  // ------------------------------------------------------------------ //
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`#tab-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "history") loadHistory();
    });
  });

  // ------------------------------------------------------------------ //
  // 输入：文件上传 / 示例 / 清空
  // ------------------------------------------------------------------ //
  $$("input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const side = input.dataset.side;
      const reader = new FileReader();
      reader.onload = () => {
        $(`#${side}-spec`).value = reader.result;
        $(`#${side}-filename`).textContent = file.name;
        $(`#${side}-filename`).title = file.name;
      };
      reader.readAsText(file);
    });
  });

  $$("[data-sample]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sample = window.SAMPLES[btn.dataset.sample];
      $("#old-spec").value = sample.old;
      $("#new-spec").value = sample.new;
      $("#old-filename").textContent = "sample-old.yaml 或 .json";
      $("#new-filename").textContent = "sample-new.yaml 或 .json";
      hideError();
    });
  });

  $("#clear-btn").addEventListener("click", () => {
    $("#old-spec").value = "";
    $("#new-spec").value = "";
    $("#old-filename").textContent = "";
    $("#new-filename").textContent = "";
    $("#result-area").classList.add("hidden");
    hideError();
  });

  $("#compare-btn").addEventListener("click", runCompare);

  // 逐条发现 / 根因聚合 视图切换
  $$("#view-toggle .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#view-toggle .toggle-btn").forEach((b) =>
        b.classList.toggle("active", b === btn));
      state.view = btn.dataset.view;
      renderCurrentView();
    });
  });

  async function runCompare() {
    const oldSpec = $("#old-spec").value;
    const newSpec = $("#new-spec").value;
    hideError();

    if (!oldSpec.trim() || !newSpec.trim()) {
      showError("请先在两侧粘贴或上传新旧两份 OpenAPI 文档。");
      return;
    }

    const btn = $("#compare-btn");
    btn.disabled = true;
    btn.textContent = "审查中…";
    $("#loading").classList.remove("hidden");
    $("#result-area").classList.add("hidden");

    try {
      const resp = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_spec: oldSpec,
          new_spec: newSpec,
          old_filename: $("#old-filename").textContent || null,
          new_filename: $("#new-filename").textContent || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const sideCn = data.detail?.side === "old" ? "旧版" :
                       data.detail?.side === "new" ? "新版" : "";
        showError(`${sideCn}文档${sideCn ? " " : ""}解析失败：${data.detail?.message || data.detail || "未知错误"}`);
        return;
      }
      state.review = data;
      state.filter = { severity: "all", direction: "all", category: "all", text: "" };
      renderResult();
    } catch (err) {
      showError(`请求失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "开始审查 →";
      $("#loading").classList.add("hidden");
    }
  }

  function showError(msg) {
    const el = $("#error-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function hideError() {
    $("#error-banner").classList.add("hidden");
  }

  // ------------------------------------------------------------------ //
  // 结果渲染
  // ------------------------------------------------------------------ //
  function renderResult() {
    const r = state.review;
    // 历史数据若没有引擎序号 id，按 1 起始位置补齐（与后端回退规则一致）
    (r.findings || []).forEach((f, i) => { if (f.id == null) f.id = i + 1; });
    // 重置视图状态：默认逐条发现，聚合缓存随审查失效
    state.view = "flat";
    state.groups = null;
    state.groupsMeta = null;
    state.groupsPromise = null;
    // 当前审查已切换：旧的对账结果失效，并更新对账面板的"当前审查"标签
    state.reconcile = null;
    $("#reconcile-result").innerHTML = "";
    $("#reconcile-status").classList.add("hidden");
    updateReconcileCurrent();
    $$("#view-toggle .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "flat"));
    $("#view-meta").textContent = "";
    $("#result-area").classList.remove("hidden");
    $("#result-title").textContent = r.title || `审查 #${r.id}`;
    $("#result-meta").textContent =
      `记录 #${r.id} · 版本 ${r.old_version || "?"} → ${r.new_version || "?"} · 共 ${r.summary.total} 条变更`;

    const verdict = $("#verdict");
    if (r.summary.compatible) {
      verdict.textContent = "✅ 向后兼容";
      verdict.className = "verdict good";
    } else {
      verdict.textContent = `❌ ${r.summary.counts.breaking} 项破坏性变更`;
      verdict.className = "verdict bad";
    }

    renderStats();
    populateCategoryFilter();
    bindFiltersOnce();
    syncFilterControls();
    renderCurrentView();
    loadPointers();
    loadTree();
  }

  function renderStats() {
    const c = state.review.summary.counts;
    const cards = [
      ["breaking", c.breaking || 0, "破坏性变更"],
      ["non_breaking", c.non_breaking || 0, "兼容性变更"],
      ["deprecation", c.deprecation || 0, "废弃提示"],
      ["info", c.info || 0, "信息性变更"],
    ];
    $("#stat-cards").innerHTML = cards.map(([sev, num, label]) =>
      `<div class="stat-card ${sev}"><div class="num">${num}</div><div class="label">${label}</div></div>`
    ).join("");

    $$("[data-count]").forEach((el) => {
      const key = el.dataset.count;
      el.textContent = key === "all"
        ? state.review.summary.total
        : (state.review.summary.counts[key] || 0);
    });
  }

  function populateCategoryFilter() {
    const cats = new Set(state.review.findings.map((f) => f.category));
    const sel = $("#category-filter");
    const current = sel.value;
    sel.innerHTML = `<option value="all">全部分类</option>` +
      Array.from(cats).sort().map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    sel.value = current && cats.has(current) ? current : "all";
  }

  let filtersBound = false;
  function bindFiltersOnce() {
    if (filtersBound) return;
    filtersBound = true;

    $$("#severity-filters .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#severity-filters .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.filter.severity = chip.dataset.severity;
        renderCurrentView();
      });
    });
    $("#direction-filter").addEventListener("change", (e) => {
      state.filter.direction = e.target.value;
      renderCurrentView();
    });
    $("#category-filter").addEventListener("change", (e) => {
      state.filter.category = e.target.value;
      renderCurrentView();
    });
    $("#text-filter").addEventListener("input", (e) => {
      state.filter.text = e.target.value.trim().toLowerCase();
      renderCurrentView();
    });
  }

  function syncFilterControls() {
    const f = state.filter;
    $$("#severity-filters .chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.severity === f.severity));
    $("#direction-filter").value = f.direction;
    $("#category-filter").value = f.category;
    $("#text-filter").value = f.text;
  }

  function filteredFindings() {
    const f = state.filter;
    return state.review.findings.filter((item) => {
      if (f.severity !== "all" && item.severity !== f.severity) return false;
      if (f.direction !== "all" && item.direction !== f.direction) return false;
      if (f.category !== "all" && item.category !== f.category) return false;
      if (f.text) {
        const hay = [
          item.message, item.location, item.endpoint,
          item.rule_id, item.category,
        ].join(" ").toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
  }

  function renderCurrentView() {
    if (state.view === "groups") {
      renderGroups();
    } else {
      renderFindings();
    }
  }

  function renderFindings() {
    const list = $("#findings-list");
    const items = filteredFindings();
    $("#view-meta").textContent = "";
    $("#findings-empty").classList.toggle("hidden", items.length > 0);

    // 破坏性优先，其次按分类/定位排序
    const order = { breaking: 0, deprecation: 1, non_breaking: 2, info: 3 };
    items.sort((a, b) =>
      (order[a.severity] - order[b.severity]) ||
      (a.endpoint || "").localeCompare(b.endpoint || "") ||
      a.id - b.id
    );

    list.innerHTML = items.map((f) => findingCard(f)).join("");

    list.querySelectorAll(".finding").forEach((card) => {
      const head = card.querySelector(".finding-head");
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        card.querySelector(".finding-body").classList.toggle("hidden");
      });
    });
    bindFindingInteractions(list);
  }

  /** 绑定发现卡片内的交互：引用树跳转 + 最小复现包导出（两种视图共用）。 */
  function bindFindingInteractions(root) {
    root.querySelectorAll("[data-tree-pointer]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const pointer = el.dataset.treePointer;
        if (!pointer) return;
        jumpToRef(el.dataset.treeRef || null, el.dataset.treeSide, pointer);
      });
    });
    root.querySelectorAll("[data-repro]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadRepro(Number(btn.dataset.repro), btn);
      });
    });
  }

  function refButtons(f) {
    return [
      f.old_ref ? `<button class="mini-link" title="在旧版引用树中查看"
          data-tree-ref="${escapeAttr(f.old_ref)}" data-tree-side="old"
          data-tree-pointer="${escapeAttr(f.old_ref)}">🌲旧</button>` : "",
      f.new_ref ? `<button class="mini-link" title="在新版引用树中查看"
          data-tree-ref="${escapeAttr(f.new_ref)}" data-tree-side="new"
          data-tree-pointer="${escapeAttr(f.new_ref)}">🌲新</button>` : "",
    ].join("");
  }

  /** 发现详情体：定位 / 双侧指针 / 旧新值 / 规则 / 复现导出（两种视图共用）。 */
  function findingBodyHtml(f) {
    const hasValues = f.old_value !== null || f.new_value !== null;
    const oldVal = hasValues
      ? `<div class="value-box"><div class="vb-label">旧值</div><pre>${escapeHtml(pretty(f.old_value))}</pre></div>` : "";
    const newVal = hasValues
      ? `<div class="value-box"><div class="vb-label">新值</div><pre>${escapeHtml(pretty(f.new_value))}</pre></div>` : "";
    return `
      <div class="loc-line">📍 ${escapeHtml(f.location)}</div>
      <div class="path-rows">
        <span class="k">旧路径</span>
        <code data-tree-side="old" data-tree-pointer="${escapeAttr(f.old_json_path || "")}"
          ${f.old_ref ? `data-tree-ref="${escapeAttr(f.old_ref)}"` : ""}>
          ${escapeHtml(f.old_json_path || "—（新版新增）")}</code>
        <span class="k">新路径</span>
        <code data-tree-side="new" data-tree-pointer="${escapeAttr(f.new_json_path || "")}"
          ${f.new_ref ? `data-tree-ref="${escapeAttr(f.new_ref)}"` : ""}>
          ${escapeHtml(f.new_json_path || "—（旧版删除）")}</code>
      </div>
      ${hasValues ? `<div class="value-diff">${oldVal}${newVal}</div>` : ""}
      <div class="rule-id">rule: ${escapeHtml(f.rule_id)} · 方向：${DIRECTION_LABEL[f.direction] || f.direction} · 分类：${escapeHtml(f.category)}</div>
      <div class="repro-row">
        <button class="mini-link repro-btn" data-repro="${f.id}"
          title="裁剪新旧文档，仅保留该发现所属路径/操作及其传递引用的组件，打包 ZIP 下载">📦 导出最小复现包</button>
        <span class="repro-hint">含 old.yaml / new.yaml / manifest.json，导出前会自动复核可复现性</span>
      </div>`;
  }

  function findingCard(f) {
    const bodyHidden = state.expandedFinding === f.id ? "" : "hidden";

    return `
    <article class="finding ${f.severity}" data-id="${f.id}">
      <div class="finding-head">
        <span class="finding-badge">${SEV_LABEL[f.severity] || f.severity}</span>
        ${f.endpoint ? `<span class="finding-endpoint">${escapeHtml(f.endpoint)}</span>` : ""}
        <p class="finding-msg">${escapeHtml(f.message)}</p>
        <span class="finding-meta">
          <span class="change-tag">${CHANGE_LABEL[f.change] || f.change}</span>
          ${refButtons(f)}
        </span>
      </div>
      <div class="finding-body ${bodyHidden}">
        ${findingBodyHtml(f)}
      </div>
    </article>`;
  }

  // ------------------------------------------------------------------ //
  // 根因聚合视图
  // ------------------------------------------------------------------ //
  async function ensureGroups() {
    if (state.groups) return;
    if (!state.groupsPromise) {
      const rid = state.review.id;
      state.groupsPromise = fetch(`/api/reviews/${rid}/groups`)
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          // 审查已切换时丢弃迟到结果
          if (state.review && state.review.id === rid) {
            state.groups = data.groups || [];
            state.groupsMeta = data;
          }
        })
        .finally(() => { state.groupsPromise = null; });
    }
    await state.groupsPromise;
  }

  function filteredGroups() {
    const f = state.filter;
    return (state.groups || []).filter((g) => {
      if (f.severity !== "all" && g.severity !== f.severity) return false;
      if (f.direction !== "all" && g.direction !== f.direction) return false;
      if (f.category !== "all" && g.category !== f.category) return false;
      if (f.text) {
        const hay = [
          g.rule_id, g.category, g.endpoint, g.primary.message, g.primary.location,
          ...g.affected.flatMap((a) => [a.message, a.location, a.rule_id]),
        ].join(" ").toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
  }

  async function renderGroups() {
    const list = $("#findings-list");
    if (!state.groups) {
      list.innerHTML = '<div class="empty-hint">正在计算根因聚合…</div>';
      $("#findings-empty").classList.add("hidden");
      try {
        await ensureGroups();
      } catch (err) {
        list.innerHTML = `<div class="empty-hint">聚合加载失败：${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    const meta = state.groupsMeta || {};
    $("#view-meta").textContent =
      `共 ${meta.total_findings ?? 0} 条发现 → ${meta.group_count ?? 0} 个影响组` +
      (meta.affected_count ? `（${meta.affected_count} 条为下游/同源影响）` : "");

    const groups = filteredGroups();
    $("#findings-empty").classList.toggle("hidden", groups.length > 0);
    list.innerHTML = groups.map((g) => groupCard(g)).join("");

    list.querySelectorAll(".group-head").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        head.parentElement.querySelector(":scope > .finding-body").classList.toggle("hidden");
      });
    });
    list.querySelectorAll(".entry-head").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        const body = head.nextElementSibling;
        if (body) body.classList.toggle("hidden");
      });
    });
    bindFindingInteractions(list);
  }

  function groupCard(g) {
    const p = g.primary;
    return `
    <article class="finding group ${g.severity}" data-gid="${escapeAttr(g.group_id)}">
      <div class="finding-head group-head">
        <span class="finding-badge">${SEV_LABEL[g.severity] || g.severity}</span>
        ${g.endpoint ? `<span class="finding-endpoint">${escapeHtml(g.endpoint)}</span>` : ""}
        <p class="finding-msg">${escapeHtml(p.message)}</p>
        <span class="finding-meta">
          <span class="group-size" title="组内发现总数（主因 + 受影响条目）">${g.member_count} 条</span>
          <span class="change-tag">${CHANGE_LABEL[g.change] || g.change}</span>
          <span class="group-id" title="稳定组标识">${escapeHtml(g.group_id)}</span>
        </span>
      </div>
      <div class="finding-body hidden">
        <div class="group-section">主因</div>
        ${groupEntryHtml(p, true)}
        ${g.affected.length ? `<div class="group-section">受影响条目（${g.affected.length}）</div>` : ""}
        ${g.affected.map((e) => groupEntryHtml(e, false)).join("")}
        <div class="rule-id">group: ${escapeHtml(g.group_id)} · rule: ${escapeHtml(g.rule_id)} · 方向：${DIRECTION_LABEL[g.direction] || g.direction} · 分类：${escapeHtml(g.category || "")}</div>
      </div>
    </article>`;
  }

  function groupEntryHtml(f, isPrimary) {
    const rel = f.relation || (isPrimary ? "primary" : "absorbed");
    const indent = !isPrimary && f.depth > 0
      ? ` style="margin-left:${Math.min(f.depth, 4) * 14}px"` : "";
    return `
    <div class="group-entry ${f.severity}"${indent}>
      <div class="entry-head">
        <span class="relation-tag ${rel}" title="${escapeAttr(REL_TITLE[rel] || "")}">${REL_LABEL[rel] || rel}</span>
        <span class="finding-badge">${SEV_LABEL[f.severity] || f.severity}</span>
        <p class="finding-msg">${escapeHtml(f.message)}</p>
        <span class="finding-meta">${refButtons(f)}</span>
      </div>
      <div class="entry-body ${isPrimary ? "" : "hidden"}">
        ${findingBodyHtml(f)}
      </div>
    </div>`;
  }

  function pretty(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch (_) {
      return String(v);
    }
  }

  // ------------------------------------------------------------------ //
  // 引用展开树
  // ------------------------------------------------------------------ //
  async function loadPointers() {
    if (!state.review) return;
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}/pointers`);
      const groups = await resp.json();
      const side = state.tree.side;
      const sel = $("#tree-pointer");
      sel.innerHTML = (groups[side] || []).map((g) =>
        `<optgroup label="${escapeAttr(g.group)}">` +
        g.items.map((it) =>
          `<option value="${escapeAttr(it.pointer)}">${escapeHtml(it.label)}</option>`
        ).join("") + "</optgroup>"
      ).join("");
      sel.value = "";
    } catch (err) {
      /* 忽略：树控件只是辅助功能 */
    }
  }

  $("#tree-side").addEventListener("change", async (e) => {
    state.tree.side = e.target.value;
    state.tree.pointer = "";
    await loadPointers();
    $("#tree-pointer").value = "";
    loadTree();
  });

  $("#tree-pointer").addEventListener("change", (e) => {
    state.tree.pointer = e.target.value;
    loadTree();
  });

  async function loadTree(targetPointer) {
    if (!state.review) return;
    const container = $("#tree-container");
    container.innerHTML = '<div class="empty-hint">加载中…</div>';
    const pointer = targetPointer !== undefined ? state.tree.pointer : state.tree.pointer;

    const qs = new URLSearchParams({
      side: state.tree.side,
      pointer: pointer || "",
    });
    let wanted = "";
    if (targetPointer !== undefined && targetPointer && targetPointer !== pointer) {
      wanted = targetPointer;
      qs.set("target", targetPointer);
    }
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}/tree?${qs}`);
      const tree = await resp.json();
      state.tree.data = tree;
      renderTree(tree, container, wanted || pointer || "");
    } catch (err) {
      container.innerHTML = `<div class="empty-hint">树加载失败：${escapeHtml(err.message)}</div>`;
    }
  }

  function renderTree(tree, container, targetPointer) {
    container.innerHTML = "";
    const nodeEl = renderTreeNode(tree, 0, true, targetPointer, []);
    container.appendChild(nodeEl);
    // 滚动到目标节点
    const hit = container.querySelector(".tree-row.is-target");
    if (hit) {
      hit.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function renderTreeNode(node, depth, isRoot, targetPointer, targetPath) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node" + (isRoot ? " root" : "");

    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const row = document.createElement("div");
    const circular = !!node.circular;
    const onTargetPath = targetPath.includes(node.name) ||
      (isRoot && depth === 0);
    row.className =
      `tree-row kind-${node.kind || "object"}` +
      (circular ? " circular" : "") +
      (node.pointer && node.pointer === targetPointer ? " is-target" : "");

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle" + (hasChildren ? "" : " leaf");
    toggle.textContent = "▸";
    row.appendChild(toggle);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = node.name || "(node)";
    row.appendChild(name);

    if (node.ref) {
      const badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = circular ? "circular ref" : "$ref";
      row.appendChild(badge);
    }

    if (node.summary) {
      const sum = document.createElement("span");
      sum.className = "tree-summary";
      sum.textContent = node.summary;
      row.appendChild(sum);
    }

    if (node.truncated) {
      const t = document.createElement("span");
      t.className = "tree-badge";
      t.textContent = "已截断";
      row.appendChild(t);
    }

    if (node.pointer) {
      const ptr = document.createElement("span");
      ptr.className = "tree-pointer";
      ptr.textContent = node.pointer;
      row.appendChild(ptr);
    }

    wrap.appendChild(row);

    if (hasChildren) {
      const childBox = document.createElement("div");
      childBox.className = "tree-children";
      // 默认：根与前两层展开；有深链目标时只展开目标路径上的节点
      const openByDefault =
        (targetPointer && (depth < 2 || onTargetPath)) ||
        (!targetPointer && depth < 2);
      childBox.style.display = openByDefault ? "block" : "none";
      if (openByDefault) toggle.textContent = "▾";

      node.children.forEach((child) => {
        childBox.appendChild(
          renderTreeNode(child, depth + 1, false, targetPointer, targetPath)
        );
      });
      wrap.appendChild(childBox);

      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const open = childBox.style.display !== "none";
        childBox.style.display = open ? "none" : "block";
        toggle.textContent = open ? "▸" : "▾";
      });
    }

    return wrap;
  }

  $("#tree-expand").addEventListener("click", () => {
    $$("#tree-container .tree-children").forEach((box) => {
      box.style.display = "block";
    });
    $$("#tree-container .tree-toggle:not(.leaf)").forEach((t) => {
      t.textContent = "▾";
    });
  });
  $("#tree-collapse").addEventListener("click", () => {
    $$("#tree-container .tree-children").forEach((box) => {
      // 根节点的直接子层保持展开，其余全部折叠
      const isRootChildren = box.parentElement.classList.contains("root");
      box.style.display = isRootChildren ? "block" : "none";
    });
    $$("#tree-container .tree-toggle:not(.leaf)").forEach((t) => {
      const isRootToggle =
        t.closest(".tree-node") && t.closest(".tree-node").classList.contains("root");
      t.textContent = isRootToggle ? "▾" : "▸";
    });
  });

  /** 从发现项跳到引用树：切换 side、加载从根到目标的展开视图。 */
  async function jumpToRef(ref, side, pointer) {
    if (!state.review || !pointer) return;
    // 规范化：去掉 URI 片段前缀 #，使其与树节点 pointer 一致
    const normPointer = pointer.includes("#")
      ? pointer.slice(pointer.indexOf("#") + 1)
      : pointer;
    state.tree.side = side;
    $("#tree-side").value = side;
    await loadPointers();

    // 优先选目标所在的顶层组件分组（树更小、可读性好），否则从根展开
    const m = normPointer.match(/^(\/components\/(?:schemas|parameters|requestBodies|responses|headers)\/[^/]+)/);
    const rootPick = m ? m[1] : "";
    $("#tree-pointer").value = rootPick;
    state.tree.pointer = rootPick;
    await loadTree(normPointer || rootPick);
  }

  // ------------------------------------------------------------------ //
  // 报告下载
  // ------------------------------------------------------------------ //
  function downloadReport(format) {
    if (!state.review) return;
    window.location.href = `/api/reviews/${state.review.id}/report?format=${format}`;
  }
  $("#download-md").addEventListener("click", () => downloadReport("markdown"));
  $("#download-json").addEventListener("click", () => downloadReport("json"));

  // ------------------------------------------------------------------ //
  // 最小复现包导出
  // ------------------------------------------------------------------ //
  async function downloadRepro(findingId, btn) {
    if (!state.review || !findingId) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "📦 生成中…";
    try {
      const resp = await fetch(
        `/api/reviews/${state.review.id}/findings/${findingId}/repro`
      );
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const data = await resp.json();
          msg = data.detail || msg;
        } catch (_) { /* 非 JSON 错误响应 */ }
        showError(`最小复现包导出失败：${msg}`);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openapi-repro-r${state.review.id}-f${findingId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      hideError();
    } catch (err) {
      showError(`最小复现包导出失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // ------------------------------------------------------------------ //
  // 历史记录
  // ------------------------------------------------------------------ //
  async function loadHistory() {
    const body = $("#history-body");
    body.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">加载中…</td></tr>`;
    try {
      const resp = await fetch("/api/reviews");
      const data = await resp.json();
      const items = data.items || [];
      $("#history-empty").classList.toggle("hidden", items.length > 0);
      refreshBaselineSelect(items);
      updateReconcileCurrent();
      body.innerHTML = items.map((it) => {
        const c = it.summary.counts || {};
        return `
        <tr>
          <td>${it.id}</td>
          <td>${escapeHtml(it.created_at || "")}</td>
          <td>${escapeHtml(it.title || "")}</td>
          <td>${escapeHtml(it.old_version || "?")} → ${escapeHtml(it.new_version || "?")}</td>
          <td><span class="pill ${it.summary.compatible ? "good" : "bad"}">
            ${it.summary.compatible ? "兼容" : `${c.breaking || 0} 破坏`}
          </span></td>
          <td>${it.summary.total}</td>
          <td>
            <button class="link-btn" data-open="${it.id}">打开</button>
            <button class="link-btn" data-md="${it.id}">MD</button>
            <button class="link-btn" data-del="${it.id}">删除</button>
          </td>
        </tr>`;
      }).join("");

      body.querySelectorAll("[data-open]").forEach((b) =>
        b.addEventListener("click", async () => {
          const review = await (await fetch(`/api/reviews/${b.dataset.open}`)).json();
          state.review = review;
          state.filter = { severity: "all", direction: "all", category: "all", text: "" };
          $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "review"));
          $$(".tab-panel").forEach((p) =>
            p.classList.toggle("active", p.id === "tab-review"));
          renderResult();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }));
      body.querySelectorAll("[data-md]").forEach((b) =>
        b.addEventListener("click", () => {
          window.location.href = `/api/reviews/${b.dataset.md}/report?format=markdown`;
        }));
      body.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("确定删除这条审查记录？")) return;
          await fetch(`/api/reviews/${b.dataset.del}`, { method: "DELETE" });
          loadHistory();
        }));
    } catch (err) {
      body.innerHTML = `<tr><td colspan="7" style="color:var(--breaking)">加载失败：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ------------------------------------------------------------------ //
  // 破坏项对账（基线审查 vs 当前审查）
  // ------------------------------------------------------------------ //
  function updateReconcileCurrent() {
    const el = $("#reconcile-current");
    if (state.review && state.review.id != null) {
      el.textContent = `当前审查：#${state.review.id} · ${state.review.title || ""}`;
    } else {
      el.textContent = "当前审查：未加载";
    }
  }

  function refreshBaselineSelect(items) {
    const sel = $("#baseline-select");
    const prev = sel.value;
    sel.innerHTML = `<option value="">选择基线审查…</option>` + items.map((it) =>
      `<option value="${it.id}">#${it.id} · ${escapeHtml(it.title || "（无标题）")} · ${escapeHtml(it.created_at || "")}</option>`
    ).join("");
    if (prev && items.some((it) => String(it.id) === prev)) sel.value = prev;
  }

  function showReconcileStatus(msg) {
    const el = $("#reconcile-status");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  async function runReconcile() {
    $("#reconcile-status").classList.add("hidden");
    $("#reconcile-result").innerHTML = "";
    state.reconcile = null;

    if (!state.review || state.review.id == null) {
      showReconcileStatus("还没有当前审查：请先在「审查」页执行一次审查，或从上方历史记录「打开」一条记录，再选择基线对账。");
      return;
    }
    const baselineId = Number($("#baseline-select").value);
    if (!baselineId) {
      showReconcileStatus("请先在下拉框中选择一条已保存的审查作为基线。");
      return;
    }
    if (baselineId === state.review.id) {
      showReconcileStatus(`基线与当前审查相同（#${baselineId}），对账无意义，请选择另一条历史审查作为基线。`);
      return;
    }

    const btn = $("#reconcile-btn");
    btn.disabled = true;
    btn.textContent = "对账中…";
    try {
      const resp = await fetch(
        `/api/reviews/${state.review.id}/reconcile?baseline_id=${baselineId}`
      );
      const data = await resp.json();
      if (!resp.ok) {
        showReconcileStatus(`对账失败：${data.detail || `HTTP ${resp.status}`}`);
        if (resp.status === 404) loadHistory();  // 基线可能刚被删除，刷新列表与下拉框
        return;
      }
      state.reconcile = data;
      renderReconcile(data);
    } catch (err) {
      showReconcileStatus(`对账请求失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "开始对账";
    }
  }
  $("#reconcile-btn").addEventListener("click", runReconcile);

  function renderReconcile(data) {
    const s = data.summary || {};
    const box = $("#reconcile-result");
    const b = data.baseline || {};
    const c = data.current || {};
    box.innerHTML = `
      <p class="result-meta recon-scope">
        基线 <b>#${b.id}</b> · ${escapeHtml(b.title || "")}（${escapeHtml(b.created_at || "")}）
        → 当前 <b>#${c.id}</b> · ${escapeHtml(c.title || "")}
        ｜基线破坏项 ${s.baseline_breaking_total ?? 0} 条，当前破坏项 ${s.current_breaking_total ?? 0} 条
      </p>
      <div class="stat-cards three">
        <div class="stat-card recon-added"><div class="num">${s.added ?? 0}</div><div class="label">🆕 新增破坏项</div></div>
        <div class="stat-card recon-continued"><div class="num">${s.continued ?? 0}</div><div class="label">🔁 延续破坏项</div></div>
        <div class="stat-card recon-disappeared"><div class="num">${s.disappeared ?? 0}</div><div class="label">🚫 已消失破坏项</div></div>
      </div>
      ${reconSection("🆕 新增破坏项（当前审查新出现）", data.added, "added")}
      ${reconSection("🔁 延续破坏项（基线至今未解决）", data.continued, "continued")}
      ${reconSection("🚫 已消失破坏项（当前审查已不存在）", data.disappeared, "disappeared")}
    `;
    box.querySelectorAll("[data-jump]").forEach((btn) => {
      btn.addEventListener("click", () => jumpToFinding(Number(btn.dataset.jump)));
    });
  }

  function reconSection(title, items, kind) {
    const list = items || [];
    return `
    <div class="recon-section">
      <h3 class="recon-title ${kind}">${title}<span class="recon-count">${list.length}</span></h3>
      ${list.length
        ? list.map((e) => reconItemHtml(e, kind)).join("")
        : '<div class="recon-empty">无</div>'}
    </div>`;
  }

  function reconItemHtml(entry, kind) {
    const f = kind === "disappeared" ? entry.baseline : entry.current;
    const ids = [];
    if (entry.baseline_finding_id != null) ids.push(`基线发现 #${entry.baseline_finding_id}`);
    if (entry.current_finding_id != null) ids.push(`当前发现 #${entry.current_finding_id}`);
    const jump = entry.current_finding_id != null
      ? `<button class="mini-link recon-jump" data-jump="${entry.current_finding_id}"
           title="切回审查页，展开并定位该发现">⤴ 定位到当前发现</button>` : "";
    return `
    <div class="recon-item ${kind}">
      <div class="recon-item-head">
        <span class="finding-badge">破坏性</span>
        ${f.endpoint ? `<span class="finding-endpoint">${escapeHtml(f.endpoint)}</span>` : ""}
        <p class="finding-msg">${escapeHtml(f.message || "")}</p>
        <span class="finding-meta">
          <span class="recon-ids">${ids.join(" · ")}</span>
          ${jump}
        </span>
      </div>
      <div class="recon-item-loc">📍 ${escapeHtml(f.location || "")} · rule: ${escapeHtml(f.rule_id || "")} · 方向：${DIRECTION_LABEL[f.direction] || f.direction}</div>
    </div>`;
  }

  /** 从对账结果跳回审查页：重置筛选、展开目标发现卡片并高亮。 */
  function jumpToFinding(findingId) {
    if (!state.review || findingId == null) return;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "review"));
    $$(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === "tab-review"));
    // 重置筛选与视图，保证目标发现一定在列表中
    state.filter = { severity: "all", direction: "all", category: "all", text: "" };
    syncFilterControls();
    state.view = "flat";
    $$("#view-toggle .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "flat"));
    state.expandedFinding = findingId;
    renderFindings();
    const card = document.querySelector(`#findings-list .finding[data-id="${findingId}"]`);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1800);
    }
  }

  // ------------------------------------------------------------------ //
  // 规则说明（静态内容，与后端规则保持同步）
  // ------------------------------------------------------------------ //
  const RULES = [
    {
      title: "路径与操作",
      items: [
        "<code>删除路径 / 删除操作</code>：🔴 破坏性（404/405）",
        "<code>新增路径 / 新增操作</code>：🟢 纯扩展",
        "<code>operationId 改变</code>：⚪ codegen 客户端可能受影响",
        "<code>操作/参数/响应标记 deprecated</code>：🟡 废弃提示",
        "<code>移除 servers 地址</code>：🔴 仍在使用该地址的客户端失效",
      ],
    },
    {
      title: "参数（请求方向）",
      items: [
        "<code>新增必填参数</code>（含 path 参数）：🔴 旧请求被拒绝",
        "<code>可选 → 必填</code>：🔴 破坏性；必填 → 可选：🟢",
        "<code>删除参数</code>：🔴（header 参数除外，通常被忽略，列兼容）",
        "<code>style / explode 变化</code>：🔴 线上序列化格式不兼容",
        "参数 schema 变化按下方请求 Schema 规则判定",
      ],
    },
    {
      title: "请求体 Schema",
      items: [
        "<code>新增必填字段</code>：🔴；新增可选字段：🟢",
        "<code>删除字段</code>：🟢（服务端通常忽略多余字段）",
        "<code>必填 → 可选</code>：🟢；可选 → 必填：🔴",
        "<code>枚举取值减少</code>：🔴；枚举取值增加：🟢",
        "<code>min* 升高 / max* 降低</code>：🔴 收紧；反方向 🟢",
        "<code>新增 format 约束</code>、类型收窄：🔴",
        "<code>nullable → 非空</code>、字段变 readOnly：🔴",
        "<code>additionalProperties: true → false</code>：🔴",
      ],
    },
    {
      title: "响应 Schema（方向相反）",
      items: [
        "<code>删除响应字段</code>：🔴 客户端读到 undefined",
        "<code>新增必有字段</code>：🟢；新增可选字段：🟢（严格模型需确认）",
        "<code>必填 → 可选</code>：🔴；可选 → 必填：🟢",
        "<code>枚举取值增加</code>：🔴 客户端遇到未知值；减少：🟢",
        "<code>minimum 降低 / maximum 升高</code>：🔴 承诺范围扩大",
        "<code>变 nullable</code>、字段变 writeOnly：🔴",
        "<code>类型变多 / format 被移除</code>：🔴",
      ],
    },
    {
      title: "状态码与媒体类型",
      items: [
        "<code>删除 2xx 响应</code>：🔴；新增成功响应：🟢",
        "删除错误码：🔴（风险较低，消息中注明）",
        "请求：<code>服务端不再接受某 Content-Type</code>：🔴（415）",
        "响应：<code>新增一种返回 Content-Type</code>：🔴 严格客户端风险",
        "requestBody 可选 → 必填：🔴；必填 → 可选：🟢",
      ],
    },
    {
      title: "$ref 与循环引用",
      items: [
        "所有 schema/参数/请求体/响应中的 <code>$ref</code> 先解引用再比较",
        "自动合并 <code>allOf</code>（属性、required、约束按合取语义合并）",
        "组件自引用 / 互相引用（A→B→A）通过 DFS 栈检测，不会无限递归",
        "发现项给出载荷语义路径 + 文档 JSON Pointer 双重定位",
        "右侧展开树以 ⟳ 标记循环引用，点击 🌲 可直接跳转",
      ],
    },
  ];
  $("#rules-content").innerHTML = RULES.map((g) => `
    <div class="rule-card">
      <h3>${g.title}</h3>
      <ul>${g.items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>`).join("");

  // ------------------------------------------------------------------ //
  // 工具
  // ------------------------------------------------------------------ //
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, "&#96;");
  }
})();
