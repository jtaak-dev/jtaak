import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { openStream } from './streamExecutor';
import { executeGrpcUnaryCall } from './grpc';
import { reflectGrpcServer } from './grpcReflection';
import { summarizeGrpcSchema } from './grpcProto';
import type {
  GrpcProtocolConfig,
  GrpcStreamHandle,
  GrpcStreamMessage,
  GrpcStreamStatus,
  RequestConfig,
  StreamEvent,
} from '../types';

// A chat service with every kind of method, served by grpc-js with the
// official reflection service, so reflection is tested against what real
// servers run. Its messages use a well-known type from another file.
const CHAT_PROTO = `
syntax = "proto3";
package chat;
import "google/protobuf/timestamp.proto";

service Chat {
  rpc Hello (Note) returns (Note);
  rpc Countdown (Count) returns (stream Note);
  rpc Collect (stream Note) returns (Summary);
  rpc Echo (stream Note) returns (stream Note);
}
message Note { string text = 1; google.protobuf.Timestamp at = 2; }
message Count { int32 from = 1; }
message Summary { int32 notes = 1; string joined = 2; }
`;

let server: grpc.Server;
let url: string;
let echoHeader: string | undefined;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-grpc-'));
  const file = path.join(dir, 'chat.proto');
  fs.writeFileSync(file, CHAT_PROTO);
  const definition = protoLoader.loadSync(file, { keepCase: true });
  const chat = (grpc.loadPackageDefinition(definition).chat as grpc.GrpcObject).Chat as grpc.ServiceClientConstructor;
  server = new grpc.Server();
  server.addService(chat.service, {
    Hello: (call: grpc.ServerUnaryCall<{ text: string }, unknown>, callback: grpc.sendUnaryData<unknown>) =>
      callback(null, { text: `hello ${call.request.text}` }),
    Countdown: (call: grpc.ServerWritableStream<{ from: number }, unknown>) => {
      if (call.request.from < 0) {
        call.emit('error', { code: grpc.status.INVALID_ARGUMENT, details: 'from must be 0 or more' });
        return;
      }
      for (let n = call.request.from; n > 0; n--) call.write({ text: String(n) });
      call.end();
    },
    Collect: (call: grpc.ServerReadableStream<{ text: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const texts: string[] = [];
      call.on('data', (note: { text: string }) => texts.push(note.text));
      call.on('end', () => callback(null, { notes: texts.length, joined: texts.join('+') }));
    },
    Echo: (call: grpc.ServerDuplexStream<{ text: string }, unknown>) => {
      echoHeader = call.metadata.get('x-user')[0]?.toString();
      call.sendMetadata(new grpc.Metadata());
      call.on('data', (note: { text: string }) => call.write({ text: note.text.toUpperCase() }));
      call.on('end', () => call.end());
    },
  });
  new ReflectionService(definition).addToServer(server);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  url = `127.0.0.1:${port}`;
});
afterAll(() => server.forceShutdown());

function config(methodName: string, grpcConfig: Partial<GrpcProtocolConfig> = {}): RequestConfig {
  return {
    id: 'g',
    name: 'g',
    protocol: 'grpc',
    method: 'POST',
    url,
    params: [],
    headers: [{ key: 'x-user', value: 'ann', enabled: true }],
    body: { mode: 'none' },
    auth: { type: 'none' },
    protocolConfig: {
      protoFile: CHAT_PROTO.replace(
        'import "google/protobuf/timestamp.proto";',
        'import "google/protobuf/timestamp.proto";',
      ),
      serviceFullName: 'chat.Chat',
      methodName,
      requestMessage: {},
      ...grpcConfig,
    },
  };
}

/** Opens a stream and collects its events until it closes. */
function open(request: RequestConfig) {
  const events: StreamEvent[] = [];
  let closed: (status: GrpcStreamStatus) => void;
  const done = new Promise<GrpcStreamStatus>((resolve) => (closed = resolve));
  const handle = openStream(request, (event) => {
    events.push(event);
    if (event.type === 'close') closed(event.data as GrpcStreamStatus);
  }) as GrpcStreamHandle;
  const messages = (direction: GrpcStreamMessage['direction']) =>
    events
      .filter((e) => e.type === 'message' && (e.data as GrpcStreamMessage).direction === direction)
      .map((e) => (e.data as GrpcStreamMessage).message);
  return { handle, events, done, messages };
}

// The pasted .proto can't import other files, so these tests call through reflection's schema.
let reflected: Record<string, unknown>;

describe('server reflection', () => {
  it("lists a server's services and describes their messages, imports included", async () => {
    const result = await reflectGrpcServer({ url, headers: [], auth: { type: 'none' } });
    expect(result.services).toEqual(['chat.Chat']);
    reflected = result.schema;
    const summary = summarizeGrpcSchema({ protoFile: '', source: 'reflection', reflectedSchema: reflected });
    const chat = summary.services.find((s) => s.fullName === 'chat.Chat')!;
    expect(chat.methods.map((m) => [m.name, m.requestStream, m.responseStream])).toEqual([
      ['Hello', false, false],
      ['Countdown', false, true],
      ['Collect', true, false],
      ['Echo', true, true],
    ]);
    expect(summary.messages.find((m) => m.name === 'chat.Note')?.fields).toEqual([
      { name: 'text', type: 'string', repeated: false },
      { name: 'at', type: 'google.protobuf.Timestamp', repeated: false },
    ]);
  });

  it('calls a unary method from the reflected schema', async () => {
    const result = await executeGrpcUnaryCall(
      config('Hello', {
        protoFile: '',
        source: 'reflection',
        reflectedSchema: reflected,
        requestMessage: { text: 'ann' },
      }),
    );
    expect(result.message).toMatchObject({ text: 'hello ann' });
  });

  it("says so when a server doesn't offer reflection", async () => {
    const bare = new grpc.Server();
    const port = await new Promise<number>((resolve) =>
      bare.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (_e, p) => resolve(p)),
    );
    try {
      await expect(
        reflectGrpcServer({ url: `127.0.0.1:${port}`, headers: [], auth: { type: 'none' } }),
      ).rejects.toThrow("doesn't offer gRPC server reflection");
    } finally {
      bare.forceShutdown();
    }
  });
});

describe('gRPC streams', () => {
  const reflection = () => ({ protoFile: '', source: 'reflection' as const, reflectedSchema: reflected });

  it('server streaming: sends the request, then each reply, then the status', async () => {
    const { done, messages, events } = open(config('Countdown', { ...reflection(), requestMessage: { from: 3 } }));
    // Nothing comes before openStream returns, so a host that subscribes then misses nothing.
    expect(events).toEqual([]);
    const status = await done;
    expect(status.status.code).toBe(grpc.status.OK);
    expect(messages('sent')).toEqual([{ from: 3 }]);
    expect(messages('received').map((m) => m.text)).toEqual(['3', '2', '1']);
    expect(events[0]).toMatchObject({ type: 'open', data: { method: '/chat.Chat/Countdown', kind: 'server' } });
  });

  it('reports the status a server fails a stream with', async () => {
    const { done } = open(config('Countdown', { ...reflection(), requestMessage: { from: -1 } }));
    expect((await done).status).toEqual({ code: grpc.status.INVALID_ARGUMENT, details: 'from must be 0 or more' });
  });

  it('client streaming: sends each message, then the one reply after end', async () => {
    const { handle, done, messages } = open(config('Collect', reflection()));
    handle.send({ text: 'a' });
    handle.send('{"text":"b"}');
    handle.end();
    expect((await done).status.code).toBe(grpc.status.OK);
    expect(messages('sent')).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect(messages('received')).toEqual([{ notes: 2, joined: 'a+b' }]);
  });

  it('bidirectional: replies as it goes, with the metadata sent', async () => {
    const { handle, done, messages } = open(config('Echo', reflection()));
    handle.send({ text: 'hi' });
    handle.send({ text: 'there' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages('received').map((m) => m.text)).toEqual(['HI', 'THERE']);
    handle.end();
    expect((await done).status.code).toBe(grpc.status.OK);
    expect(echoHeader).toBe('ann');
  });

  it('refuses a message that is not JSON or not the request type, and anything after end', async () => {
    const { handle, done, events } = open(config('Echo', reflection()));
    handle.send('{oops');
    handle.send({ text: 42 });
    handle.end();
    handle.send({ text: 'late' });
    await done;
    expect(events.filter((e) => e.type === 'error').map((e) => e.data)).toEqual([
      'The message isn’t valid JSON.',
      expect.stringContaining('Invalid request message for chat.Note'),
      'Sending is finished: this call was ended.',
    ]);
  });

  it('cancels a stream on close', async () => {
    const { handle, done } = open(config('Echo', reflection()));
    handle.close();
    expect((await done).status.code).toBe(grpc.status.CANCELLED);
  });

  it('turns a unary method away, and a streaming one from executeGrpcUnaryCall', async () => {
    expect(() => open(config('Hello', reflection()))).toThrow('is a unary method');
    await expect(executeGrpcUnaryCall(config('Echo', reflection()))).rejects.toThrow('is a streaming method');
  });
});
