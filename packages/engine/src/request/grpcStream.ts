import * as grpc from '@grpc/grpc-js';
import { metadataToRecord, prepareGrpcCall } from './grpc.js';
import type { GrpcStreamHandle, GrpcStreamStatus, RequestConfig, StreamEvent } from '../types.js';

/**
 * A streaming gRPC call, through openStream: server streaming (the request
 * goes when it opens, then each reply arrives as a `message`), client
 * streaming (`send` each message, `end` when done, then the one reply), or
 * bidirectional (both at once). Messages sent and received are `message`
 * events (`GrpcStreamMessage`); the call's end is a `close` event with its
 * status, headers and trailers (`GrpcStreamStatus`). `close()` cancels.
 */
export function openGrpcStream(config: RequestConfig, onEvent: (event: StreamEvent) => void): GrpcStreamHandle {
  const { protocolConfig, method, kind, methodPath, invalid, serialize, deserialize, client, metadata } =
    prepareGrpcCall(config);
  const emit = (type: StreamEvent['type'], data?: unknown) => onEvent({ type, data, timestamp: Date.now() });

  if (kind === 'unary') {
    client.close();
    throw new Error(`"${method.name}" is a unary method: call it with executeGrpcUnaryCall.`);
  }
  if (kind === 'server') {
    const error = invalid(protocolConfig.requestMessage);
    if (error) {
      client.close();
      throw new Error(error);
    }
  }

  let headers: Record<string, string> = {};
  let finished = false;
  const finish = (status: GrpcStreamStatus['status'], trailers: grpc.Metadata | undefined) => {
    if (finished) return;
    finished = true;
    client.close();
    emit('close', { status, headers, metadata: trailers ? metadataToRecord(trailers) : {} } satisfies GrpcStreamStatus);
  };

  type Message = Record<string, unknown>;
  let call:
    grpc.ClientReadableStream<Message> | grpc.ClientWritableStream<Message> | grpc.ClientDuplexStream<Message, Message>;
  if (kind === 'server') {
    call = client.makeServerStreamRequest(methodPath, serialize, deserialize, protocolConfig.requestMessage, metadata);
  } else if (kind === 'client') {
    // The one reply comes to the callback; the status still comes as an event.
    call = client.makeClientStreamRequest(methodPath, serialize, deserialize, metadata, (error, value) => {
      if (!error && value) emit('message', { direction: 'received', message: value });
    });
  } else {
    call = client.makeBidiStreamRequest(methodPath, serialize, deserialize, metadata);
  }

  call.on('metadata', (received: grpc.Metadata) => {
    headers = metadataToRecord(received);
  });
  call.on('data', (message: Record<string, unknown>) => emit('message', { direction: 'received', message }));
  call.on('status', (status: grpc.StatusObject) =>
    finish({ code: status.code, details: status.details }, status.metadata),
  );
  // An error also ends in a status event; this keeps an unhandled 'error' from throwing.
  call.on('error', () => {});
  // After openStream returns, as for the other protocols (whose open comes
  // off the network): a host subscribes to a stream's events once it has its
  // handle, so events emitted before then would be lost.
  setImmediate(() => {
    if (finished) return;
    emit('open', { method: methodPath, kind });
    if (kind === 'server') emit('message', { direction: 'sent', message: protocolConfig.requestMessage });
  });

  const writable = kind === 'server' ? undefined : (call as grpc.ClientWritableStream<Message>);
  let ended = false;
  return {
    send(data: unknown) {
      if (!writable) {
        emit('error', 'A server-streaming call sends its one request when it opens.');
        return;
      }
      if (finished || ended) {
        emit('error', ended ? 'Sending is finished: this call was ended.' : 'This call has finished.');
        return;
      }
      let message: unknown = data;
      if (typeof data === 'string') {
        try {
          message = JSON.parse(data);
        } catch {
          emit('error', 'The message isn’t valid JSON.');
          return;
        }
      }
      const error = invalid(message);
      if (error) {
        emit('error', error);
        return;
      }
      writable.write(message as Message);
      emit('message', { direction: 'sent', message });
    },
    end() {
      if (!writable || ended || finished) return;
      ended = true;
      writable.end();
    },
    close() {
      if (finished) return;
      call.cancel();
    },
  };
}
