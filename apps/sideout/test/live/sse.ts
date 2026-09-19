/**
 * A reader for a Server-Sent Events body in a test: frames as the parser in a browser
 * would see them, comments included, with a timeout so a stream that goes quiet fails
 * the test instead of hanging it.
 */
export type SseFrame = { id?: string; event?: string; data?: string; retry?: number; comments: string[] };

export function parseFrame(block: string): SseFrame {
  const frame: SseFrame = { comments: [] };
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      frame.comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'retry') frame.retry = Number(value);
  }
  if (dataLines.length > 0) frame.data = dataLines.join('\n');
  return frame;
}

export class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly queue: SseFrame[] = [];
  private ended = false;

  constructor(private readonly response: Response) {}

  /** The body is locked only once a frame is asked for, so an error response can still be read as JSON. */
  private body(): ReadableStreamDefaultReader<Uint8Array> {
    if (this.reader === null) {
      if (this.response.body === null) throw new Error('the response has no body');
      this.reader = this.response.body.getReader();
    }
    return this.reader;
  }

  /** The next frame, or `null` once the stream has ended. */
  async next(timeoutMs = 5_000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (this.ended) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no SSE frame within ${timeoutMs}ms (buffer: ${JSON.stringify(this.buffer)})`);
      const result = await Promise.race([this.body().read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no SSE frame within ${timeoutMs}ms`)), remaining))]);
      if (result.done) {
        this.ended = true;
        if (this.buffer.trim() !== '') this.queue.push(parseFrame(this.buffer));
        this.buffer = '';
        continue;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      let split = this.buffer.indexOf('\n\n');
      while (split !== -1) {
        this.queue.push(parseFrame(this.buffer.slice(0, split)));
        this.buffer = this.buffer.slice(split + 2);
        split = this.buffer.indexOf('\n\n');
      }
    }
    return this.queue.shift() ?? null;
  }

  /** The next frame carrying data or a named event (comments and retry hints skipped). */
  async nextEvent(timeoutMs = 5_000): Promise<SseFrame | null> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) return null;
      if (frame.data !== undefined || frame.event !== undefined) return frame;
    }
  }

  /** Whether the stream ends within the timeout. */
  async ends(timeoutMs = 5_000): Promise<boolean> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) return true;
    }
  }

  async cancel(): Promise<void> {
    await this.body().cancel();
  }
}

export function eventData(frame: SseFrame | null): { tournamentId: string; kind: string; matchId: string | null; seq: number; at: string } {
  const data = frame?.data;
  if (data === undefined) throw new Error(`expected an event frame, got ${JSON.stringify(frame)}`);
  return JSON.parse(data) as { tournamentId: string; kind: string; matchId: string | null; seq: number; at: string };
}
