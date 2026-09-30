import { describe, expect, it } from 'vitest';
import { isScriptNamespace, rewriteScriptNamespace } from './scriptNamespace';

const rewrite = (source: string) => rewriteScriptNamespace(source, 'acme', 'ot');
const unchanged = (source: string) => expect(rewrite(source)).toEqual({ source, count: 0 });

describe('rewriteScriptNamespace', () => {
  it('rewrites the namespace used as an object', () => {
    expect(rewrite('acme.test("ok", () => acme.expect(acme.response.status).toBe(200));')).toEqual({
      source: 'ot.test("ok", () => ot.expect(ot.response.status).toBe(200));',
      count: 3,
    });
    expect(rewrite('acme["environment"].set("a", 1)')).toEqual({ source: 'ot["environment"].set("a", 1)', count: 1 });
    expect(rewrite('acme?.response?.json()')).toEqual({ source: 'ot?.response?.json()', count: 1 });
    expect(rewrite('acme?.["x"]')).toEqual({ source: 'ot?.["x"]', count: 1 });
    expect(rewrite('acme .test()\nacme\n  .expect(1)\nacme\t[0]')).toEqual({
      source: 'ot .test()\not\n  .expect(1)\not\t[0]',
      count: 3,
    });
  });

  it('rewrites it after operators, keywords, brackets and spreads', () => {
    expect(rewrite('const r = acme.response; return acme.x; f(...acme.list, !acme.y, [acme.z], {k: acme.w})')).toEqual({
      source: 'const r = ot.response; return ot.x; f(...ot.list, !ot.y, [ot.z], {k: ot.w})',
      count: 6,
    });
    expect(rewrite('if(acme.a){acme.b}else{acme.c}')).toEqual({ source: 'if(ot.a){ot.b}else{ot.c}', count: 3 });
    expect(rewrite('typeof acme.x;await acme.sendRequest(r)')).toEqual({
      source: 'typeof ot.x;await ot.sendRequest(r)',
      count: 2,
    });
  });

  it('leaves string literals alone', () => {
    unchanged(`"acme.test()"; 'acme.test()'; "say \\"acme.x\\""; 'it\\'s acme.y'`);
    expect(rewrite(`'acme.a' + acme.b + "acme.c"`)).toEqual({ source: `'acme.a' + ot.b + "acme.c"`, count: 1 });
  });

  it('leaves template text alone but rewrites expressions inside ${…}, nested', () => {
    unchanged('`acme.test() and acme["x"]`');
    unchanged('`escaped \\${acme.x} and \\` acme.y`');
    expect(rewrite('`status ${acme.response.status} of acme.response`')).toEqual({
      source: '`status ${ot.response.status} of acme.response`',
      count: 1,
    });
    expect(rewrite('`a ${ `b ${acme.x} acme.y` } ${ {k: acme.z}.k } acme.w`; acme.v')).toEqual({
      source: '`a ${ `b ${ot.x} acme.y` } ${ {k: ot.z}.k } acme.w`; ot.v',
      count: 3,
    });
    expect(rewrite('`${"}"}`; acme.after')).toEqual({ source: '`${"}"}`; ot.after', count: 1 });
  });

  it('leaves comments alone', () => {
    unchanged('// acme.test()\n/* acme.x\n acme["y"] */');
    expect(rewrite('acme.a // acme.b\n/* acme.c */ acme.d')).toEqual({
      source: 'ot.a // acme.b\n/* acme.c */ ot.d',
      count: 2,
    });
    expect(rewrite('acme /* comment */ .x')).toEqual({ source: 'acme /* comment */ .x', count: 0 });
  });

  it('leaves regex literals alone', () => {
    unchanged('const re = /acme.test/g;');
    unchanged('x = [/acme[.]x/, /a\\/acme.y/]; return /acme.z/.test(s)');
    expect(rewrite('/[/]acme.x/.test(acme.y)')).toEqual({ source: '/[/]acme.x/.test(ot.y)', count: 1 });
    expect(rewrite('if (!/acme.x/i.test(s)) acme.fail()')).toEqual({
      source: 'if (!/acme.x/i.test(s)) ot.fail()',
      count: 1,
    });
  });

  it('treats / after a value as division', () => {
    expect(rewrite('const r = a / acme.x / 2;')).toEqual({ source: 'const r = a / ot.x / 2;', count: 1 });
    expect(rewrite('(a) / acme.x; b[0] / acme.y; 10 / acme.z; i++ / acme.w')).toEqual({
      source: '(a) / ot.x; b[0] / ot.y; 10 / ot.z; i++ / ot.w',
      count: 4,
    });
    expect(rewrite('x /= acme.y')).toEqual({ source: 'x /= ot.y', count: 1 });
    expect(rewrite('"a" / acme.x')).toEqual({ source: '"a" / ot.x', count: 1 });
  });

  it('leaves property accesses alone', () => {
    unchanged('x.acme.test(); x?.acme.y; x . acme [0]; this.#acme.z');
    expect(rewrite('acme.acme.acme')).toEqual({ source: 'ot.acme.acme', count: 1 });
    expect(rewrite('1..acme.x')).toEqual({ source: '1..acme.x', count: 0 });
  });

  it('leaves longer identifiers alone', () => {
    unchanged('acmeX.test(); _acme.x; $acme.y; acme$.z; acme_1[0]; xacme?.w');
  });

  it('leaves other uses of the name alone', () => {
    unchanged('const x = { acme: 1 }; f(acme); acme = 2; acme(); acme\n+1; acme?y:z; acme ? .5 : 1');
    unchanged('({ acme }); const { acme: a } = o;');
  });

  it('handles numbers next to the name', () => {
    expect(rewrite('1.5 + acme.x + 0x1e+acme.y + 1e+5 + .5')).toEqual({
      source: '1.5 + ot.x + 0x1e+ot.y + 1e+5 + .5',
      count: 2,
    });
  });

  it('copes with unterminated input', () => {
    expect(rewrite('acme.x; "unterminated')).toEqual({ source: 'ot.x; "unterminated', count: 1 });
    unchanged('/* acme.x');
    unchanged('`acme.x ${');
    expect(rewrite('a = / acme.x\nacme.y')).toEqual({ source: 'a = / ot.x\not.y', count: 2 });
  });

  it('returns the source as is when nothing changes or the names are equal', () => {
    unchanged('');
    expect(rewriteScriptNamespace('acme.x', 'acme', 'acme')).toEqual({ source: 'acme.x', count: 0 });
    expect(rewriteScriptNamespace('jt.test()', 'jt', 'acme')).toEqual({ source: 'acme.test()', count: 1 });
  });

  it('rejects names that are not identifiers', () => {
    expect(() => rewriteScriptNamespace('x', 'a-b', 'ok')).toThrow(/not a JavaScript identifier/);
    expect(() => rewriteScriptNamespace('x', 'ok', '1x')).toThrow(/not a JavaScript identifier/);
    expect(() => rewriteScriptNamespace('x', 'ok', 'return')).toThrow(/not a JavaScript identifier/);
  });

  it('rewrites a realistic test script', () => {
    const source = [
      '// Checks the acme.response body',
      'const body = acme.response.json(); // acme.x',
      "acme.test('status is 200', () => {",
      '  acme.expect(acme.response.code).to.equal(200);',
      '  acme.expect(body.name).to.match(/acme\\.[a-z]+/);',
      '  console.log(`got ${acme.response.headers["content-type"]} from acme`);',
      '});',
      "acme.environment.set('token', body.acme.token);",
    ].join('\n');
    const expected = [
      '// Checks the acme.response body',
      'const body = ot.response.json(); // acme.x',
      "ot.test('status is 200', () => {",
      '  ot.expect(ot.response.code).to.equal(200);',
      '  ot.expect(body.name).to.match(/acme\\.[a-z]+/);',
      '  console.log(`got ${ot.response.headers["content-type"]} from acme`);',
      '});',
      "ot.environment.set('token', body.acme.token);",
    ].join('\n');
    expect(rewrite(source)).toEqual({ source: expected, count: 7 });
  });
});

describe('isScriptNamespace', () => {
  it('accepts plain identifiers that are not reserved words', () => {
    for (const name of ['jt', 'acme', '_x', '$', 'café']) expect(isScriptNamespace(name)).toBe(true);
    for (const name of ['', '1a', 'a-b', 'a b', 'class', 'this']) expect(isScriptNamespace(name)).toBe(false);
  });
});
