/**
 * Minimal incremental HTTP/1.1 parser for HAP traffic.
 *
 * Handles normal responses (`HTTP/1.1 200 OK`) and HAP event notifications (`EVENT/1.0 200 OK`),
 * with bodies framed by Content-Length or chunked transfer encoding.
 */

export interface HttpMessage {
    kind: 'response' | 'event';
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

const HEADER_END = Buffer.from('\r\n\r\n');

export class HttpParser {
    private buffer: Buffer = Buffer.alloc(0);

    constructor(private readonly onMessage: (message: HttpMessage) => void) {}

    feed(data: Buffer): void {
        this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);

        for (;;) {
            const message = this.tryParse();
            if (!message) return;
            this.onMessage(message);
        }
    }

    reset(): void {
        this.buffer = Buffer.alloc(0);
    }

    private tryParse(): HttpMessage | undefined {
        const headerEnd = this.buffer.indexOf(HEADER_END);
        if (headerEnd < 0) return undefined;

        const head = this.buffer.subarray(0, headerEnd).toString('latin1');
        const [statusLine, ...headerLines] = head.split('\r\n');
        const statusMatch = /^(HTTP\/1\.[01]|EVENT\/1\.0)\s+(\d{3})/.exec(statusLine);
        if (!statusMatch) {
            throw new Error(`Unexpected HTTP status line: ${statusLine}`);
        }

        const headers: Record<string, string> = {};
        for (const line of headerLines) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }

        const bodyStart = headerEnd + HEADER_END.length;
        let body: Buffer;
        let consumed: number;

        if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
            const chunked = HttpParser.parseChunked(this.buffer, bodyStart);
            if (!chunked) return undefined;
            ({ body, consumed } = chunked);
        } else {
            const length = Number(headers['content-length'] ?? 0);
            if (this.buffer.length < bodyStart + length) return undefined;
            body = Buffer.from(this.buffer.subarray(bodyStart, bodyStart + length));
            consumed = bodyStart + length;
        }

        this.buffer = this.buffer.subarray(consumed);

        return {
            kind: statusMatch[1].startsWith('EVENT') ? 'event' : 'response',
            status: Number(statusMatch[2]),
            headers,
            body,
        };
    }

    private static parseChunked(buffer: Buffer, start: number): { body: Buffer; consumed: number } | undefined {
        const chunks: Buffer[] = [];
        let offset = start;

        for (;;) {
            const lineEnd = buffer.indexOf('\r\n', offset);
            if (lineEnd < 0) return undefined;
            const size = parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16);
            if (Number.isNaN(size)) throw new Error('Invalid chunk size');
            const dataStart = lineEnd + 2;

            if (size === 0) {
                // Skip optional trailers until the final empty line.
                const end = buffer.indexOf('\r\n', dataStart);
                if (end < 0) return undefined;
                if (end === dataStart) {
                    return { body: Buffer.concat(chunks), consumed: end + 2 };
                }
                const trailerEnd = buffer.indexOf(HEADER_END, dataStart);
                if (trailerEnd < 0) return undefined;
                return { body: Buffer.concat(chunks), consumed: trailerEnd + 4 };
            }

            if (buffer.length < dataStart + size + 2) return undefined;
            chunks.push(Buffer.from(buffer.subarray(dataStart, dataStart + size)));
            offset = dataStart + size + 2;
        }
    }
}

export function buildRequest(method: string, path: string, host: string, body?: Buffer, contentType?: string): Buffer {
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`];
    if (body) {
        if (contentType) lines.push(`Content-Type: ${contentType}`);
        lines.push(`Content-Length: ${body.length}`);
    }
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    return body ? Buffer.concat([head, body]) : head;
}
