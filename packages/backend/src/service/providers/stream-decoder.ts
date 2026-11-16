export interface SseEvent {
  event: string | null;
  data: string;
  id?: string;
}

export async function* decodeSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | null = null;
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const consumeLine = (line: string): SseEvent | null => {
    if (line === '') {
      if (dataLines.length === 0) {
        eventName = null;
        eventId = undefined;
        return null;
      }

      const event: SseEvent = {
        event: eventName,
        data: dataLines.join('\n')
      };
      if (eventId !== undefined) event.id = eventId;

      eventName = null;
      eventId = undefined;
      dataLines = [];
      return event;
    }

    if (line.startsWith(':')) return null;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      eventName = value;
    } else if (field === 'id') {
      eventId = value;
    }

    return null;
  };

  const consumeBufferLines = (flush: boolean): SseEvent[] => {
    const frames: SseEvent[] = [];
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const frame = consumeLine(line);
      if (frame !== null) frames.push(frame);
      newlineIndex = buffer.indexOf('\n');
    }

    if (flush && buffer.length > 0) {
      let line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      const frame = consumeLine(line);
      if (frame !== null) frames.push(frame);
    }

    return frames;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      for (const frame of consumeBufferLines(false)) {
        yield frame;
      }
    }

    buffer += decoder.decode();
    for (const frame of consumeBufferLines(true)) {
      yield frame;
    }

    if (dataLines.length > 0) {
      const event: SseEvent = {
        event: eventName,
        data: dataLines.join('\n')
      };
      if (eventId !== undefined) event.id = eventId;
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* decodeSseData(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  for await (const event of decodeSseEvents(stream)) {
    yield event.data;
  }
}
