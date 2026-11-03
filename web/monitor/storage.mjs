import { captureTokenFromLocation, STORAGE_TOKEN_KEY } from './app.mjs';

const copy = {
  en: {
    title: 'Storage', back: 'Agent Monitor', refresh: 'Refresh', language: 'Language',
    skip: 'Skip to inventory', usage: 'HarnessOrbit state storage', total: 'Observed size',
    eligible: 'Reclaimable', protected: 'Protected', trend: 'Recorded daily usage (UTC)', items: 'Storage inventory',
    readOnly: 'Read-only access. Open a storage management link to preview and run cleanup.',
    manage: 'Preview an eligible item to see what cleanup will remove.',
    emptyHistory: 'No daily measurements yet.', emptyItems: 'No storage items were found.',
    preview: 'Preview cleanup', confirmTitle: 'Review cleanup', cancel: 'Cancel', execute: 'Confirm cleanup',
    detail: (label, size) => `Remove ${label}? The preview estimates ${size} can be reclaimed. This removal is permanent.`,
    released: size => `Cleanup completed. Released ${size}.`,
    loading: 'Reading storage usage…', planning: 'Preparing preview…', cleaning: 'Running cleanup…',
    auth: 'Access denied. Reopen the authorized monitor link.',
    stale: 'This preview is no longer valid. Refresh the inventory and preview again.',
    unavailable: 'Storage data is unavailable. Refresh to try again.',
    actionFailed: 'Could not verify the cleanup request. Refresh the inventory before trying again.',
    'closed-run-export': 'Command export from a closed run',
    'run-records': 'Run records and evidence', 'work-products': 'Work products', archives: 'Archives',
    'monitor-data': 'Monitor data', unrecognized: 'Unrecognized content', 'state-root': 'State directory',
  },
  zh: {
    title: '存储', back: '智能体监控', refresh: '刷新', language: '语言', skip: '跳至存储明细',
    usage: 'HarnessOrbit 状态目录用量', total: '已统计用量', eligible: '可回收', protected: '受保护', trend: '每日用量记录（UTC）', items: '存储明细',
    readOnly: '当前为只读模式。请打开存储管理链接，以预览并执行清理。',
    manage: '可先预览可回收项目，确认清理范围。', emptyHistory: '暂无每日用量记录。', emptyItems: '没有找到存储项目。',
    preview: '预览清理', confirmTitle: '核对清理范围', cancel: '取消', execute: '确认清理',
    detail: (label, size) => `确定删除 ${label}？预计可回收 ${size}。删除后无法撤销。`,
    released: size => `清理已完成，释放了 ${size}。`, loading: '正在读取存储用量…', planning: '正在准备预览…', cleaning: '正在清理…',
    auth: '访问被拒绝，请重新打开已授权的监控链接。', stale: '预览已失效，请刷新明细并重新预览。',
    unavailable: '暂时无法读取存储数据，请刷新重试。', actionFailed: '无法确认清理请求的结果，请先刷新明细。',
    'closed-run-export': '已关闭运行的命令导出文件', 'run-records': '运行记录与证据', 'work-products': '工作成果',
    archives: '归档', 'monitor-data': '监控数据', unrecognized: '未识别内容', 'state-root': '状态目录',
  },
};

const byId = id => document.getElementById(id);
const languageKey = 'cao.monitor.lang';
const readToken = captureTokenFromLocation(location, history, sessionStorage);
const manageToken = sessionStorage.getItem(STORAGE_TOKEN_KEY);
let lang = sessionStorage.getItem(languageKey) || (navigator.language.startsWith('zh') ? 'zh' : 'en');
let audit = null;
let plan = null;
let busy = false;
let message = 'loading';
let released = null;

function t(key) {
  return copy[lang]?.[key] ?? copy.en[key] ?? key;
}

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${scaled.toLocaleString(lang, { maximumFractionDigits: 1 })} ${units[index]}`;
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function updateControls() {
  byId('refresh').disabled = busy;
  for (const button of byId('items').querySelectorAll('button')) button.disabled = busy;
  const status = [released == null ? '' : t('released')(bytes(released)), message ? t(message) : ''];
  byId('status').textContent = status.filter(Boolean).join(' ');
}

function render() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = `${t('title')} · HarnessOrbit`;
  for (const node of document.querySelectorAll('[data-copy]')) node.textContent = t(node.dataset.copy);
  for (const id of ['en', 'zh']) byId(id).setAttribute('aria-pressed', String(id === lang));
  byId('report').hidden = !audit;
  if (audit) {
    byId('access').textContent = t(manageToken ? 'manage' : 'readOnly');
    byId('total').textContent = bytes(audit.totalBytes);
    byId('eligible').textContent = bytes(audit.reclaimableBytes);
    byId('protected').textContent = bytes(audit.protectedBytes);
    const days = [...audit.history].sort((a, b) => b.day.localeCompare(a.day));
    const max = Math.max(1, ...days.map(point => point.bytes));
    byId('history').replaceChildren(...days.map(point => {
      const row = element('div', null, 'history-row');
      const meter = element('meter');
      meter.max = max;
      meter.value = point.bytes;
      meter.setAttribute('aria-hidden', 'true');
      row.append(element('time', point.day), meter, element('span', bytes(point.bytes), 'size'));
      return row;
    }));
    if (!days.length) byId('history').textContent = t('emptyHistory');
    byId('items').replaceChildren(...audit.items.map(item => {
      const row = element('li', null, 'item');
      const status = t(item.reclaimable ? 'eligible' : 'protected');
      row.append(element('strong', item.label), element('span', bytes(item.bytes), 'size'),
        element('span', [status, t(item.reason)].filter(Boolean).join(' · '), 'reason'));
      if (item.reclaimable && manageToken) {
        const button = element('button', t('preview'));
        button.setAttribute('aria-label', `${t('preview')} · ${item.label}`);
        button.addEventListener('click', () => preview(item.id, button));
        row.append(button);
      }
      return row;
    }));
    if (!audit.items.length) byId('items').append(element('li', t('emptyItems')));
  }
  updateControls();
}

async function request(path, payload) {
  const token = payload ? manageToken : readToken;
  if (!token) throw new Error('auth');
  const headers = { Authorization: `Bearer ${token}` };
  const options = { headers, cache: 'no-store', redirect: 'error' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(`/api/storage${path}`, options);
  if ([401, 403].includes(response.status)) throw new Error('auth');
  if (payload && [404, 409, 410].includes(response.status)) throw new Error('stale');
  if (!response.ok) throw new Error();
  return response.json();
}

function fail(error, fallback) {
  message = ['auth', 'stale'].includes(error.message) ? error.message : fallback;
}

async function refresh() {
  busy = true;
  message = 'loading';
  updateControls();
  try {
    audit = await request('');
    message = '';
  } catch (error) {
    audit = null;
    fail(error, 'unavailable');
  } finally {
    busy = false;
    render();
  }
}

async function preview(id, button) {
  if (busy) return;
  busy = true;
  released = null;
  message = 'planning';
  updateControls();
  try {
    plan = await request('/plan', { id });
    byId('plan-detail').textContent = t('detail')(plan.label, bytes(plan.bytes));
    message = '';
    // Let the native dialog restore focus to the initiating button on cancel.
    busy = false;
    updateControls();
    button.focus();
    byId('preview').showModal();
  } catch (error) {
    plan = null;
    fail(error, 'actionFailed');
  } finally {
    busy = false;
    updateControls();
  }
}

byId('cancel').onclick = () => byId('preview').close();
byId('preview').addEventListener('close', () => { plan = null; });
byId('execute').onclick = async () => {
  if (!plan || busy) return;
  const planId = plan.id;
  byId('preview').close();
  busy = true;
  message = 'cleaning';
  updateControls();
  try {
    const result = await request('/execute', { planId });
    released = result.releasedBytes;
    await refresh();
  } catch (error) {
    fail(error, 'actionFailed');
  } finally {
    busy = false;
    updateControls();
    byId('refresh').focus();
  }
};
for (const id of ['en', 'zh']) {
  byId(id).onclick = () => {
    lang = id;
    sessionStorage.setItem(languageKey, lang);
    render();
  };
}
byId('refresh').onclick = () => { released = null; refresh(); };
render();
refresh();
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('token') || params.has('storageToken')) location.reload();
});
