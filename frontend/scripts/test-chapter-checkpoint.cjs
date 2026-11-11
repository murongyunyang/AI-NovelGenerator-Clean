// Runs the real component's handlers with an in-memory hook/API/storage adapter.
// Complements the browser regression test when Windows blocks Edge IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const outline = process.argv.includes('--outline');
const filename = path.resolve(__dirname, '../src/components/writing/' + (outline ? 'BookOutlineWorkspace' : 'ChapterEditorWorkspace') + '.tsx');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const initial = { id: 'chapter1', chapter_id: 'chapter1', novel_id: 'book1', title: 'Chapter', content: 'Original', version: 1 };
let saved = { ...initial };
const drafts = new Map();
let failWrite = false;
let active = true;
let slots = [], cursor = 0, effects = [], pending = false, tree, dirty = false;
const listeners = new Map();
const props = { novelId: 'book1', chapterId: 'chapter1', onNavigate() {}, onDirtyChange(value) { dirty = value; }, onBusyChange() {}, beforeLeaveRef: { current: null }, discardRef: { current: null } };
const state = (value) => {
  const i = cursor++;
  if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
  return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; pending = true; }];
};
const ref = (value) => {
  const i = cursor++;
  return slots[i] ?? (slots[i] = { current: value });
};
const react = {
  useState: state, useRef: ref, useContext: () => active,
  useEffect(fn, deps) {
    const i = cursor++, old = slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) {
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    }
  },
  useEffectEvent(fn) {
    const latest = ref(fn); latest.current = fn;
    const stable = ref(null);
    return stable.current ?? (stable.current = (...args) => latest.current(...args));
  },
};
const storage = {
  async readWritingDraft(key) { return drafts.get(key) ?? null; },
  async writeWritingDraft(key, version, value) {
    if (failWrite) throw new Error('Simulated storage failure');
    if (value === null) drafts.delete(key);
    else drafts.set(key, { base_version: version, value: structuredClone(value) });
  },
  async clearWritingDrafts(key) { drafts.delete(key); },
};
const api = {
  async apiGet(url) { return url.endsWith('/outline-chapters') ? { chapters: [{ ...saved }] } : url.includes('/novel/') ? { data: [{ ...saved }] } : { ...saved }; },
  async apiPost() { return { chapters: [{ ...saved }] }; },
  async apiPut(url, body) { assert.equal(body.expected_version, saved.version); saved = { ...saved, title: body.title, content: body.content, version: saved.version + 1 }; return { ...saved }; },
  ApiRequestError: class extends Error {},
};
const modules = {
  react, 'next-intl': { useLocale: () => 'zh' }, '@heroui/react': { Button: 'Button' },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
  '@/lib/api': api, '@/lib/writingDrafts': storage,
  '@/hooks/useResourceRefresh': { useResourceRefresh() {} },
  '@/components/shared/CollapsiblePanel': { useCollapsed: () => [false, () => {}] },
  '@/components/shared/BatchSelect': { useBatchRun: () => ({ running: false, progress: null }) },
  '@/components/shared/ConfirmDialog': { confirmDialog: async () => true },
  '@/lib/lastModified': { byAgent: () => false, stampText: () => '' },
};
const output = { exports: {} };
vm.runInNewContext(code, {
  exports: output.exports, module: output, require: (name) => modules[name] ?? {},
  document: { addEventListener() {}, removeEventListener() {} },
  window: { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
  console, setTimeout, clearTimeout, crypto: { randomUUID: () => 'test' },
}, { filename });
const Component = output.exports.default;
function render() { cursor = 0; pending = false; effects = []; tree = Component(props); for (const effect of effects) effect(); }
async function flush() { for (let i = 0; i < 12; i++) { await new Promise(setImmediate); if (pending) render(); } }
function find(testId, node = tree) {
  if (outline) testId = ({ 'chapter-body': 'book-outline', 'chapter-save': 'outline-save' })[testId] ?? testId;
  if (!node) return null;
  if (Array.isArray(node)) return node.map(n => n == null ? null : find(testId, n)).find(Boolean) ?? null;
  if (node.props?.['data-testid'] === testId) return node;
  return find(testId, node.props?.children ?? null);
}
async function edit(value) { find('chapter-body').props.onChange({ target: { value } }); await flush(); }
async function revisit() { active = false; render(); await flush(); active = true; render(); await flush(); }
async function main() {
  render(); await flush();
  assert.equal(dirty, false, 'Opening a saved chapter must not prompt');
  await edit('Kept draft'); assert.equal(dirty, true);
  await props.beforeLeaveRef.current(); await flush();
  await revisit(); assert.equal(dirty, false, 'Returning to a kept draft must not prompt');
  assert.equal(find('chapter-discard'), null, 'No new edits means no discard action');
  await props.discardRef.current(); await flush();
  assert.equal(find('chapter-body').props.value, 'Kept draft', 'Stale discard must be harmless');
  await edit('Second session'); assert.equal(dirty, true);
  await props.discardRef.current(); await flush();
  assert.equal(find('chapter-body').props.value, 'Kept draft');
  assert.equal(drafts.get(outline ? 'book1:outline-chapter:chapter1' : 'book1:chapter:chapter1:editor').value.content, 'Kept draft');
  assert.equal(dirty, false);
  assert.ok([...drafts.keys()].some(key => key.includes('discarded:')), 'Discarded text has a recovery copy');
  await edit('Temporary'); await edit('Kept draft'); assert.equal(dirty, false, 'Undoing edits to baseline must not prompt');
  // Re-mount from IndexedDB: the restored draft itself must not trigger a prompt.
  for (const slot of slots) slot?.cleanup?.();
  slots = []; render(); await flush();
  assert.equal(find('chapter-body').props.value, 'Kept draft'); assert.equal(dirty, false);
  find('chapter-save').props.onPress(); await flush();
  assert.equal(saved.content, 'Kept draft'); assert.equal(dirty, false);
  await revisit(); assert.equal(dirty, false); assert.equal(listeners.has('beforeunload'), false);
  await edit('Must survive failed persistence');
  failWrite = true;
  await assert.rejects(() => props.discardRef.current(), /Simulated storage failure/);
  assert.equal(find('chapter-body').props.value, 'Must survive failed persistence');
  failWrite = false;
  console.log('PASS: saved/kept/reopened drafts, stale discard, session rollback, reload, edit undo, explicit save and storage failure.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
