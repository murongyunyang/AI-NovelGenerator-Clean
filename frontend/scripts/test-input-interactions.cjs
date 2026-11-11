const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class Element {
  constructor(parent = null) { this.parentElement = parent; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this.style = {overflowY: 'visible', lineHeight: '20px'}; this.isContentEditable = false; this.markers = new Set(); }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) {
      if (selector === '.cm-editor' && el.markers.has('cm-editor')) return el;
      if (selector === '.cm-scroller' && el.markers.has('cm-scroller')) return el;
      if (selector.startsWith('[role=') && el.markers.has('dialog')) return el;
    }
    return null;
  }
}
class Input extends Element {
  constructor(parent = null, type = 'text') { super(parent); this.type = type; this.value = 'Current field only'; this.disabled = false; this.selectionStart = 4; this.selectionEnd = 4; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
}
class Textarea extends Element {
  constructor(parent = null) { super(parent); this.value = 'Current field only'; this.disabled = false; this.selectionStart = 4; this.selectionEnd = 4; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
}
const selected = {ranges: ['outside'], removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); }};
const document = {activeElement: null, scrollingElement: null, createRange: () => ({selectNodeContents(field) { this.field = field; }})};
const context = {exports: {}, HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, document, window: {getSelection: () => selected}, getComputedStyle: element => element.style};
const source = fs.readFileSync(path.join(__dirname, '../src/lib/inputInteraction.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, context);
const {selectFieldContents, scrollPastField} = context.exports;
function event(target, patch = {}) {
  return {key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, cancelable: true, deltaX: 0, deltaY: 80, deltaMode: 0, prevented: false, stopped: false,
    composedPath: () => [target], preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}, ...patch};
}
function scrollable(parent = null) {const el = new Element(parent); el.style.overflowY = 'auto'; el.scrollHeight = 800; el.clientHeight = 200; return el;}

let count = 0;
function test(name, run) {run(); count++; console.log(`PASS ${name}`);}
test('Ctrl+A selects only the current textarea and clears the previous page selection', () => {
  const area = new Textarea(); selected.ranges = ['outside']; const e = event(area); selectFieldContents(e);
  assert.equal(area.selectionStart, 0); assert.equal(area.selectionEnd, area.value.length); assert.equal(selected.ranges.length, 0); assert.ok(e.prevented && e.stopped);
});
test('Cmd+A and repeated select-all remain local, including read-only/password fields', () => {
  const input = new Input(null, 'password'); input.readOnly = true;
  for (let n = 0; n < 2; n++) {const e = event(input, {ctrlKey: false, metaKey: true}); selectFieldContents(e); assert.ok(e.prevented); assert.equal(input.selectionEnd, input.value.length);}
});
test('contenteditable selects its editing root rather than neighbouring page text', () => {
  const root = new Element(); root.isContentEditable = true; const child = new Element(root); child.isContentEditable = true;
  selectFieldContents(event(child)); assert.equal(selected.ranges.length, 1); assert.equal(selected.ranges[0].field, root);
});
test('non-editors, composing input, and CodeMirror keep their own keyboard handling', () => {
  const code = new Element(); code.markers.add('cm-editor'); const editable = new Element(code); editable.isContentEditable = true;
  for (const e of [event(new Element()), event(new Input(), {isComposing: true}), event(editable)]) {selectFieldContents(e); assert.equal(e.prevented, false);}
});
test('scrolling inside a textarea does not move its page', () => {
  const page = scrollable(); const area = new Textarea(page); area.scrollHeight = 500; area.scrollTop = 100;
  const e = event(area, {ctrlKey: false}); scrollPastField(e); assert.equal(page.scrollTop, 0); assert.equal(e.prevented, false);
});
test('at the bottom the next wheel goes to the nearest scrollable panel', () => {
  const page = scrollable(); const panel = scrollable(page); const area = new Textarea(panel); area.scrollHeight = 500; area.scrollTop = 400;
  const e = event(area, {ctrlKey: false}); scrollPastField(e); assert.equal(panel.scrollTop, 80); assert.equal(page.scrollTop, 0); assert.equal(area.scrollTop, 400); assert.ok(e.prevented && e.stopped);
});
test('an exhausted nested panel hands scrolling to the outer page', () => {
  const page = scrollable(); const panel = scrollable(page); panel.scrollTop = 600; const area = new Textarea(panel);
  scrollPastField(event(area, {ctrlKey: false})); assert.equal(page.scrollTop, 80); assert.equal(panel.scrollTop, 600);
});
test('at the top upward wheels move the page up', () => {
  const page = scrollable(); page.scrollTop = 150; const area = new Textarea(page);
  scrollPastField(event(area, {ctrlKey: false, deltaY: -50})); assert.equal(page.scrollTop, 100);
});
test('portalled input overlay scrolls the original field panel', () => {
  const page = scrollable(); const original = new Input(page); const overlay = new Textarea();
  scrollPastField(event(overlay, {ctrlKey: false}), () => original); assert.equal(page.scrollTop, 80);
});
test('modal boundaries cannot scroll the background', () => {
  const page = scrollable(); const modal = new Element(page); modal.markers.add('dialog'); const area = new Textarea(modal);
  const e = event(area, {ctrlKey: false}); scrollPastField(e); assert.equal(page.scrollTop, 0); assert.ok(e.prevented && e.stopped);
});
test('line/page wheel units are converted, zoom and horizontal gestures are preserved', () => {
  const page = scrollable(); const area = new Textarea(page);
  scrollPastField(event(area, {ctrlKey: false, deltaMode: 1, deltaY: 2})); assert.equal(page.scrollTop, 40);
  scrollPastField(event(area, {ctrlKey: false, deltaMode: 2, deltaY: 1})); assert.equal(page.scrollTop, 240);
  for (const e of [event(area), event(area, {ctrlKey: false, deltaX: 100}), event(area, {ctrlKey: false, shiftKey: true})]) {scrollPastField(e); assert.equal(e.prevented, false); assert.equal(page.scrollTop, 240);}
});
test('CodeMirror wheel boundaries hand off without changing editor key handling', () => {
  const page = scrollable(); const scroller = new Element(page); scroller.markers.add('cm-scroller'); const line = new Element(scroller);
  scrollPastField(event(line, {ctrlKey: false})); assert.equal(page.scrollTop, 80);
});
console.log(`${count} input interaction regressions passed.`);
