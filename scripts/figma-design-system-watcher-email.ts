// scripts/figma-ds-watcher-email.ts
import crypto from "node:crypto";
import fs from "node:fs";
import fetch from "node-fetch";
import nodemailer from "nodemailer";

// ---------- ENV ----------
const { FIGMA_TOKEN, FIGMA_FILE_KEY, SMTP_HOST, SMTP_PORT = "587", SMTP_SECURE = "false", SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO, MAIL_SUBJECT_PREFIX = "[DS]" } = process.env as Record<string, string>;

if (!FIGMA_TOKEN || !FIGMA_FILE_KEY) throw new Error("FIGMA_TOKEN/FIGMA_FILE_KEY required");
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) throw new Error("SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM/MAIL_TO required");

const SNAP_PATH = "./.figma-ds-snapshot.json";

// ---------- TYPES ----------
type Snapshot = {
  components: Record<string, string>; // nodeId -> hash
  styles: Record<string, string>; // nodeId -> hash
  variables: Record<string, string>; // varId  -> hash (Free 플랜이면 대부분 빈 객체)
  componentNames?: Record<string, string>; // nodeId -> name
  styleNames?: Record<string, string>; // nodeId -> name
  variableNames?: Record<string, string>; // varId  -> name
  meta: {
    versionId?: string;
    versionUserHandle?: string;
    versionUserId?: string;
    versionLabel?: string;
    versionDescription?: string;
    versionCreatedAt?: string;
    takenAt: string;
  };
};

type VersionShort = {
  id: string;
  createdAt: string; // ISO
  userHandle?: string;
  userId?: string;
  label?: string;
  description?: string;
};

// ---------- SMTP ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE) === "true",
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function verifySmtp() {
  try {
    await transporter.verify();
  } catch (e: any) {
    const msg = String(e?.response || e?.message || e);
    if (msg.includes("534") && msg.includes("Application-specific password")) {
      console.error("[SMTP] Gmail은 일반 비밀번호 로그인 불가. 2단계 인증 + '앱 비밀번호'를 SMTP_PASS로 넣어주세요.");
    }
    throw e;
  }
}

// ---------- UTILS ----------
function nowKST() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}
function fmtKST(iso?: string) {
  return iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-";
}

async function figma(path: string) {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": FIGMA_TOKEN! },
  });
  console.log("Figma API:", path, res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API error ${res.status} ${res.statusText} for ${path}\n${body}`);
  }
  return res.json();
}

function sha(obj: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function normalizePaints(paints: any[] = []) {
  return paints.map((p) => ({
    type: p.type,
    visible: p.visible ?? true,
    opacity: p.opacity ?? 1,
    color: p.color ? [p.color.r, p.color.g, p.color.b] : null, // SOLID 기준
  }));
}

// ---------- VERSIONS ----------
async function getVersions(): Promise<VersionShort[]> {
  const data = (await figma(`/files/${FIGMA_FILE_KEY}/versions`)) as { versions?: any[] };
  const list = (data?.versions ?? []).map((v: any) => ({
    id: v.id as string,
    createdAt: v.created_at as string,
    userHandle: v.user?.handle as string | undefined,
    userId: v.user?.id as string | undefined,
    label: v.label as string | undefined,
    description: v.description as string | undefined,
  }));
  // 최신 → 과거 순
  return list;
}

/** prevId(독점) 이후 ~ latestId(포함) 범위를 오래된→최신으로 반환 */
function versionsBetweenAsc(all: VersionShort[], prevId?: string, latestId?: string) {
  const startIdx = latestId ? all.findIndex((v) => v.id === latestId) : 0; // 보통 0
  const endIdxExclusive = prevId ? all.findIndex((v) => v.id === prevId) : all.length;
  const end = endIdxExclusive === -1 ? all.length : endIdxExclusive;
  const start = startIdx >= 0 ? startIdx : 0;
  const windowNewToOld = all.slice(start, end); // 최신→과거
  return windowNewToOld.slice().reverse(); // 오래된→최신
}

// ---------- SNAPSHOT ----------
async function takeSnapshot(versionId?: string): Promise<Snapshot> {
  const file = (await figma(`/files/${FIGMA_FILE_KEY}`)) as { document: any };
  const stylesRes = (await figma(`/files/${FIGMA_FILE_KEY}/styles`)) as { meta?: { styles?: any[] } };

  // Variables(토큰) — Free 플랜이면 403 → 스킵
  let variables: Record<string, string> = {};
  let variableNames: Record<string, string> = {};
  try {
    const vars = (await figma(`/files/${FIGMA_FILE_KEY}/variables/local`)) as { variables?: any[] };
    if (!vars?.variables?.length) {
      console.warn("[DS Watcher] No local variables in this file. Skipping variables diff.");
    } else {
      variables = Object.fromEntries(
        vars.variables.map((v: any) => {
          const norm = {
            id: v.id,
            name: v.name,
            collectionId: v.collection_id,
            scopes: v.scopes,
            valuesByMode: v.values_by_mode,
          };
          return [v.id, sha(norm)];
        })
      );
      variableNames = Object.fromEntries(vars.variables.map((v: any) => [v.id, v.name]));
    }
  } catch (e: any) {
    if ((e?.message ?? "").includes(" 403 ") || (e?.message ?? "").includes("Forbidden")) {
      console.warn("[DS Watcher] Variables API 403: Free 플랜/스코프 제한. 변수 감지는 스킵합니다.");
      variables = {};
      variableNames = {};
    } else {
      throw e;
    }
  }

  // Components
  const components: Record<string, string> = {};
  const componentNames: Record<string, string> = {};
  function walk(n: any) {
    if (!n) return;
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
      componentNames[n.id] = n.name ?? n.id; // 이름 맵 저장
      const norm = {
        id: n.id,
        name: n.name,
        description: n.description ?? "",
        componentPropertyDefinitions: n.componentPropertyDefinitions ?? {},
        fills: normalizePaints(n.fills),
        strokes: normalizePaints(n.strokes),
        cornerRadius: n.cornerRadius ?? null,
        layoutMode: n.layoutMode ?? null,
        padding: {
          t: n.paddingTop ?? 0,
          r: n.paddingRight ?? 0,
          b: n.paddingBottom ?? 0,
          l: n.paddingLeft ?? 0,
        },
      };
      components[n.id] = sha(norm);
    }
    (n.children ?? []).forEach(walk);
  }
  walk(file.document);

  // Styles
  const styles: Record<string, string> = {};
  const styleNames: Record<string, string> = {};
  for (const s of stylesRes.meta?.styles ?? []) {
    styleNames[s.node_id] = s.name ?? s.node_id;
    const norm = { id: s.node_id, name: s.name, styleType: s.style_type }; // FILL | TEXT | EFFECT | GRID
    styles[s.node_id] = sha(norm);
  }

  return {
    components,
    styles,
    variables,
    componentNames,
    styleNames,
    variableNames,
    meta: { versionId, takenAt: new Date().toISOString() },
  };
}

// ---------- DIFF ----------
function diff(prev: Record<string, string>, curr: Record<string, string>) {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const prevKeys = new Set(Object.keys(prev));
  const currKeys = new Set(Object.keys(curr));
  for (const k of currKeys) {
    if (!prevKeys.has(k)) added.push(k);
    else if (prev[k] !== curr[k]) changed.push(k);
  }
  for (const k of prevKeys) if (!currKeys.has(k)) removed.push(k);
  return { added, removed, changed };
}

// ---------- EMAIL ----------
async function sendEmail(subject: string, lines: string[], attachments?: { filename: string; content: string }[]) {
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">
    <h2 style="margin:0 0 12px;">${subject}</h2>
    <p style="color:#555;margin:0 0 16px;">${nowKST()} (KST)</p>
    <pre style="background:#f6f8fa;padding:12px;border-radius:8px;white-space:pre-wrap;margin:0 0 16px;">${lines.map((l) => l.replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("\n")}</pre>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
    <p style="color:#888;font-size:12px">자동 발송: DS Watcher</p>
  </div>`;

  await transporter.sendMail({
    from: MAIL_FROM!,
    to: MAIL_TO!.split(",").map((s) => s.trim()),
    subject: `${MAIL_SUBJECT_PREFIX} ${subject}`,
    html,
    attachments,
  });
}

function buildDeepLink(nodeId: string) {
  return `https://www.figma.com/file/${FIGMA_FILE_KEY}?node-id=${encodeURIComponent(nodeId)}`;
}

// ---------- MAIN ----------
async function main() {
  // SMTP 사전검증(선택)
  await verifySmtp();

  // 모든 버전 로드
  const versionsAll = await getVersions();
  const latest = versionsAll[0];
  const latestVersionId = latest?.id;

  const prev: Snapshot | null = fs.existsSync(SNAP_PATH) ? JSON.parse(fs.readFileSync(SNAP_PATH, "utf-8")) : null;

  // 새 버전 없으면 스킵
  if (prev && prev.meta.versionId && latestVersionId && prev.meta.versionId === latestVersionId) {
    console.log("No new version. Skip.");
    return;
  }

  // 스냅샷 생성
  const curr = await takeSnapshot(latestVersionId);

  // 최신 버전 메타 주입
  if (latest) {
    curr.meta.versionId = latest.id ?? curr.meta.versionId;
    curr.meta.versionUserHandle = latest.userHandle;
    curr.meta.versionUserId = latest.userId;
    curr.meta.versionLabel = latest.label;
    curr.meta.versionDescription = latest.description;
    curr.meta.versionCreatedAt = latest.createdAt;
  }

  // 최초 실행: 최근 N개 버전 요약 포함
  if (!prev) {
    fs.writeFileSync(SNAP_PATH, JSON.stringify({ ...curr, meta: { ...curr.meta, versionId: latestVersionId } }, null, 2));

    const N = 15;
    const recentAsc = [...versionsAll].slice(0, N).reverse(); // 오래된→최신
    const versionLines = recentAsc.map((v, i) => `${String(i + 1).padStart(2, "0")}. ${fmtKST(v.createdAt)} — ${v.userHandle ?? v.userId ?? "-"} — ${v.label ?? "(no label)"} (${v.id})`);

    await sendEmail(
      "DS Watcher 초기화 완료",
      [`최신 버전: ${latestVersionId ?? "unknown"} (${fmtKST(latest?.createdAt)})`, `작성자: ${latest?.userHandle ?? latest?.userId ?? "-"}`, "", `컴포넌트: ${Object.keys(curr.components).length}개`, `스타일: ${Object.keys(curr.styles).length}개`, `변수(토큰): ${Object.keys(curr.variables).length}개`, "", `최근 ${Math.min(N, versionsAll.length)}개 버전 타임라인 (오래된→최신)`, ...versionLines],
      [
        {
          filename: "versions-all.json",
          content: JSON.stringify(versionsAll, null, 2),
        },
      ]
    );
    return;
  }

  // diff 계산
  const dc = diff(prev.components, curr.components);
  const ds = diff(prev.styles, curr.styles);
  const dv = diff(prev.variables, curr.variables);

  const totalChanges = dc.added.length + dc.removed.length + dc.changed.length + ds.added.length + ds.removed.length + ds.changed.length + dv.added.length + dv.removed.length + dv.changed.length;

  if (totalChanges === 0) {
    console.log("No meaningful changes.");
  } else {
    // 버전 타임라인: prev.versionId 이후 ~ latest 포함 (오래된→최신)
    const timelineAsc = versionsBetweenAsc(versionsAll, prev.meta.versionId, latestVersionId);
    const MAX = 25; // 메일 본문 표시 상한
    const shown = timelineAsc.slice(-MAX);
    const timelineLines = shown.map((v, i) => `${String(i + 1).padStart(2, "0")}. ${fmtKST(v.createdAt)} — ${v.userHandle ?? v.userId ?? "-"} — ${v.label ?? "(no label)"} (${v.id})`);

    // 이름 조회 유틸(없으면 id)
    const cname = (id: string) => curr.componentNames?.[id] || prev.componentNames?.[id] || id;
    const sname = (id: string) => curr.styleNames?.[id] || prev.styleNames?.[id] || id;
    const vname = (id: string) => curr.variableNames?.[id] || prev.variableNames?.[id] || id;

    const lines = [
      `버전: ${prev.meta.versionId ?? "-"} → ${latestVersionId ?? "-"}`,
      `최신 작성자: ${latest?.userHandle ?? latest?.userId ?? "-"} (${fmtKST(latest?.createdAt)})`,
      latest?.label ? `라벨: ${latest.label}` : "",
      latest?.description ? `설명: ${latest.description}` : "",
      "",
      `컴포넌트: +${dc.added.length} / ~${dc.changed.length} / -${dc.removed.length}`,
      ...dc.added.slice(0, 10).map((id) => `  + ${cname(id)} → ${buildDeepLink(id)}`),
      ...dc.changed.slice(0, 10).map((id) => `  ~ ${cname(id)} → ${buildDeepLink(id)}`),
      ...dc.removed.slice(0, 10).map((id) => `  - ${cname(id)} (removed)`),
      "",
      `스타일: +${ds.added.length} / ~${ds.changed.length} / -${ds.removed.length}`,
      ...ds.added.slice(0, 10).map((id) => `  + ${sname(id)} → ${buildDeepLink(id)}`),
      ...ds.changed.slice(0, 10).map((id) => `  ~ ${sname(id)} → ${buildDeepLink(id)}`),
      ...ds.removed.slice(0, 10).map((id) => `  - ${sname(id)} (removed)`),
      "",
      `변수: +${dv.added.length} / ~${dv.changed.length} / -${dv.removed.length}`,
      ...dv.added.slice(0, 10).map((id) => `  + ${vname(id)}`),
      ...dv.changed.slice(0, 10).map((id) => `  ~ ${vname(id)}`),
      ...dv.removed.slice(0, 10).map((id) => `  - ${vname(id)} (removed)`),
      "",
      `버전 타임라인 (이전 스냅샷 이후 → 최신, 오래된→최신, 총 ${timelineAsc.length}개)`,
      ...(timelineLines.length ? timelineLines : ["(변경 버전 없음)"]),
    ];

    const attachments = [
      {
        filename: "diff-summary.json",
        content: JSON.stringify(
          {
            version: {
              from: prev.meta.versionId ?? null,
              to: latestVersionId ?? null,
              author: latest?.userHandle ?? latest?.userId ?? null,
              created_at: latest?.createdAt ?? null,
              label: latest?.label ?? null,
            },
            components: dc,
            styles: ds,
            variables: dv,
            names: {
              componentNames: curr.componentNames,
              styleNames: curr.styleNames,
              variableNames: curr.variableNames,
            },
          },
          null,
          2
        ),
      },
      { filename: "versions-window.json", content: JSON.stringify(timelineAsc, null, 2) },
      { filename: "versions-all.json", content: JSON.stringify(versionsAll, null, 2) },
    ];

    await sendEmail("🚨 디자인 시스템 변경 감지", lines.filter(Boolean), attachments);
  }

  // 최신 버전 id로 스냅샷 저장(다음 비교 기준)
  fs.writeFileSync(SNAP_PATH, JSON.stringify({ ...curr, meta: { ...curr.meta, versionId: latestVersionId } }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sendEmail("⚠️ DS Watcher 오류", [String(e instanceof Error ? e.stack || e.message : e)]);
  } catch {}
  process.exit(1);
});
