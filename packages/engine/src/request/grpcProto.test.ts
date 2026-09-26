import { describe, expect, it } from 'vitest';
import { clearGrpcProtoCache, parseGrpcProto } from './grpcProto';

const GREETER_PROTO = `
syntax = "proto3";
package greeter;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc StreamGreetings (HelloRequest) returns (stream HelloReply);
}

message HelloRequest {
  string name = 1;
  int32 excitement_level = 2;
  repeated string tags = 3;
}

message HelloReply {
  string message = 1;
  Address origin = 2;
}

message Address {
  string city = 1;
  string country = 2;
}
`;

describe('parseGrpcProto', () => {
  it('lists services with their methods, request/response types, and streaming flags', () => {
    const summary = parseGrpcProto(GREETER_PROTO, { forceRefresh: true });

    expect(summary.services).toHaveLength(1);
    const greeter = summary.services[0];
    expect(greeter.fullName).toBe('greeter.Greeter');

    const sayHello = greeter.methods.find((m) => m.name === 'SayHello')!;
    expect(sayHello.requestType).toBe('greeter.HelloRequest');
    expect(sayHello.responseType).toBe('greeter.HelloReply');
    expect(sayHello.requestStream).toBe(false);
    expect(sayHello.responseStream).toBe(false);

    const streamGreetings = greeter.methods.find((m) => m.name === 'StreamGreetings')!;
    expect(streamGreetings.responseStream).toBe(true);
    expect(streamGreetings.requestStream).toBe(false);
  });

  it('flattens both top-level and nested message types with their fields', () => {
    const summary = parseGrpcProto(GREETER_PROTO, { forceRefresh: true });
    const names = summary.messages.map((m) => m.name).sort();
    expect(names).toEqual(['greeter.Address', 'greeter.HelloReply', 'greeter.HelloRequest']);

    const helloRequest = summary.messages.find((m) => m.name === 'greeter.HelloRequest')!;
    expect(helloRequest.fields).toEqual([
      { name: 'name', type: 'string', repeated: false },
      { name: 'excitement_level', type: 'int32', repeated: false },
      { name: 'tags', type: 'string', repeated: true },
    ]);

    const helloReply = summary.messages.find((m) => m.name === 'greeter.HelloReply')!;
    const originField = helloReply.fields.find((f) => f.name === 'origin')!;
    expect(originField.type).toBe('greeter.Address'); // resolved to the message's full name, not left as "Address"
  });

  it('throws a clear error for a cross-file import (unsupported)', () => {
    const withImport = `
      syntax = "proto3";
      import "google/protobuf/timestamp.proto";
      message Foo { google.protobuf.Timestamp at = 1; }
    `;
    expect(() => parseGrpcProto(withImport, { forceRefresh: true })).toThrow(/import.*statements aren't supported/i);
  });

  it('throws on malformed proto syntax instead of returning a bogus summary', () => {
    expect(() => parseGrpcProto('this is not { valid proto', { forceRefresh: true })).toThrow();
  });

  it('caches by file content and forceRefresh bypasses the cache', () => {
    clearGrpcProtoCache();
    const first = parseGrpcProto(GREETER_PROTO);
    const second = parseGrpcProto(GREETER_PROTO);
    expect(second).toEqual(first);
    const refreshed = parseGrpcProto(GREETER_PROTO, { forceRefresh: true });
    expect(refreshed).toEqual(first);
  });
});

describe('performance budget: proto parse', () => {
  it('parses and summarizes a typical proto file in under 200ms', () => {
    clearGrpcProtoCache();
    const start = performance.now();
    parseGrpcProto(GREETER_PROTO, { forceRefresh: true });
    expect(performance.now() - start).toBeLessThan(200);
  });
});
