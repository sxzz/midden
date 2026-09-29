import type { Collection, Asset, Entity } from "./api";
export interface Presentation {
  name: string;
  handle?: string;
  avatar?: Asset;
  body: string;
  kind: string;
}
type Presenter = (a: Collection, root?: Entity) => Presentation;
const generic: Presenter = (a) => ({
  name: a.author_name || "已保存的内容",
  body: a.text || a.summary || "暂无正文",
  kind: "收藏",
});
const x: Presenter = (a, root) => {
  const key = a.graph?.relations.find(
    (r) => r.source === a.graph?.root && r.type === "authored_by",
  )?.target;
  const profile =
    root?.type === "x.profile"
      ? root
      : a.graph?.entities.find((e) => e.key === key && e.type === "x.profile");
  return {
    ...generic(a),
    kind: root?.type === "x.profile" ? "资料" : "帖子",
    handle:
      typeof profile?.data.username === "string"
        ? profile.data.username
        : undefined,
    avatar: profile?.assets?.find(
      (v) => v.purpose === "avatar" && v.state === "ready",
    ),
  };
};
const registry: Record<string, Presenter> = { "x.post": x, "x.profile": x };
export function present(a: Collection) {
  const root = a.graph?.entities.find((e) => e.key === a.graph?.root);
  return (registry[root?.type || ""] || generic)(a, root);
}

function parseDate(value?: string) {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
export function date(value?: string) {
  const d = parseDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}
const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function daysAgo(d: Date, now: Date) {
  return Math.round((+day(now) - +day(d)) / 86400000);
}
/** List timestamps read like the chat list: time today, date before that. */
export function shortDate(value?: string, now = new Date()) {
  const d = parseDate(value);
  if (!d) return "";
  const distance = daysAgo(d, now);
  if (distance === 0)
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (distance === 1) return "昨天";
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear()
    ? date
    : `${d.getFullYear()}年${date}`;
}
/** Buckets the collection by when it was saved, newest bucket first. */
export function groupLabel(value?: string, now = new Date()) {
  const d = parseDate(value);
  if (!d) return "已保存";
  const distance = daysAgo(d, now);
  if (distance === 0) return "今天";
  if (distance === 1) return "昨天";
  const month = `${d.getMonth() + 1}月`;
  return d.getFullYear() === now.getFullYear()
    ? month
    : `${d.getFullYear()}年${month}`;
}
export interface CollectionGroup {
  label: string;
  items: Collection[];
}
export function groupCollections(items: Collection[], now = new Date()) {
  const groups: CollectionGroup[] = [];
  for (const item of items) {
    const label = groupLabel(item.saved_at || item.observed_at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

const isImage = (a: Asset) => !!a.mime?.startsWith("image/");
const isVideo = (a: Asset) => !!a.mime?.startsWith("video/");
/** Media that finished saving, in the order the source published it. */
export function readyMedia(assets: Asset[] = []) {
  return assets.filter((a) => a.state === "ready");
}
export function mediaSummary(assets: Asset[] = []) {
  const ready = readyMedia(assets);
  const images = ready.filter(isImage).length;
  const videos = ready.filter(isVideo).length;
  const others = ready.length - images - videos;
  return [
    images && `${images} 张图片`,
    videos && `${videos} 段视频`,
    others && `${others} 个文件`,
  ]
    .filter(Boolean)
    .join(" · ");
}
/** Media state in words. Storage states never reach the reader. */
export function mediaNotice(asset: Asset) {
  if (asset.state === "pending") return "媒体还在保存中";
  if (asset.state === "failed") return "这个媒体没能保存下来";
  return "这个媒体暂时无法打开";
}
const warnings: Record<string, string> = {
  "resource omitted: unsupported type or resource limit":
    "部分媒体超出限制，没有保存。",
};
/** Adapter warnings are diagnostic strings; readers get plain wording. */
export function warningText(warning: string) {
  return warnings[warning] || "部分内容没有完整保存。";
}
export function warningList(list?: string[] | null) {
  return [...new Set((list ?? []).map(warningText))];
}
/** One-paragraph preview for a list row. */
export function excerpt(text: string, limit = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}
