"""破坏项对账：基线审查与当前审查的破坏性发现对比。

稳定身份由语义字段构造——端点、请求/响应方向、规则、语义定位——
刻意不包含发现 ID，也与发现列表的顺序无关；同身份的重复发现按出现
次数一一配对（各自按发现 ID 排序后，第 N 次出现与第 N 次出现配对）。

仅统计 severity=breaking 的发现，输出三类结果：
  added        新增破坏项：当前审查存在、基线无同身份项
  continued    延续破坏项：两侧均有同身份项（逐对列出）
  disappeared  已消失破坏项：基线存在、当前审查已无同身份项

每条结果保留两侧原发现 ID，便于回到对应审查中定位。
"""
from __future__ import annotations

from typing import Any

BREAKING = "breaking"

# 稳定身份字段：端点 / 方向 / 规则 / 语义定位（刻意排除发现 ID 与列表顺序）
IDENTITY_FIELDS = ("endpoint", "direction", "rule_id", "location")


def identity_of(finding: dict[str, Any]) -> tuple:
    """发现的稳定身份：端点 + 请求/响应方向 + 规则 + 语义定位。"""
    return tuple(finding.get(k) for k in IDENTITY_FIELDS)


def _breaking_findings(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """取破坏性发现；历史数据若无引擎序号 id，按 1 起始位置补齐（与分组/复现一致）。"""
    out: list[dict[str, Any]] = []
    for i, f in enumerate(findings or []):
        if not isinstance(f, dict) or f.get("severity") != BREAKING:
            continue
        g = dict(f)
        if not isinstance(g.get("id"), int):
            g["id"] = i + 1
        out.append(g)
    return out


def _brief(f: dict[str, Any]) -> dict[str, Any]:
    """对账条目：定位所需的精简发现字段 + 原发现 ID。"""
    return {
        "finding_id": f.get("id"),
        "rule_id": f.get("rule_id"),
        "category": f.get("category"),
        "direction": f.get("direction"),
        "change": f.get("change"),
        "endpoint": f.get("endpoint"),
        "location": f.get("location"),
        "message": f.get("message"),
        "old_json_path": f.get("old_json_path"),
        "new_json_path": f.get("new_json_path"),
        "old_ref": f.get("old_ref"),
        "new_ref": f.get("new_ref"),
    }


def _bucket(items: list[dict[str, Any]]) -> dict[tuple, list[dict[str, Any]]]:
    """按稳定身份分桶；桶内按发现 ID 排序，之后按下标一一配对。"""
    buckets: dict[tuple, list[dict[str, Any]]] = {}
    for f in items:
        buckets.setdefault(identity_of(f), []).append(f)
    for group in buckets.values():
        group.sort(key=lambda x: x["id"])
    return buckets


def reconcile_breaking(
    baseline_findings: list[dict[str, Any]],
    current_findings: list[dict[str, Any]],
) -> dict[str, Any]:
    """对账基线与当前审查的破坏性发现，输出新增 / 延续 / 已消失三类及数量。"""
    baseline = _breaking_findings(baseline_findings)
    current = _breaking_findings(current_findings)

    base_buckets = _bucket(baseline)
    cur_buckets = _bucket(current)

    added: list[dict[str, Any]] = []
    continued: list[dict[str, Any]] = []
    disappeared: list[dict[str, Any]] = []

    # repr 排序保证输出顺序稳定（身份含 None，不能直接按元组比较）
    for ident in sorted(set(base_buckets) | set(cur_buckets), key=repr):
        olds = base_buckets.get(ident, [])
        news = cur_buckets.get(ident, [])
        paired = min(len(olds), len(news))
        for i in range(paired):
            continued.append({
                "baseline_finding_id": olds[i].get("id"),
                "current_finding_id": news[i].get("id"),
                "baseline": _brief(olds[i]),
                "current": _brief(news[i]),
            })
        for f in news[paired:]:
            added.append({
                "baseline_finding_id": None,
                "current_finding_id": f.get("id"),
                "current": _brief(f),
            })
        for f in olds[paired:]:
            disappeared.append({
                "baseline_finding_id": f.get("id"),
                "current_finding_id": None,
                "baseline": _brief(f),
            })

    return {
        "summary": {
            "added": len(added),
            "continued": len(continued),
            "disappeared": len(disappeared),
            "baseline_breaking_total": len(baseline),
            "current_breaking_total": len(current),
        },
        "added": added,
        "continued": continued,
        "disappeared": disappeared,
    }
