// 合并 docs/api-frag/*.json 为 docs/openapi.json,并生成 docs/swagger.html
// 用法: node docs/api-merge.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fragDir = join(here, 'api-frag');

const TAGS = [
  ['auth', '认证(免鉴权,登录/初始化/改密)'],
  ['system', '系统状态与运维(健康/统计/审计/GC)'],
  ['logs', '日志查询与实时流'],
  ['update', '版本检查/升级/回滚'],
  ['settings', '全局设置(通用/Web搜索/Python)'],
  ['commands', '命令执行记录'],
  ['report', '报告导出'],
  ['tasks', '任务管理(创建/控制/元数据/意图)'],
  ['task-categories', '任务分类'],
  ['task-templates', '任务模板'],
  ['task-archives', '任务归档(打包/恢复/删除)'],
  ['goals', '任务目标管理'],
  ['constraints', '任务操作约束'],
  ['scope', '任务测试范围'],
  ['intercept-rules', '任务级拦截规则'],
  ['task-assets', '任务与资产关联'],
  ['assets', '资产库'],
  ['companies', '公司/单位管理'],
  ['workspace', '任务工作区文件'],
  ['sync', '外部数据源同步(ScopeSentry)'],
  ['exploration', '探索过程(活动流/图/节点)'],
  ['findings', '发现管理与复测'],
  ['finding-traffic', '发现-流量证据绑定'],
  ['tokens', 'Token 用量统计'],
  ['traffic', '流量录制记录'],
  ['llm', 'LLM 全局配置/连通性/模型'],
  ['llm-records', 'LLM 调用记录'],
  ['llm-profiles', 'LLM 多档位配置'],
  ['chat', '主对话(人在环路)'],
  ['conversations', '会话管理'],
  ['side-questions', '追问(side question)任务'],
  ['notify', '通知渠道与投递'],
  ['agents', 'Agent 配置(提示词/收尾/触发器)'],
  ['triggers', '触发器管理'],
  ['tools', '内置与自定义工具'],
  ['mcp', 'MCP 服务器管理'],
  ['skills', '技能包管理'],
  ['visibility', '可见性(可见范围/开关)'],
  ['intercept', '命令拦截(规则/审批/历史)'],
  ['asset-intercept', '资产拦截规则'],
];

const files = readdirSync(fragDir).filter(f => f.endsWith('.json')).sort();
const fragments = files.map(f => {
  const raw = readFileSync(join(fragDir, f), 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error(`${f} JSON 解析失败: ${e.message}`); }
  return { file: f, ...obj };
});
console.log(`读取片段 ${fragments.length} 个: ${files.join(', ')}`);

// ---- merge schemas first (per-fragment rename map, only when structurally different) ----
const stripDesc = node => {
  if (Array.isArray(node)) return node.map(stripDesc);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) if (k !== 'description') out[k] = stripDesc(v);
    return out;
  }
  return node;
};
const canon = s => JSON.stringify(stripDesc(s));
const rewriteRefs = (node, ren) => {
  if (!ren || Object.keys(ren).length === 0) return node;
  if (Array.isArray(node)) return node.map(n => rewriteRefs(n, ren));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = v.match(/^#\/components\/schemas\/(.+)$/);
        out[k] = m && ren[m[1]] ? `#/components/schemas/${ren[m[1]]}` : v;
      } else out[k] = rewriteRefs(v, ren);
    }
    return out;
  }
  return node;
};
const schemas = {};
const fragRenames = new Map();
for (const frag of fragments) {
  const ren = {};
  const contributed = [];
  for (const [name, sch] of Object.entries(frag.schemas || {})) {
    if (!schemas[name]) { schemas[name] = sch; contributed.push(name); continue; }
    if (canon(schemas[name]) === canon(sch)) continue; // structurally identical, keep first
    let i = 2;
    let nn = `${name}_${i}`;
    while (schemas[nn] && canon(schemas[nn]) !== canon(sch)) { i++; nn = `${name}_${i}`; }
    ren[name] = nn;
    if (!schemas[nn]) { schemas[nn] = sch; contributed.push(nn); }
    console.warn(`[schema 冲突] ${frag.file}: ${name} -> ${nn}`);
  }
  for (const n of contributed) schemas[n] = rewriteRefs(schemas[n], ren);
  fragRenames.set(frag.file, ren);
}

// ---- merge paths, applying each fragment's own renames ----
const paths = {};
for (const frag of fragments) {
  const ren = fragRenames.get(frag.file) || {};
  for (const [p, rawItem] of Object.entries(frag.paths || {})) {
    const item = rewriteRefs(rawItem, ren);
    if (!paths[p]) paths[p] = {};
    for (const [m, op] of Object.entries(item)) {
      if (m === 'parameters') { paths[p].parameters = op; continue; }
      if (paths[p][m]) {
        console.warn(`[路径冲突] ${frag.file}: ${m.toUpperCase()} ${p} 已在别的片段定义,跳过`);
        continue;
      }
      paths[p][m] = op;
    }
  }
}

// ---- normalize to strict OpenAPI 3.0 ----
for (const item of Object.values(paths)) {
  for (const op of Object.values(item)) {
    if (!op || typeof op !== 'object' || !op.responses) continue;
    for (const resp of Object.values(op.responses)) {
      if (!resp || !resp.content) continue;
      for (const media of Object.values(resp.content)) {
        if (media && media.description) {
          const d = media.description;
          delete media.description;
          if (media.schema) media.schema.description = media.schema.description ? `${media.schema.description};${d}` : d;
          else resp.description = resp.description ? `${resp.description};${d}` : d;
        }
      }
    }
  }
}
const addMissingType = node => {
  if (Array.isArray(node)) { node.forEach(addMissingType); return; }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) addMissingType(v);
    if (node.nullable === true && !node.type) {
      if (node.allOf || node.properties || node.additionalProperties) node.type = 'object';
      else if (node.items) node.type = 'array';
    }
  }
};
for (const p of Object.keys(paths)) addMissingType(paths[p]);
for (const n of Object.keys(schemas)) addMissingType(schemas[n]);

// ---- operationId uniqueness ----
const seenOp = new Map();
let opCount = 0;
for (const [p, item] of Object.entries(paths)) {
  for (const [m, op] of Object.entries(item)) {
    opCount++;
    let id = op.operationId;
    if (!id) { id = `${m}_${p.replace(/[^a-zA-Z0-9]+/g, '_')}`; op.operationId = id; }
    if (seenOp.has(id)) {
      const nn = `${id}_${seenOp.get(id) + 1}`;
      seenOp.set(id, seenOp.get(id) + 1);
      console.warn(`[operationId 重复] ${id} -> ${nn}`);
      op.operationId = nn;
    } else seenOp.set(id, 1);
  }
}

// ---- global security: bearer everywhere except /api/auth/* ----
for (const [p, item] of Object.entries(paths)) {
  for (const op of Object.values(item)) {
    if (p.startsWith('/api/auth/')) op.security = [];
    else if (!op.security) op.security = [{ bearerAuth: [] }];
  }
}

// ---- sanity checks ----
const warn = [];
for (const [p, item] of Object.entries(paths)) {
  const declared = new Set();
  for (const param of item.parameters || []) if (param.in === 'path') declared.add(param.name);
  for (const op of Object.values(item)) {
    if (op && typeof op === 'object' && Array.isArray(op.parameters)) {
      for (const param of op.parameters) if (param.in === 'path') declared.add(param.name);
    }
  }
  for (const m of p.matchAll(/\{([^}]+)\}/g)) {
    if (!declared.has(m[1])) warn.push(`${p} 的 {${m[1]}} 未在 parameters 声明`);
  }
}
const refTargets = new Set([...Object.keys(schemas), 'Error']);
const walk = (node, ctx) => {
  if (Array.isArray(node)) { node.forEach(n => walk(n, ctx)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = v.match(/^#\/components\/schemas\/(.+)$/);
        if (m && !refTargets.has(m[1])) warn.push(`未解析引用 ${v} (${ctx})`);
        if (v === '#/components/schemas/Error') refTargets.add('Error');
      } else walk(v, ctx);
    }
  }
};
for (const [p, item] of Object.entries(paths)) walk(item, `${p}`);
for (const [n, s] of Object.entries(schemas)) walk(s, `schema ${n}`);

const tagSet = new Set(TAGS.map(t => t[0]));
for (const [p, item] of Object.entries(paths)) {
  for (const op of Object.values(item)) {
    for (const t of op.tags || []) if (!tagSet.has(t)) { TAGS.push([t, t]); tagSet.add(t); }
  }
}

schemas.Error = {
  type: 'object',
  description: '统一错误响应(writeErr 输出)',
  properties: { error: { type: 'string', description: '错误信息' } },
  required: ['error'],
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'ARTEX API',
    version: '0.3.15',
    description: [
      'ARTEX —— AI 自主渗透测试系统后端 HTTP API。',
      '',
      '**鉴权**:除 `/api/auth/*`(登录/初始化/改密/状态)外,所有接口均需 JWT。三种携带方式:',
      '1. 请求头 `Authorization: Bearer <token>`(常规请求);',
      '2. Cookie `artex_token`(浏览器自动携带);',
      '3. 查询参数 `?token=<token>`(仅建议用于 SSE 流式接口,浏览器 EventSource 无法自定义请求头)。',
      '',
      'Token 通过 `POST /api/auth/login` 获取(HS256,有效期 7 天);首次使用需 `POST /api/auth/init` 初始化账号。',
      '',
      '**响应约定**:成功响应直接返回业务数据(无统一信封,列表接口多为 JSON 数组);',
      '错误响应统一为 `{"error": "<message>"}`,HTTP 状态码见各接口定义(400 参数错误 / 401 未认证 / 404 不存在 / 409 状态冲突 / 500 服务端错误)。',
      '',
      '**SSE 流式接口**:路径带 `/stream`、`/events` 的接口返回 `text/event-stream`,事件通过 `data:` 行携带 JSON。',
      '',
      '**路径参数约定**:`{id}` 型任务 ID 除数字 ID 外普遍支持 `active`(当前活跃任务),详见各接口说明。',
      '',
      `共 ${opCount} 个操作,${Object.keys(paths).length} 个路径。默认服务地址 http://localhost:8787。`,
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:8787', description: '默认本地服务' }],
  tags: TAGS.map(([name, desc]) => ({ name, description: desc })),
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'POST /api/auth/login 获取的 JWT' },
    },
    schemas,
  },
  security: [{ bearerAuth: [] }],
  paths,
};

// ---- coverage check against the route table extracted from source ----
try {
  const expected = readFileSync(join(here, 'expected-routes.txt'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/\{(\w+)\.\.\.\}/, '{$1}'));
  const got = new Set();
  for (const [p, item] of Object.entries(paths)) {
    for (const m of Object.keys(item)) got.add(`${m.toUpperCase()} ${p}`);
  }
  const missing = expected.filter(e => !got.has(e));
  if (missing.length) {
    console.warn(`[覆盖缺失] 以下 ${missing.length} 条路由未文档化:`);
    missing.forEach(m => console.warn('  - ' + m));
  } else {
    console.log(`覆盖校验通过: ${expected.length}/${expected.length} 条路由全部文档化`);
  }
} catch (e) { console.warn('跳过覆盖校验(无 expected-routes.txt)'); }

writeFileSync(join(here, 'openapi.json'), JSON.stringify(spec, null, 2));
console.log(`已写入 openapi.json: ${opCount} operations / ${Object.keys(paths).length} paths / ${Object.keys(schemas).length} schemas`);
if (warn.length) {
  console.warn(`校验警告 ${warn.length} 条:`);
  warn.forEach(w => console.warn('  - ' + w));
}

// ---- generate self-contained swagger.html ----
const specJson = JSON.stringify(spec).replace(/<\//g, '<\\/');
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARTEX API 文档</title>
<link rel="stylesheet" href="swagger-ui/swagger-ui.css">
<style>
body { margin: 0; background: #fafafa; }
#swagger-ui .topbar { display: none; }
.badge-note { font-size: 12px; color: #3b4151; padding: 8px 16px; background: #fff8e6; border-bottom: 1px solid #ffe58f; }
</style>
</head>
<body>
<div class="badge-note">离线单页版:规范已内嵌、UI 资源在本地 swagger-ui/ 目录,双击即可查看,无需服务端与外网。</div>
<div id="swagger-ui"></div>
<script src="swagger-ui/swagger-ui-bundle.js"></script>
<script src="swagger-ui/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function () {
  var spec = ${specJson};
  window.ui = SwaggerUIBundle({
    spec: spec,
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    tryItOutEnabled: true,
    persistAuthorization: true,
    docExpansion: 'list',
    tagsSorter: 'alpha',
    operationsSorter: 'alpha',
  });
};
</script>
</body>
</html>
`;
writeFileSync(join(here, 'swagger.html'), html);
console.log('已写入 swagger.html(内嵌完整规范,双击即可在浏览器查看)');
