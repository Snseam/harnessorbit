import { createConversationView } from './conversations.mjs';

let conversationView = null;
const TOKEN_KEY = 'cao.monitor.token';
const LANG_KEY = 'cao.monitor.lang';
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 16000;
const PAGE_SIZE = 50;
const UNLINKED = '__unlinked__';
const MAX_DEPTH = 12;
const NS = 'http://www.w3.org/2000/svg';

const STATUSES = new Set(['running', 'waiting', 'idle', 'completed', 'failed', 'cancelled', 'unknown']);
const AGENTS = new Set(['codex', 'claude', 'pi', 'opencode', 'unknown']);
const KINDS = new Set(['coordinator', 'agent', 'subagent']);
const DELIVERIES = new Set(['submitted', 'accepted', 'integrated', 'rework']);
const NODE_SOURCES = new Set(['cao', 'codex', 'claude-hooks', 'claude-local']);
const CONFIDENCE = new Set(['live', 'observed', 'reported', 'unknown']);
const RELATIONS = new Set(['native', 'cao', 'workspace', 'unlinked']);
const SOURCE_STATES = new Set(['connected', 'partial', 'unavailable']);
const TOKEN_SCOPES = new Set(['session', 'turn', 'observed']);
const EXECUTOR_KINDS = new Set(['host', 'external']);
const ROUTE_PREFERENCES = new Set(['fastest', 'quality', 'balanced', 'cost', 'subscription-first']);
const NATIVE_CHILD_STATES = new Set(['verified', 'reported', 'unknown', 'blocked']);
const TIMING_PHASES = ['prepare', 'launch', 'execute', 'collect', 'verify', 'integrate'];
const TIMING_STATES = new Set([...TIMING_PHASES, 'blocked', 'finished', 'unknown']);

const COPY = {
  en: {
    skip: 'Skip to activity',
    appName: 'CAO · Agent Monitor',
    title: 'CAO · Agent Monitor',
    language: 'Language',
    refresh: 'Refresh',
    retry: 'Retry',
    loading: 'Loading',
    loadingDetail: 'Loading observed agents. No placeholder rows are shown.',
    filters: 'Filters',
    search: 'Search',
    searchPlaceholder: 'Label, id, task',
    project: 'Project',
    status: 'Status',
    software: 'Software',
    sources: 'Sources',
    counts: 'Status counts',
    countActive: 'Active',
    countWaiting: 'Waiting / idle',
    countFinished: 'Finished',
    countUnknown: 'Unknown',
    activity: 'Agent activity',
    activityCaption: 'Hierarchical agent status',
    details: 'Details',
    closeDetails: 'Close details',
    colAgent: 'Agent',
    colStatus: 'Status',
    colTokens: 'Tokens',
    colDelivery: 'Delivery',
    colUpdated: 'Updated',
    colSource: 'Source',
    allInScope: 'All in this scope',
    allStatuses: 'All statuses',
    allSoftware: 'All software',
    statusRunning: 'Running',
    statusWaiting: 'Waiting',
    statusIdle: 'Idle',
    statusCompleted: 'Finished turn',
    statusFailed: 'Failed',
    statusCancelled: 'Cancelled',
    statusUnknown: 'Unknown',
    deliverySubmitted: 'Submitted',
    deliveryAccepted: 'Accepted',
    deliveryIntegrated: 'Integrated',
    deliveryRework: 'Rework',
    connected: 'Connected',
    disconnected: 'Disconnected',
    stale: 'Stale',
    unauthorized: 'Unauthorized',
    missingToken: 'A local monitor token is required. Open this page from the CAO CLI.',
    unavailable: 'The monitor could not be reached. The last snapshot is kept when one exists.',
    empty: 'No matching sessions are available. Check the current scope or start work through CAO.',
    noMatches: 'No agents match the current filters.',
    truncated: 'This snapshot is truncated. Narrow the scope to see remaining agents.',
    unlinked: 'Unlinked',
    expand: 'Expand',
    collapse: 'Collapse',
    previous: 'Previous',
    next: 'Next',
    page: 'Page',
    observed: 'Last observation',
    staleNote: 'Showing last snapshot',
    scopeProject: 'Collection is limited to this CAO project. Machine-wide data is not included. Use CLI --all for machine scope.',
    scopeAll: 'Showing every session supplied by this monitor’s configured scope.',
    scopeProjectShort: 'Current project',
    scopeAllShort: 'All sessions',
    scopeRun: 'Filtered to run',
    showFilters: 'Show filters',
    hideFilters: 'Hide filters',
    hint: 'A finished native turn is not a CAO accepted delivery. Unknown, stale, and unavailable states are shown explicitly.',
    dash: '—',
    kindCoordinator: 'Coordinator',
    kindAgent: 'Agent',
    kindSubagent: 'Subagent',
    fieldId: 'Id',
    fieldParent: 'Parent',
    fieldAgent: 'Software',
    fieldKind: 'Kind',
    fieldLabel: 'Label',
    fieldRole: 'Role',
    fieldModel: 'Model',
    fieldProject: 'Project',
    fieldRun: 'Run',
    fieldTask: 'Task',
    fieldAttempt: 'Attempt',
    fieldNative: 'Native session',
    fieldStatus: 'Status',
    fieldStatusLabel: 'Status label',
    fieldDelivery: 'Delivery',
    fieldStarted: 'Started',
    fieldUpdated: 'Updated',
    fieldFinished: 'Finished',
    fieldObserved: 'Observed',
    fieldStale: 'Stale',
    fieldSource: 'Source',
    fieldConfidence: 'Confidence',
    fieldRelation: 'Relation',
    fieldExecutor: 'Executor',
    fieldRouteMode: 'Route',
    fieldRouteResource: 'Selected resource',
    fieldRoutePreference: 'Route preference',
    fieldRouteReasons: 'Route reasons',
    fieldPhase: 'Phase',
    fieldPhaseDurations: 'Phase timing',
    fieldBlocked: 'Blocked',
    fieldBlocker: 'Blocker',
    fieldLastProgress: 'Last progress',
    fieldLastObserved: 'Last timing observation',
    fieldLegacyPrehistory: 'Legacy prehistory',
    fieldNativeChildren: 'Native children',
    fieldNativeChildrenSource: 'Child evidence',
    fieldNativeChildrenCount: 'Child count',
    fieldTokens: 'Tokens',
    fieldTokenScope: 'Token scope',
    fieldTokenSource: 'Token source',
    fieldTokenCoverage: 'Token coverage',
    fieldTokenInput: 'Input',
    fieldTokenOutput: 'Output',
    fieldTokenCacheRead: 'Cache read',
    fieldTokenCacheWrite: 'Cache write',
    fieldTokenReasoning: 'Reasoning',
    tokenPartial: 'Partial',
    tokenComplete: 'Complete',
    tokenScopeSession: 'Session',
    tokenScopeTurn: 'Turn',
    tokenScopeObserved: 'Observed',
    executorHost: 'Codex host',
    executorExternal: 'External agent',
    childVerified: 'Verified',
    childReported: 'Reported',
    childUnknown: 'Unknown',
    childBlocked: 'Blocked',
    phasePrepare: 'Prepare',
    phaseLaunch: 'Launch',
    phaseExecute: 'Execute',
    phaseCollect: 'Collect',
    phaseVerify: 'Verify',
    phaseIntegrate: 'Integrate',
    phaseBlocked: 'Blocked',
    phaseFinished: 'Finished',
    phaseUnknown: 'Unknown',
    yes: 'Yes',
    no: 'No',
    sourceConnected: 'Connected',
    sourcePartial: 'Partial',
    sourceUnavailable: 'Unavailable',
    announceConnected: 'Monitor connected.',
    announceDisconnected: 'Monitor disconnected. Last snapshot retained when available.',
    announceUnauthorized: 'Monitor token was rejected.',
    announceStale: 'Showing a stale snapshot.',
    contextRow: 'Ancestor kept for context',
    selectAgent: 'Show details',
  },
  zh: {
    skip: '跳到活动列表',
    appName: 'CAO · Agent 看板',
    title: 'CAO · Agent 看板',
    language: '语言',
    refresh: '刷新',
    retry: '重试',
    loading: '正在加载',
    loadingDetail: '正在加载已观察的代理，不会显示占位行。',
    filters: '筛选',
    search: '搜索',
    searchPlaceholder: '标签、编号、任务',
    project: '项目',
    status: '状态',
    software: '软件',
    sources: '来源',
    counts: '状态计数',
    countActive: '活动中',
    countWaiting: '等待／空闲',
    countFinished: '已结束',
    countUnknown: '未知',
    activity: '代理活动',
    activityCaption: '分层代理状态',
    details: '详情',
    closeDetails: '关闭详情',
    colAgent: '代理',
    colStatus: '状态',
    colTokens: '令牌',
    colDelivery: '交付',
    colUpdated: '更新时间',
    colSource: '来源',
    allInScope: '当前范围内全部',
    allStatuses: '全部状态',
    allSoftware: '全部软件',
    statusRunning: '运行中',
    statusWaiting: '等待中',
    statusIdle: '空闲',
    statusCompleted: '回合已结束',
    statusFailed: '失败',
    statusCancelled: '已取消',
    statusUnknown: '未知',
    deliverySubmitted: '已提交',
    deliveryAccepted: '已接受',
    deliveryIntegrated: '已集成',
    deliveryRework: '返工',
    connected: '已连接',
    disconnected: '已断开',
    stale: '已过期',
    unauthorized: '未授权',
    missingToken: '需要本地监视令牌。请从 CAO CLI 打开此页面。',
    unavailable: '无法连接监视器。若已有快照，将继续显示上次观察结果。',
    empty: '没有可用的匹配会话。请检查当前范围，或通过 CAO 开始工作。',
    noMatches: '没有代理符合当前筛选条件。',
    truncated: '快照已被截断。请缩小范围以查看其余代理。',
    unlinked: '未关联',
    expand: '展开',
    collapse: '折叠',
    previous: '上一页',
    next: '下一页',
    page: '页',
    observed: '最近观察',
    staleNote: '正在显示上次快照',
    scopeProject: '当前集合仅限此 CAO 项目，不包含机器范围数据。机器范围请使用 CLI --all。',
    scopeAll: '显示此监视器已配置范围内的全部会话。',
    scopeProjectShort: '当前项目',
    scopeAllShort: '全部会话',
    scopeRun: '已限定运行',
    showFilters: '显示筛选',
    hideFilters: '隐藏筛选',
    hint: '本机回合结束并不等于 CAO 已接受交付。未知、过期和不可用状态会明确标出。',
    dash: '—',
    kindCoordinator: '协调器',
    kindAgent: '代理',
    kindSubagent: '子代理',
    fieldId: '编号',
    fieldParent: '父级',
    fieldAgent: '软件',
    fieldKind: '类型',
    fieldLabel: '标签',
    fieldRole: '角色',
    fieldModel: '模型',
    fieldProject: '项目',
    fieldRun: '运行',
    fieldTask: '任务',
    fieldAttempt: '尝试',
    fieldNative: '本机会话',
    fieldStatus: '状态',
    fieldStatusLabel: '状态说明',
    fieldDelivery: '交付',
    fieldStarted: '开始',
    fieldUpdated: '更新',
    fieldFinished: '结束',
    fieldObserved: '观察',
    fieldStale: '过期',
    fieldSource: '来源',
    fieldConfidence: '置信',
    fieldRelation: '关系',
    fieldExecutor: '执行器',
    fieldRouteMode: '路由',
    fieldRouteResource: '选中资源',
    fieldRoutePreference: '路由偏好',
    fieldRouteReasons: '路由原因',
    fieldPhase: '阶段',
    fieldPhaseDurations: '阶段耗时',
    fieldBlocked: '阻塞时长',
    fieldBlocker: '阻塞类型',
    fieldLastProgress: '最近进展',
    fieldLastObserved: '最近计时观察',
    fieldLegacyPrehistory: '旧记录前史',
    fieldNativeChildren: '本机子代理',
    fieldNativeChildrenSource: '子代理证据',
    fieldNativeChildrenCount: '子代理数量',
    fieldTokens: '令牌数',
    fieldTokenScope: '用量范围',
    fieldTokenSource: '用量来源',
    fieldTokenCoverage: '覆盖',
    fieldTokenInput: '输入',
    fieldTokenOutput: '输出',
    fieldTokenCacheRead: '缓存读取',
    fieldTokenCacheWrite: '缓存写入',
    fieldTokenReasoning: '推理',
    tokenPartial: '部分',
    tokenComplete: '完整',
    tokenScopeSession: '会话',
    tokenScopeTurn: '回合',
    tokenScopeObserved: '观察',
    executorHost: 'Codex 主控',
    executorExternal: '外部代理',
    childVerified: '已验证',
    childReported: '已报告',
    childUnknown: '未知',
    childBlocked: '阻塞',
    phasePrepare: '准备',
    phaseLaunch: '启动',
    phaseExecute: '执行',
    phaseCollect: '收集',
    phaseVerify: '验证',
    phaseIntegrate: '集成',
    phaseBlocked: '阻塞',
    phaseFinished: '已结束',
    phaseUnknown: '未知',
    yes: '是',
    no: '否',
    sourceConnected: '已连接',
    sourcePartial: '部分可用',
    sourceUnavailable: '不可用',
    announceConnected: '监视器已连接。',
    announceDisconnected: '监视器已断开。若可用将保留上次快照。',
    announceUnauthorized: '监视令牌被拒绝。',
    announceStale: '正在显示过期快照。',
    contextRow: '为保留层级而显示的祖先',
    selectAgent: '查看详情',
  },
};

const state = {
  lang: 'en',
  token: null,
  snapshot: null,
  stale: false,
  connection: 'loading',
  selectedId: null,
  expanded: new Set(),
  didExpand: false,
  projectSig: '',
  page: 0,
  backoff: POLL_MS,
  inFlight: false,
  timer: 0,
  lastAnnouncement: '',
  filtersOpen: false,
  compactQuery: null,
};

function t(key) {
  return COPY[state.lang][key] || COPY.en[key] || key;
}

function dash(value) {
  return value == null || value === '' ? t('dash') : value;
}

export function captureTokenFromLocation(location, history, storage) {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  if (token) {
    storage.setItem(TOKEN_KEY, token);
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  }
  return storage.getItem(TOKEN_KEY);
}

function asText(value, max = 256) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function asEnum(value, allowed, fallback = null) {
  return allowed.has(value) ? value : fallback;
}

function asIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function asTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = asTokens(raw.total);
  if (total === null) return null;
  return {
    total,
    input: asTokens(raw.input),
    output: asTokens(raw.output),
    cacheRead: asTokens(raw.cacheRead),
    cacheWrite: asTokens(raw.cacheWrite),
    reasoning: asTokens(raw.reasoning),
    scope: asEnum(raw.scope, TOKEN_SCOPES, 'observed'),
    source: asText(raw.source, 80) || 'unknown',
    complete: raw.complete === true,
  };
}

function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object' || raw.mode !== 'adaptive') return null;
  return {
    mode: 'adaptive',
    resourceId: asText(raw.resourceId, 160),
    preference: asEnum(raw.preference, ROUTE_PREFERENCES, asText(raw.preference, 40)),
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(reason => asText(reason, 160)).filter(Boolean).slice(0, 12) : [],
  };
}

function normalizeNativeChildren(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    state: asEnum(raw.state, NATIVE_CHILD_STATES, 'unknown'),
    complete: raw.complete === true,
    source: asText(raw.source, 80),
    count: asTokens(raw.count),
  };
}

function normalizePerformance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const durationsMs = {};
  for (const phase of TIMING_PHASES) durationsMs[phase] = asTokens(raw.durationsMs?.[phase]);
  return {
    phase: asEnum(raw.phase, TIMING_STATES, 'unknown'),
    durationsMs,
    blockedMs: asTokens(raw.blockedMs),
    lastProgressAt: asIso(raw.lastProgressAt),
    lastObservedAt: asIso(raw.lastObservedAt),
    blockerCategory: asText(raw.blockerCategory, 40),
    legacyPrehistory: raw.legacyPrehistory === true,
    lastErrorCode: asText(raw.lastErrorCode, 80),
  };
}

function tokenTotal(node) {
  const fromUsage = asTokens(node?.tokenUsage?.total);
  return fromUsage != null ? fromUsage : asTokens(node?.tokens);
}

function tokenIsPartial(node) {
  const usage = node?.tokenUsage;
  if (!usage) return false;
  return usage.complete !== true || usage.scope === 'observed';
}

function normalizeNode(raw) {
  const id = asText(raw?.id, 256);
  if (!id) return null;
  const tokenUsage = normalizeTokenUsage(raw.tokenUsage);
  return {
    id,
    parentId: asText(raw.parentId, 256),
    conversationId: asText(raw.conversationId, 128),
    conversationTitle: asText(raw.conversationTitle, 160),
    agent: asEnum(raw.agent, AGENTS, 'unknown'),
    executorKind: asEnum(raw.executorKind, EXECUTOR_KINDS),
    route: normalizeRoute(raw.route),
    nativeChildren: normalizeNativeChildren(raw.nativeChildren),
    kind: asEnum(raw.kind, KINDS, 'agent'),
    label: asText(raw.label, 160) || t('dash'),
    role: asText(raw.role, 80),
    model: asText(raw.model, 120),
    projectId: asText(raw.projectId, 1024),
    runId: asText(raw.runId, 64),
    taskId: asText(raw.taskId, 64),
    attemptId: asText(raw.attemptId, 128),
    nativeSessionId: asText(raw.nativeSessionId, 128),
    status: asEnum(raw.status, STATUSES, 'unknown'),
    statusLabel: asText(raw.statusLabel, 100),
    delivery: asEnum(raw.delivery, DELIVERIES),
    startedAt: asIso(raw.startedAt),
    updatedAt: asIso(raw.updatedAt),
    finishedAt: asIso(raw.finishedAt),
    observedAt: asIso(raw.observedAt),
    stale: raw.stale === true,
    source: asEnum(raw.source, NODE_SOURCES, 'cao'),
    confidence: asEnum(raw.confidence, CONFIDENCE, 'unknown'),
    relation: asEnum(raw.relation, RELATIONS, 'unlinked'),
    tokens: tokenUsage?.total ?? asTokens(raw.tokens),
    tokenUsage,
    performance: normalizePerformance(raw.performance),
  };
}

export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) return null;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.projects) || !Array.isArray(raw.sources)) return null;
  const nodes = [];
  const seen = new Set();
  for (const item of raw.nodes) {
    const node = normalizeNode(item);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const walked = new Set([node.id]);
    let cursor = node.parentId;
    while (cursor && byId.has(cursor)) {
      if (walked.has(cursor)) {
        node.parentId = null;
        node.relation = 'unlinked';
        break;
      }
      walked.add(cursor);
      cursor = byId.get(cursor).parentId;
    }
  }
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  return {
    schemaVersion: 1,
    observedAt: asIso(raw.observedAt),
    scope: {
      mode: scope.mode === 'all' ? 'all' : 'project',
      project: asText(scope.project, 1024),
      runId: asText(scope.runId, 64),
    },
    projects: raw.projects.map(project => ({
      id: asText(project?.id, 1024),
      label: asText(project?.label, 160),
      path: asText(project?.path, 1024),
    })).filter(project => project.id),
    nodes,
    currentConversationId: asText(raw.currentConversationId, 128),
    conversations: (Array.isArray(raw.conversations) ? raw.conversations : []).slice(0, 1000).map(item => ({
      id: asText(item?.id, 128), title: asText(item?.title, 160), rootNodeId: asText(item?.rootNodeId, 256),
      projectIds: Array.isArray(item?.projectIds) ? item.projectIds.map(p => asText(p, 1024)).filter(Boolean) : [],
      status: asEnum(item?.status, STATUSES, 'unknown'), updatedAt: asIso(item?.updatedAt),
      agentCount: asTokens(item?.agentCount) ?? 0, current: item?.current === true,
    })).filter(item => item.id),
    sources: raw.sources.map(source => ({
      id: asText(source?.id, 40),
      status: asEnum(source?.status, SOURCE_STATES, 'unavailable'),
      label: asText(source?.label, 80) || t('dash'),
      detail: asText(source?.detail, 240) || '',
    })).filter(source => source.id),
    truncated: raw.truncated === true,
  };
}

function compareNodes(a, b) {
  const left = a.startedAt || a.id;
  const right = b.startedAt || b.id;
  return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
}

export function buildForest(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map();
  const roots = [];
  const unlinked = [];
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = children.get(node.parentId) || [];
      list.push(node);
      children.set(node.parentId, list);
    } else if (node.parentId) unlinked.push(node);
    else roots.push(node);
  }
  for (const list of children.values()) list.sort(compareNodes);
  roots.sort(compareNodes);
  unlinked.sort(compareNodes);
  return { byId, children, roots, unlinked };
}

function filtersFromDom() {
  const view = conversationView?.getFilter() || { view: 'project' };
  return {
    ...view,
    project: view.view === 'conversation' ? '' : document.getElementById('filter-project').value,
    status: document.getElementById('filter-status').value,
    agent: document.getElementById('filter-agent').value,
    search: document.getElementById('filter-search').value.trim().toLowerCase(),
  };
}

export function matchesConversation(node, filters) {
  if (filters.view !== 'conversation') return true;
  if (filters.unlinked) return node.conversationId == null;
  return Boolean(filters.conversationId) && node.conversationId === filters.conversationId;
}

export function nodeMatches(node, filters) {
  if (!matchesConversation(node, filters)) return false;
  if (filters.project && node.projectId !== filters.project) return false;
  if (filters.status && node.status !== filters.status) return false;
  if (filters.agent && node.agent !== filters.agent) return false;
  if (!filters.search) return true;
  const haystack = [node.label, node.role, node.id, node.taskId, node.attemptId, node.model, node.nativeSessionId, node.runId];
  return haystack.some(value => value && value.toLowerCase().includes(filters.search));
}

function keepSet(forest, filters) {
  const hits = new Set();
  for (const node of forest.byId.values()) {
    if (nodeMatches(node, filters)) hits.add(node.id);
  }
  const keep = new Set(hits);
  for (const id of hits) {
    const walked = new Set();
    let cursor = forest.byId.get(id)?.parentId;
    while (cursor && forest.byId.has(cursor) && !walked.has(cursor)) {
      keep.add(cursor);
      walked.add(cursor);
      cursor = forest.byId.get(cursor).parentId;
    }
  }
  return { hits, keep };
}

function expandHitAncestors(forest, hits) {
  for (const id of hits) {
    const walked = new Set();
    let cursor = forest.byId.get(id)?.parentId;
    while (cursor && forest.byId.has(cursor) && !walked.has(cursor)) {
      state.expanded.add(cursor);
      walked.add(cursor);
      cursor = forest.byId.get(cursor).parentId;
    }
    if (forest.unlinked.some(node => node.id === id || walked.has(node.id))) {
      state.expanded.add(UNLINKED);
    }
  }
}

function pushTree(forest, node, depth, hits, keep, rows) {
  if (!keep.has(node.id)) return;
  const kids = (forest.children.get(node.id) || []).filter(child => keep.has(child.id));
  rows.push({
    type: 'node',
    node,
    depth: Math.min(depth, MAX_DEPTH),
    hasChildren: kids.length > 0,
    isContext: !hits.has(node.id),
  });
  if (kids.length && state.expanded.has(node.id)) {
    for (const child of kids) pushTree(forest, child, depth + 1, hits, keep, rows);
  }
}

function visibleRows(forest, filters) {
  const { hits, keep } = keepSet(forest, filters);
  const tops = [];
  for (const root of forest.roots) if (keep.has(root.id)) tops.push({ type: 'root', node: root });
  const unlinked = forest.unlinked.filter(node => keep.has(node.id));
  if (unlinked.length) tops.push({ type: 'unlinked', nodes: unlinked });
  const pageCount = Math.max(1, Math.ceil(tops.length / PAGE_SIZE) || 1);
  if (state.page > pageCount - 1) state.page = pageCount - 1;
  const slice = tops.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  const rows = [];
  for (const item of slice) {
    if (item.type === 'unlinked') {
      rows.push({ type: 'group', id: UNLINKED, label: t('unlinked') });
      if (state.expanded.has(UNLINKED)) {
        for (const node of item.nodes) pushTree(forest, node, 1, hits, keep, rows);
      }
    } else pushTree(forest, item.node, 0, hits, keep, rows);
  }
  return { rows, hits, keep, pageCount, totalTops: tops.length };
}

export function countStatuses(nodes, projectId) {
  const counts = { active: 0, waiting: 0, finished: 0, unknown: 0 };
  for (const node of nodes) {
    if (projectId && node.projectId !== projectId) continue;
    if (node.status === 'running') counts.active += 1;
    else if (node.status === 'waiting' || node.status === 'idle') counts.waiting += 1;
    else if (node.status === 'unknown') counts.unknown += 1;
    else counts.finished += 1;
  }
  return counts;
}

function locale() {
  return state.lang === 'zh' ? 'zh-CN' : 'en';
}

function formatTime(value) {
  const iso = asIso(value);
  if (!iso) return t('dash');
  return new Intl.DateTimeFormat(locale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

function formatTokens(value) {
  if (!Number.isSafeInteger(value) || value < 0) return t('dash');
  return new Intl.NumberFormat(locale()).format(value);
}

function formatCompactTokens(value) {
  if (!Number.isSafeInteger(value) || value < 0) return t('dash');
  return new Intl.NumberFormat(locale(), {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

function tokenScopeLabel(scope) {
  if (scope === 'session') return t('tokenScopeSession');
  if (scope === 'turn') return t('tokenScopeTurn');
  if (scope === 'observed') return t('tokenScopeObserved');
  return t('dash');
}

function tokenCoverageLabel(usage) {
  if (!usage) return t('dash');
  if (usage.complete === true && usage.scope !== 'observed') return t('tokenComplete');
  return t('tokenPartial');
}

function statusLabel(status) {
  const key = {
    running: 'statusRunning',
    waiting: 'statusWaiting',
    idle: 'statusIdle',
    completed: 'statusCompleted',
    failed: 'statusFailed',
    cancelled: 'statusCancelled',
    unknown: 'statusUnknown',
  }[status];
  return key ? t(key) : t('statusUnknown');
}

function deliveryLabel(delivery) {
  if (!delivery) return t('dash');
  const key = {
    submitted: 'deliverySubmitted',
    accepted: 'deliveryAccepted',
    integrated: 'deliveryIntegrated',
    rework: 'deliveryRework',
  }[delivery];
  return key ? t(key) : t('dash');
}

function kindLabel(kind) {
  if (kind === 'coordinator') return t('kindCoordinator');
  if (kind === 'subagent') return t('kindSubagent');
  return t('kindAgent');
}

function executorLabel(kind) {
  if (kind === 'host') return t('executorHost');
  if (kind === 'external') return t('executorExternal');
  return t('dash');
}

function childStateLabel(stateValue) {
  if (stateValue === 'verified') return t('childVerified');
  if (stateValue === 'reported') return t('childReported');
  if (stateValue === 'blocked') return t('childBlocked');
  return t('childUnknown');
}

function phaseLabel(phase) {
  const key = {
    prepare: 'phasePrepare',
    launch: 'phaseLaunch',
    execute: 'phaseExecute',
    collect: 'phaseCollect',
    verify: 'phaseVerify',
    integrate: 'phaseIntegrate',
    blocked: 'phaseBlocked',
    finished: 'phaseFinished',
    unknown: 'phaseUnknown',
  }[phase];
  return key ? t(key) : t('phaseUnknown');
}

export function formatDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return t('dash');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function phaseDurationsLabel(performance) {
  if (!performance?.durationsMs) return t('dash');
  const items = [];
  for (const phase of TIMING_PHASES) {
    const value = performance.durationsMs[phase];
    if (value != null) items.push(`${phaseLabel(phase)} ${formatDuration(value)}`);
  }
  return items.length ? items.join(' · ') : t('dash');
}

export function routeSummary(node) {
  const route = node?.route;
  if (!route) return null;
  const parts = ['adaptive'];
  if (route.resourceId) parts.push(route.resourceId);
  if (route.preference) parts.push(route.preference);
  return parts.join(' · ');
}

export function performanceSummary(node) {
  const timing = node?.performance;
  if (!timing) return null;
  const parts = [phaseLabel(timing.phase)];
  if (timing.blockedMs != null) parts.push(`${t('fieldBlocked')} ${formatDuration(timing.blockedMs)}`);
  const phaseMs = timing.durationsMs?.[timing.phase];
  if (phaseMs != null) parts.push(formatDuration(phaseMs));
  return parts.join(' · ');
}

export function nativeChildrenSummary(node) {
  const children = node?.nativeChildren;
  if (!children) return null;
  const count = children.count == null ? t('dash') : String(children.count);
  return `${childStateLabel(children.state)} · ${count}`;
}

export function agentMeta(node) {
  const parts = [node.agent];
  const executor = executorLabel(node.executorKind);
  parts.push(executor !== t('dash') ? executor : kindLabel(node.kind));
  if (node.route?.mode === 'adaptive') parts.push('adaptive');
  return parts.join(' · ');
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function chevron() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M6 4l6 4-6 4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function announce(message) {
  if (!message || message === state.lastAnnouncement) return;
  state.lastAnnouncement = message;
  document.getElementById('live').textContent = message;
}

function applyI18n() {
  document.documentElement.lang = locale();
  document.title = t('title');
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.getAttribute('data-i18n'));
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria')));
  }
  document.getElementById('lang-en').setAttribute('aria-pressed', String(state.lang === 'en'));
  document.getElementById('lang-zh').setAttribute('aria-pressed', String(state.lang === 'zh'));
}

function setConnection(next) {
  const changed = state.connection !== next;
  state.connection = next;
  const badge = document.getElementById('connection');
  const label = {
    loading: 'loading',
    connected: 'connected',
    disconnected: 'disconnected',
    unauthorized: 'unauthorized',
    missing: 'unauthorized',
    stale: 'stale',
  }[next] || 'disconnected';
  badge.dataset.state = next === 'missing' ? 'unauthorized' : next;
  document.getElementById('connection-text').textContent = t(label === 'unauthorized' && next === 'missing' ? 'unauthorized' : label);
  if (!changed) return;
  if (next === 'connected') announce(t('announceConnected'));
  else if (next === 'stale') announce(t('announceStale'));
  else if (next === 'unauthorized') announce(t('announceUnauthorized'));
  else if (next === 'disconnected') announce(t('announceDisconnected'));
}

function renderScope(snapshot) {
  const line = document.getElementById('scope-line');
  if (!snapshot) {
    line.textContent = '';
    line.removeAttribute('title');
    return;
  }
  const match = snapshot.projects.find(project => project.id === snapshot.scope.project);
  const name = match?.label || snapshot.scope.project;
  if (snapshot.scope.mode === 'all') {
    line.textContent = name ? `${t('scopeAllShort')} · ${name}` : t('scopeAllShort');
  } else {
    line.textContent = name ? `${t('scopeProjectShort')} · ${name}` : t('scopeProjectShort');
  }
  const help = [snapshot.scope.mode === 'all' ? t('scopeAll') : t('scopeProject')];
  if (snapshot.scope.runId) help.push(`${t('scopeRun')} ${snapshot.scope.runId}`);
  line.title = help.join(' ');
}

function renderObserved(snapshot) {
  const node = document.getElementById('observed');
  if (!snapshot?.observedAt) {
    node.textContent = '';
    return;
  }
  const prefix = state.stale ? `${t('staleNote')}: ` : `${t('observed')}: `;
  node.textContent = prefix + formatTime(snapshot.observedAt);
}

function fillProjects(snapshot) {
  const select = document.getElementById('filter-project');
  const projects = snapshot?.projects || [];
  const signature = projects.map(project => `${project.id}\n${project.label || ''}`).join('\0');
  if (signature === state.projectSig && select.options.length === projects.length + 1) {
    select.options[0].textContent = t('allInScope');
    return;
  }
  const current = select.value;
  state.projectSig = signature;
  const keep = [select.options[0]];
  keep[0].textContent = t('allInScope');
  while (select.options.length) select.remove(0);
  select.append(keep[0]);
  for (const project of projects) {
    select.append(el('option', { value: project.id, text: project.label || project.id }));
  }
  select.value = [...select.options].some(option => option.value === current) ? current : '';
}

function renderCounts(snapshot) {
  const filters = filtersFromDom();
  const counts = snapshot ? countStatuses(snapshot.nodes.filter(node => matchesConversation(node, filters)), filters.project) : null;
  for (const key of ['active', 'waiting', 'finished', 'unknown']) {
    document.getElementById(`count-${key}`).textContent = counts ? String(counts[key]) : t('dash');
  }
}

function renderSources(snapshot) {
  const list = document.getElementById('source-list');
  list.replaceChildren();
  for (const source of snapshot?.sources || []) {
    const statusKey = source.status === 'connected' ? 'sourceConnected' : source.status === 'partial' ? 'sourcePartial' : 'sourceUnavailable';
    const item = el('li', { className: 'source-item', dataset: { status: source.status } }, [
      el('div', { className: 'source-top' }, [
        el('span', { className: 'source-dot', 'aria-hidden': 'true' }),
        el('span', { text: source.label }),
        el('span', { text: t(statusKey) }),
      ]),
    ]);
    if (source.detail) item.append(el('p', { className: 'source-detail', text: source.detail }));
    list.append(item);
  }
}

function renderBanner(snapshot) {
  const banner = document.getElementById('banner');
  const messages = [];
  if (!state.token) messages.push(t('missingToken'));
  else if (state.connection === 'unauthorized') messages.push(t('unauthorized'));
  else if (state.connection === 'disconnected' || state.connection === 'stale') messages.push(t('unavailable'));
  if (snapshot?.truncated) messages.push(t('truncated'));
  if (!messages.length) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  banner.classList.toggle('is-error', !snapshot || state.connection === 'unauthorized' || !state.token);
  banner.replaceChildren();
  banner.append(el('span', { text: messages.join(' ') }));
  if (state.token && state.connection !== 'connected') {
    const retry = el('button', { type: 'button', text: t('retry'), dataset: { restore: 'retry' } });
    retry.addEventListener('click', () => {
      state.backoff = POLL_MS;
      poll();
    });
    banner.append(retry);
  }
}

function hideTable(hidden) {
  document.getElementById('table').hidden = hidden;
  document.getElementById('table-wrap').hidden = hidden;
}

function renderEmpty(snapshot, rowCount, hitCount) {
  const loading = document.getElementById('loading');
  const empty = document.getElementById('empty');
  if (!snapshot && state.connection === 'loading') {
    loading.hidden = false;
    empty.hidden = true;
    hideTable(true);
    return;
  }
  loading.hidden = true;
  if (!snapshot || snapshot.nodes.length === 0) {
    empty.hidden = false;
    empty.textContent = t('empty');
    hideTable(true);
    return;
  }
  if (rowCount === 0 || hitCount === 0) {
    empty.hidden = false;
    empty.textContent = t('noMatches');
    hideTable(true);
    return;
  }
  empty.hidden = true;
  hideTable(false);
}

function renderPager(pageCount, totalTops) {
  const pager = document.getElementById('pager');
  if (totalTops <= PAGE_SIZE) {
    pager.hidden = true;
    pager.replaceChildren();
    return;
  }
  pager.hidden = false;
  pager.replaceChildren();
  const prev = el('button', { type: 'button', text: t('previous'), dataset: { restore: 'page-prev' } });
  prev.disabled = state.page <= 0;
  prev.addEventListener('click', () => {
    state.page -= 1;
    render();
  });
  const next = el('button', { type: 'button', text: t('next'), dataset: { restore: 'page-next' } });
  next.disabled = state.page >= pageCount - 1;
  next.addEventListener('click', () => {
    state.page += 1;
    render();
  });
  pager.append(prev, el('span', { text: `${t('page')} ${state.page + 1} / ${pageCount}` }), next);
}

function projectLabel(snapshot, projectId) {
  if (!projectId) return t('dash');
  const match = snapshot.projects.find(project => project.id === projectId);
  return match?.label || projectId;
}

function renderAgentCell(row) {
  const expanded = state.expanded.has(row.node.id);
  const cell = el('div', { className: 'tree-cell', dataset: { depth: String(row.depth) } });
  if (row.hasChildren) {
    const button = el('button', {
      type: 'button',
      className: 'disclosure',
      'aria-expanded': String(expanded),
      'aria-label': expanded ? t('collapse') : t('expand'),
      dataset: { restore: `expand:${row.node.id}` },
    }, [chevron()]);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (expanded) state.expanded.delete(row.node.id);
      else state.expanded.add(row.node.id);
      render();
    });
    cell.append(button);
  } else cell.append(el('span', { className: 'disclosure-spacer', 'aria-hidden': 'true' }));
  const select = el('button', {
    type: 'button',
    className: 'select-agent',
    'aria-label': `${t('selectAgent')}: ${row.node.label}`,
    dataset: { restore: `select:${row.node.id}` },
  });
  const copy = el('span', { className: 'agent-copy' }, [
    el('span', { className: 'agent-label', text: row.node.label }),
    el('span', { className: 'agent-meta', text: agentMeta(row.node) }),
  ]);
  if (row.isContext) copy.append(el('span', { className: 'visually-hidden', text: t('contextRow') }));
  select.append(copy);
  select.addEventListener('click', () => {
    state.selectedId = row.node.id;
    render();
  });
  cell.append(select);
  return cell;
}

function renderDataRow(row, snapshot) {
  const node = row.node;
  const selected = state.selectedId === node.id;
  const tr = el('tr', {
    className: `${selected ? 'is-selected' : ''} ${row.isContext ? 'is-context' : ''}`.trim(),
    'aria-selected': String(selected),
    dataset: { nodeId: node.id },
  });
  tr.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    state.selectedId = node.id;
    render();
  });
  const status = el('span', { className: 'badge', dataset: { status: node.status }, text: statusLabel(node.status) });
  if (node.stale) status.append(el('span', { className: 'stale-flag', text: t('stale') }));
  tr.append(
    el('th', { scope: 'row' }, [renderAgentCell(row)]),
    el('td', { className: 'col-status' }, [status]),
    renderTokenCell(node),
    el('td', { className: 'col-secondary', text: deliveryLabel(node.delivery) }),
    el('td', { className: 'col-secondary', text: formatTime(node.updatedAt) }),
    el('td', { className: 'col-secondary', text: node.source }),
  );
  void snapshot;
  return tr;
}

function renderTokenCell(node) {
  const total = tokenTotal(node);
  const cell = el('td', { className: 'col-tokens' });
  const wrap = el('span', { className: 'token-cell' });
  const value = el('span', { className: 'token-value', text: formatCompactTokens(total) });
  if (total != null) wrap.setAttribute('title', formatTokens(total));
  wrap.append(value);
  if (total != null && tokenIsPartial(node)) {
    wrap.append(el('span', { className: 'token-partial', text: t('tokenPartial') }));
  }
  cell.append(wrap);
  return cell;
}

function renderGroupRow(row) {
  const expanded = state.expanded.has(UNLINKED);
  const tr = el('tr', { className: 'group-row' });
  const button = el('button', {
    type: 'button',
    className: 'disclosure',
    'aria-expanded': String(expanded),
    'aria-label': expanded ? t('collapse') : t('expand'),
    dataset: { restore: `expand:${UNLINKED}` },
  }, [chevron()]);
  button.addEventListener('click', () => {
    if (expanded) state.expanded.delete(UNLINKED);
    else state.expanded.add(UNLINKED);
    render();
  });
  const cell = el('th', { scope: 'row', colSpan: '6' }, [
    el('div', { className: 'tree-cell', dataset: { depth: '0' } }, [button, el('span', { text: row.label })]),
  ]);
  tr.append(cell);
  return tr;
}

function renderTable(rows, snapshot) {
  const body = document.getElementById('tbody');
  body.replaceChildren();
  for (const row of rows) {
    body.append(row.type === 'group' ? renderGroupRow(row) : renderDataRow(row, snapshot));
  }
}

function detailValue(value, mono = false) {
  const text = dash(value);
  return el('dd', { className: mono ? 'mono' : '', text });
}

function tokenDetailFields(node) {
  const usage = node.tokenUsage;
  const fields = [[t('fieldTokens'), formatTokens(tokenTotal(node))]];
  if (!usage) return fields;
  fields.push(
    [t('fieldTokenScope'), tokenScopeLabel(usage.scope)],
    [t('fieldTokenSource'), usage.source],
    [t('fieldTokenCoverage'), tokenCoverageLabel(usage)],
  );
  const counters = [
    [t('fieldTokenInput'), usage.input],
    [t('fieldTokenOutput'), usage.output],
    [t('fieldTokenCacheRead'), usage.cacheRead],
    [t('fieldTokenCacheWrite'), usage.cacheWrite],
    [t('fieldTokenReasoning'), usage.reasoning],
  ];
  for (const [label, value] of counters) {
    if (value != null) fields.push([label, formatTokens(value)]);
  }
  return fields;
}

function routeDetailFields(node) {
  const route = node.route;
  return [
    [t('fieldExecutor'), executorLabel(node.executorKind)],
    [t('fieldRouteMode'), route?.mode || t('dash')],
    [t('fieldRouteResource'), route?.resourceId, true],
    [t('fieldRoutePreference'), route?.preference],
    [t('fieldRouteReasons'), route?.reasons?.length ? route.reasons.join(' · ') : t('dash')],
  ];
}

function performanceDetailFields(node) {
  const timing = node.performance;
  return [
    [t('fieldPhase'), timing ? phaseLabel(timing.phase) : t('dash')],
    [t('fieldPhaseDurations'), phaseDurationsLabel(timing)],
    [t('fieldBlocked'), timing?.blockedMs == null ? t('dash') : formatDuration(timing.blockedMs)],
    [t('fieldBlocker'), timing?.blockerCategory],
    [t('fieldLastProgress'), formatTime(timing?.lastProgressAt)],
    [t('fieldLastObserved'), formatTime(timing?.lastObservedAt)],
    [t('fieldLegacyPrehistory'), timing?.legacyPrehistory ? t('yes') : timing ? t('no') : t('dash')],
  ];
}

function nativeChildrenDetailFields(node) {
  const children = node.nativeChildren;
  return [
    [t('fieldNativeChildren'), children ? `${childStateLabel(children.state)} · ${children.complete ? t('tokenComplete') : t('tokenPartial')}` : t('dash')],
    [t('fieldNativeChildrenSource'), children?.source],
    [t('fieldNativeChildrenCount'), children?.count == null ? t('dash') : String(children.count)],
  ];
}

function renderDetail(snapshot) {
  const pane = document.getElementById('detail');
  const body = document.getElementById('detail-body');
  const node = snapshot?.nodes.find(item => item.id === state.selectedId);
  if (!node) {
    pane.hidden = true;
    document.getElementById('layout').classList.remove('is-open');
    body.replaceChildren();
    return;
  }
  pane.hidden = false;
  document.getElementById('layout').classList.add('is-open');
  const fields = [
    [t('fieldLabel'), node.label],
    [t('fieldId'), node.id, true],
    [t('fieldParent'), node.parentId, true],
    [t('fieldAgent'), node.agent],
    [t('fieldKind'), kindLabel(node.kind)],
    [t('fieldRole'), node.role],
    [t('fieldModel'), node.model],
    [t('fieldProject'), projectLabel(snapshot, node.projectId)],
    [t('fieldRun'), node.runId, true],
    [t('fieldTask'), node.taskId, true],
    [t('fieldAttempt'), node.attemptId, true],
    [t('fieldNative'), node.nativeSessionId, true],
    [t('fieldStatus'), statusLabel(node.status)],
    [t('fieldStatusLabel'), node.statusLabel],
    [t('fieldDelivery'), deliveryLabel(node.delivery)],
    [t('fieldStarted'), formatTime(node.startedAt)],
    [t('fieldUpdated'), formatTime(node.updatedAt)],
    [t('fieldFinished'), formatTime(node.finishedAt)],
    [t('fieldObserved'), formatTime(node.observedAt)],
    [t('fieldStale'), node.stale ? t('yes') : t('no')],
    [t('fieldSource'), node.source],
    [t('fieldConfidence'), node.confidence],
    [t('fieldRelation'), node.relation],
    ...routeDetailFields(node),
    ...performanceDetailFields(node),
    ...nativeChildrenDetailFields(node),
    ...tokenDetailFields(node),
  ];
  const list = el('dl', { className: 'detail-list' });
  for (const [label, value, mono] of fields) {
    list.append(el('dt', { text: label }), detailValue(value, mono));
  }
  body.replaceChildren(list, el('p', { className: 'hint', text: t('hint') }));
}

function restoreView(scrollTop, restore) {
  const wrap = document.getElementById('table-wrap');
  wrap.scrollTop = scrollTop;
  if (!restore) return;
  const next = document.querySelector(`[data-restore="${CSS.escape(restore)}"]`);
  if (next) next.focus();
}

function isCompact() {
  return Boolean(state.compactQuery?.matches);
}

function syncSidebar() {
  const compact = isCompact();
  const body = document.getElementById('sidebar-body');
  const toggle = document.getElementById('filters-toggle');
  const open = !compact || state.filtersOpen;
  body.hidden = !open;
  toggle.hidden = !compact;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', t(compact && state.filtersOpen ? 'hideFilters' : 'showFilters'));
}

function render() {
  const wrap = document.getElementById('table-wrap');
  const scrollTop = wrap.scrollTop;
  const restore = document.activeElement?.dataset?.restore;
  const snapshot = state.snapshot;
  conversationView?.setSnapshot(snapshot);
  conversationView?.setLanguage(state.lang);
  document.getElementById('filter-project').disabled = conversationView?.getFilter().view === 'conversation';
  applyI18n();
  setConnection(state.connection);
  renderScope(snapshot);
  renderObserved(snapshot);
  fillProjects(snapshot);
  renderCounts(snapshot);
  renderSources(snapshot);
  renderBanner(snapshot);
  syncSidebar();
  let rows = [];
  let hits = new Set();
  let pageCount = 1;
  let totalTops = 0;
  if (snapshot) {
    const forest = buildForest(snapshot.nodes);
    if (!state.didExpand) {
      for (const root of forest.roots) state.expanded.add(root.id);
      if (forest.unlinked.length) state.expanded.add(UNLINKED);
      for (const node of forest.unlinked) state.expanded.add(node.id);
      state.didExpand = true;
    }
    const view = visibleRows(forest, filtersFromDom());
    rows = view.rows;
    hits = view.hits;
    pageCount = view.pageCount;
    totalTops = view.totalTops;
  }
  renderEmpty(snapshot, rows.length, hits.size);
  if (snapshot && rows.length && hits.size) renderTable(rows, snapshot);
  renderPager(pageCount, totalTops);
  renderDetail(snapshot);
  restoreView(scrollTop, restore);
}

function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = window.setTimeout(() => poll(), ms);
}

async function fetchSnapshot(token) {
  const response = await fetch('/api/snapshot', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    const error = new Error('unauthorized');
    error.code = 'unauthorized';
    throw error;
  }
  if (!response.ok) {
    const error = new Error('unavailable');
    error.code = 'unavailable';
    throw error;
  }
  return response.json();
}

function rememberSnapshot(snapshot) {
  state.snapshot = snapshot;
  state.stale = false;
  state.backoff = POLL_MS;
  if (state.selectedId && !snapshot.nodes.some(node => node.id === state.selectedId)) {
    state.selectedId = null;
  }
}

function failPoll(code) {
  state.stale = Boolean(state.snapshot);
  state.connection = code === 'unauthorized' ? 'unauthorized' : state.snapshot ? 'stale' : 'disconnected';
  state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF_MS);
}

async function poll() {
  if (state.inFlight) return;
  if (!state.token) {
    state.connection = 'missing';
    render();
    return;
  }
  state.inFlight = true;
  try {
    const raw = await fetchSnapshot(state.token);
    const snapshot = normalizeSnapshot(raw);
    if (!snapshot) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    rememberSnapshot(snapshot);
    state.connection = 'connected';
    render();
    schedule(POLL_MS);
  } catch (error) {
    failPoll(error.code);
    render();
    schedule(state.backoff);
  } finally {
    state.inFlight = false;
  }
}

function onFilterChange() {
  state.page = 0;
  if (state.snapshot) {
    const forest = buildForest(state.snapshot.nodes);
    const { hits } = keepSet(forest, filtersFromDom());
    expandHitAncestors(forest, hits);
  }
  render();
}

function bindEvents() {
  conversationView = createConversationView({ container: document.getElementById('conversation-view'), onChange: onFilterChange, storage: sessionStorage });
  document.getElementById('refresh').addEventListener('click', () => {
    state.backoff = POLL_MS;
    poll();
  });
  document.getElementById('lang-en').addEventListener('click', () => {
    state.lang = 'en';
    sessionStorage.setItem(LANG_KEY, 'en');
    render();
  });
  document.getElementById('lang-zh').addEventListener('click', () => {
    state.lang = 'zh';
    sessionStorage.setItem(LANG_KEY, 'zh');
    render();
  });
  document.getElementById('filter-search').addEventListener('input', onFilterChange);
  document.getElementById('filter-project').addEventListener('change', onFilterChange);
  document.getElementById('filter-status').addEventListener('change', onFilterChange);
  document.getElementById('filter-agent').addEventListener('change', onFilterChange);
  document.getElementById('filters-toggle').addEventListener('click', () => {
    state.filtersOpen = !state.filtersOpen;
    syncSidebar();
  });
  state.compactQuery = window.matchMedia('(max-width: 768px)');
  state.compactQuery.addEventListener('change', () => {
    if (!state.compactQuery.matches) state.filtersOpen = false;
    syncSidebar();
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    const id = state.selectedId;
    state.selectedId = null;
    render();
    document.querySelector(`[data-restore="${CSS.escape(`select:${id}`)}"]`)?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state.selectedId) return;
    state.selectedId = null;
    render();
  });
  window.addEventListener('hashchange', () => {
    state.token = captureTokenFromLocation(location, history, sessionStorage);
    state.backoff = POLL_MS;
    poll();
  });
}

export function startMonitor() {
  const storedLang = sessionStorage.getItem(LANG_KEY);
  if (storedLang === 'zh' || storedLang === 'en') state.lang = storedLang;
  else if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) state.lang = 'zh';
  state.token = captureTokenFromLocation(location, history, sessionStorage);
  bindEvents();
  render();
  poll();
}

if (typeof window !== 'undefined' && window.document?.getElementById('app')) startMonitor();
