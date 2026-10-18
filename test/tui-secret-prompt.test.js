const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * 遮罩输入组件的按键语义。
 *
 * 为什么这些必须进仓库：这一层错了不会报错，只会「看起来没反应」或者
 * 悄悄把错误的内容交给服务端——例如回车被当成密码的一部分，用户按了正确的
 * 密码却被拒绝，而界面没有任何提示。
 */

const THEME = { fg: (_color, text) => text, bold: (text) => text };

async function makePrompt() {
  const { SecretPrompt } = await loadTs('tui/secretPrompt.ts');
  let finished = false;
  let value;
  const prompt = new SecretPrompt({
    title: 'OctSSH 需要密码',
    subtitle: 'user@host:22',
    theme: THEME,
    done: (result) => { finished = true; value = result; },
  });
  return {
    prompt,
    get finished() { return finished; },
    get value() { return value; },
    feed(...chunks) { for (const chunk of chunks) prompt.handleInput(chunk); },
    render(width = 60) { return prompt.render(width).join('\n'); },
  };
}

test('逐字符输入：单字符与退格按预期累积', async () => {
  const p = await makePrompt();
  p.feed('a', 'b', 'c');
  assert.equal(p.finished, false);
  p.feed('\u007f'); // backspace
  p.feed('d');
  p.feed('\r');
  assert.equal(p.value, 'abd');
});

test('多字符 chunk 全部接收；含 CR/LF 时以回车之前的文本提交，且不把回车并入密码', async () => {
  const single = await makePrompt();
  single.feed('secret');
  single.feed('\r');
  assert.equal(single.value, 'secret');

  // 终端把「文本 + 回车」合成一个 chunk：回车必须当提交，不能进 value
  for (const chunk of ['secret\r', 'secret\n']) {
    const p = await makePrompt();
    p.feed(chunk);
    assert.equal(p.finished, true, `${JSON.stringify(chunk)} 应当直接提交`);
    assert.equal(p.value, 'secret', `${JSON.stringify(chunk)} 提交的内容不得含回车`);
  }
});

test('提交后忽略后续输入（已结束的交互不再改变结果）', async () => {
  const p = await makePrompt();
  p.feed('pw', '\r');
  p.feed('x', '\u001b', '\r');
  assert.equal(p.value, 'pw');
});

test('Enter 的多种编码都能提交（含 CSI-u）', async () => {
  for (const enter of ['\r', '\n', '\u001b[13u', '\u001b[13;1u']) {
    const p = await makePrompt();
    p.feed('pw');
    p.feed(enter);
    assert.equal(p.value, 'pw', `${JSON.stringify(enter)} 应当提交`);
  }
});

test('Escape 的多种编码与 Ctrl+C 都能取消（不能「没反应」）', async () => {
  // 单字节 \x1b 只是其中一种；kitty/CSI-u 终端会发 \x1b[27u 之类，
  // 只认字节会让 Esc 静默失效。
  for (const escape of ['\u001b', '\u001b[27u', '\u001b[27;1;27~', '\u0003']) {
    const p = await makePrompt();
    p.feed('partial');
    p.feed(escape);
    assert.equal(p.finished, true, `${JSON.stringify(escape)} 应当结束交互`);
    assert.equal(p.value, undefined, `${JSON.stringify(escape)} 应当取消（undefined）`);
  }
});

test('cancelled 的组件在渲染里也不回显已输入的明文', async () => {
  const p = await makePrompt();
  p.feed('top-secret');
  const rendered = p.render();
  assert.equal(rendered.includes('top-secret'), false);
  assert.ok(rendered.includes('•'), '应当显示掩码');
  p.feed('\u001b');
  assert.equal(p.value, undefined);
  assert.equal(p.render().includes('top-secret'), false, '取消后不得残留明文');
});

test('bracketed paste：内容进入缓冲但不提交，且渲染只有掩码', async () => {
  const p = await makePrompt();
  p.feed('\u001b[200~pasted-secret\u001b[201~');
  assert.equal(p.finished, false, '粘贴不应当自动提交');
  const rendered = p.render();
  assert.equal(rendered.includes('pasted-secret'), false, '明文不得出现在渲染输出里');
  assert.equal((rendered.match(/•/g) || []).length, 13);
  p.feed('\r');
  assert.equal(p.value, 'pasted-secret');
});

test('跨 chunk 的粘贴（终端拆包）能正确拼接', async () => {
  const p = await makePrompt();
  p.feed('\u001b[200~secret-');
  p.feed('tail\u001b[201~');
  p.feed('\r');
  assert.equal(p.value, 'secret-tail');
});
