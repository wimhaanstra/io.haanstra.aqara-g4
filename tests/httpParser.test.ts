import { HttpMessage, HttpParser } from '../lib/hap/httpParser';

function collect(): { parser: HttpParser; messages: HttpMessage[] } {
    const messages: HttpMessage[] = [];
    return { parser: new HttpParser((m) => messages.push(m)), messages };
}

describe('HttpParser', () => {
    it('parses content-length bodies split across chunks', () => {
        const { parser, messages } = collect();
        const raw = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: 13\r\n\r\n{"hello":"x"}');
        parser.feed(raw.subarray(0, 20));
        parser.feed(raw.subarray(20, 70));
        expect(messages).toHaveLength(0);
        parser.feed(raw.subarray(70));
        expect(messages).toHaveLength(1);
        expect(messages[0].kind).toBe('response');
        expect(JSON.parse(messages[0].body.toString())).toEqual({ hello: 'x' });
    });

    it('parses chunked bodies and events in one buffer', () => {
        const { parser, messages } = collect();
        parser.feed(
            Buffer.from(
                'EVENT/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}' +
                    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n' +
                    'HTTP/1.1 204 No Content\r\n\r\n',
            ),
        );
        expect(messages.map((m) => [m.kind, m.status])).toEqual([
            ['event', 200],
            ['response', 200],
            ['response', 204],
        ]);
        expect(messages[1].body.toString()).toBe('hello world');
    });
});
