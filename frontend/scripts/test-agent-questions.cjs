const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const context = { exports: {}, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, ...globals };
  vm.runInNewContext(output, context, { filename: relative });
  return context.exports;
}

async function main() {
  const q = load('lib/agentQuestions.ts');
  let changes = 0;
  const unsubscribe = q.subscribeAgentQuestions(() => changes++);
  const sample = { id: 'question-1', novelId: 'book-a', question: '从谁的视角写？', options: ['方逸', '白灵'], multiSelect: false, source: 'writing' };
  const answers = [];
  const submit = async answer => answers.push(answer);
  q.registerAgentQuestion('run-a', sample, submit);
  q.registerAgentQuestion('run-b', { ...sample, novelId: 'book-b' }, submit);
  assert.equal(q.agentQuestionsSnapshot().length, 2, 'same question ids from different requests stay separate');
  q.minimizeAgentQuestion(q.agentQuestionsSnapshot()[0].key);
  q.saveAgentQuestionDraft(q.agentQuestionsSnapshot()[0].key, { selected: [1], note: '保留补充' });
  assert.equal(answers.length, 0, 'closing never supplies an answer');
  q.registerAgentQuestion('run-a', sample, submit);
  assert.equal(q.agentQuestionsSnapshot()[0].minimized, true, 'polling does not reopen a minimized question');
  q.reopenAgentQuestion('run-a', sample.id);
  assert.equal(q.agentQuestionsSnapshot()[0].minimized, false);
  assert.equal(q.readAgentQuestionDraft(q.agentQuestionsSnapshot()[0].key).note, '保留补充', 'closing or switching queued questions preserves unsubmitted input');
  assert.equal(q.questionAnswer(sample.options, [], ''), '', 'nothing selected by default');
  assert.equal(q.questionAnswer(sample.options, [1, 0], '  交替视角  '), '方逸\n白灵\n交替视角', 'multiple choices retain displayed order');
  assert.equal(q.questionAnswer(sample.options, [], '采用第三个人物'), '采用第三个人物', 'custom replies can replace all options');
  q.completeAgentQuestion('run-a', sample.id);
  q.registerAgentQuestion('run-a', sample, submit);
  assert.equal(q.agentQuestionsSnapshot().length, 1, 'stale waiting polls cannot resubmit an answered question');
  q.clearAgentQuestionOwner('run-a');
  assert.equal(q.agentQuestionsSnapshot()[0].novelId, 'book-b', 'clearing one request preserves other books');
  q.clearAgentQuestionOwner('run-b');
  assert.equal(q.agentQuestionsSnapshot().length, 0);
  assert.equal(q.parseAgentQuestion({ id: 'x', question: '问题', novel_id: 'book-b' }, 'book-a'), null, 'cross-book events are rejected');
  assert.equal(q.parseAgentQuestion({ question: '问题' }, 'book-a'), null);
  const parsed = q.parseAgentQuestion({ id: 'x', question: '问题', options: ['甲', '甲', null, '乙', ''], multi_select: true }, 'book-a');
  assert.deepEqual(Array.from(parsed.options), ['甲', '乙']);
  assert.equal(parsed.multiSelect, true);
  assert.ok(changes > 0);
  unsubscribe();

  const requests = [];
  let streamController;
  let answerFailure = true;
  const stream = new ReadableStream({ start(controller) { streamController = controller; } });
  const fetchMock = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/stream')) return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.includes('/questions/')) {
      if (answerFailure) { answerFailure = false; return new Response(JSON.stringify({ detail: '请重试' }), { status: 503 }); }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const api = load('lib/api.ts', { '@/lib/agentQuestions': q, '@/lib/resourceChanges': { notifyResourceChange() {} } },
    { fetch: fetchMock, process: { env: {} }, Response, Headers, AbortController, TextDecoder, DOMException, setTimeout, clearTimeout });
  const events = [];
  const running = api.apiPostSSE('/api/novels/book-a/writing-agent/rewrite/stream', {}, (name, data) => events.push([name, data]), { idleTimeoutMs: 1500 });
  const emit = (event, data) => streamController.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  emit('author_question', { id: 'ask-1', novel_id: 'book-a', question: '选视角', options: ['方逸', '白灵'], multi_select: false });
  await flush();
  assert.equal(q.agentQuestionsSnapshot().length, 1, 'SSE opens a question without per-page event setup');
  emit('progress', { message: '等待作者回复…' });
  await flush();
  assert.equal(events.at(-1)[0], 'progress', 'waiting for the user does not block stream heartbeats');
  const pending = q.agentQuestionsSnapshot()[0];
  await assert.rejects(pending.submit('白灵'), /请重试/);
  assert.equal(q.agentQuestionsSnapshot().length, 1, 'a failed answer remains available to retry');
  await pending.submit('白灵');
  const post = requests.at(-1);
  assert.ok(post.url.endsWith('/api/novels/book-a/writing-agent/questions/ask-1/answer'));
  assert.equal(JSON.parse(post.options.body).answer, '白灵');
  emit('author_answered', { id: 'ask-1' });
  await flush();
  assert.equal(q.agentQuestionsSnapshot().length, 0);
  emit('author_question', { id: 'ask-2', novel_id: 'book-a', question: '再确认', options: [] });
  await flush();
  assert.equal(q.agentQuestionsSnapshot().length, 1);
  q.registerAgentQuestion('other-book-run', { ...sample, novelId: 'book-b', id: 'other' }, submit);
  emit('done', { text: '最终稿' });
  streamController.close();
  await running;
  assert.equal(q.agentQuestionsSnapshot().length, 1, 'terminal events preserve questions from other requests');
  assert.equal(q.agentQuestionsSnapshot()[0].novelId, 'book-b');
  q.clearAgentQuestionOwner('other-book-run');
  await assert.rejects(pending.submit('迟到的回复'), error => error.code === 'AUTHOR_QUESTION_EXPIRED', 'an expired callback cannot answer a later run');
  assert.equal(events.filter(([name]) => name === 'done').length, 1);
  assert.ok(!events.some(([name]) => name === 'author_question'), 'question payloads never reach draft editors');

  let failedController;
  const failedStream = new ReadableStream({ start(controller) { failedController = controller; } });
  const failedApi = load('lib/api.ts', { '@/lib/agentQuestions': q, '@/lib/resourceChanges': { notifyResourceChange() {} } },
    { fetch: async () => new Response(failedStream, { headers: { 'Content-Type': 'text/event-stream' } }), process: { env: {} }, Response, Headers, AbortController, TextDecoder, DOMException, setTimeout, clearTimeout });
  const failedRun = failedApi.apiPostSSE('/api/novels/book-a/continuation/stream', {}, () => {});
  failedController.enqueue(new TextEncoder().encode('event: author_question\ndata: {"id":"last","question":"请选择"}\n\n'));
  await flush();
  assert.equal(q.agentQuestionsSnapshot().length, 1);
  failedController.error(new Error('disconnected'));
  await assert.rejects(failedRun, /SSE/);
  assert.equal(q.agentQuestionsSnapshot().length, 0, 'disconnects cannot leave an answerable stale dialog');
  console.log('Agent question queue, explicit replies, cross-book isolation, retries, SSE heartbeat consumption and lifecycle cleanup: passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
