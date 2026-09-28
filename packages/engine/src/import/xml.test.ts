import { describe, expect, it } from 'vitest';
import { parseXml, resolveQName, XmlError } from './xml';

describe('parseXml', () => {
  it('resolves namespaces, attributes, text and entities', () => {
    const root = parseXml(`<?xml version="1.0"?>
<!DOCTYPE note [<!ENTITY x "y">]>
<!-- a comment -->
<a:root xmlns:a="urn:a" xmlns="urn:default" id="1" title='It&apos;s &lt;here&gt;'>
  <child>text &amp; more<![CDATA[ <raw> ]]>&#65;&#x42;</child>
  <a:empty/>
  <other xmlns="urn:other"><inner/></other>
</a:root>`);
    expect(root).toMatchObject({
      name: 'a:root',
      local: 'root',
      ns: 'urn:a',
      attrs: { id: '1', title: "It's <here>" },
    });
    const [child, empty, other] = root.children;
    expect(child).toMatchObject({ local: 'child', ns: 'urn:default', text: 'text & more <raw> AB' });
    expect(empty).toMatchObject({ local: 'empty', ns: 'urn:a', children: [] });
    expect(other.children[0].ns).toBe('urn:other');
    expect(resolveQName(child, 'a:Thing')).toEqual({ ns: 'urn:a', local: 'Thing' });
    expect(resolveQName(child, 'Thing')).toEqual({ ns: 'urn:default', local: 'Thing' });
  });

  it('rejects malformed documents, saying where', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a><b></a>')).toThrow(/Unexpected <\/a> \(line 1\)/);
    expect(() => parseXml('<a>\n<b>')).toThrow(/<b> is never closed/);
    expect(() => parseXml('<a/><b/>')).toThrow(/More than one root element/);
    expect(() => parseXml('just text')).toThrow(/Text outside the root element/);
    expect(() => parseXml('')).toThrow(/No root element/);
  });
});
