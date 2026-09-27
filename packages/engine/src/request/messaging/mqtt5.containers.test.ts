import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wait } from 'testcontainers';
import { CONTAINER_START_TIMEOUT, containerRuntimeAvailable, startBroker, type Broker } from '../../test/containers';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, StreamEvent } from '../../types';

function connect(url: string) {
  const events: StreamEvent[] = [];
  const handle = openStream(
    {
      id: 'mqtt5',
      name: 'mqtt5',
      protocol: 'mqtt',
      method: 'GET',
      url,
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
      protocolConfig: { protocolVersion: 5 },
    },
    (event) => events.push(event),
  ) as MessagingStreamHandle;
  const received = () =>
    events
      .filter((e) => e.type === 'message' && (e.data as MessagingMessage).direction === 'received')
      .map((e) => e.data as MessagingMessage);
  const opened = () => expect.poll(() => events.map((e) => e.type), { timeout: 10_000 }).toContain('open');
  return { handle, events, received, opened };
}

// aedes has no MQTT 5, so MQTT 5's user properties are tested on Mosquitto.
describe.skipIf(!(await containerRuntimeAvailable()))('MQTT 5 (Mosquitto)', () => {
  let mosquitto: Broker;

  beforeAll(async () => {
    mosquitto = await startBroker('docker.io/library/eclipse-mosquitto:2', {
      ports: [1883],
      // The image's config for anonymous access on port 1883.
      command: ['mosquitto', '-c', '/mosquitto-no-auth.conf'],
      wait: Wait.forLogMessage(/mosquitto version .* running/),
    });
  }, CONTAINER_START_TIMEOUT);

  afterAll(async () => {
    await mosquitto?.stop();
  });

  it('sends and receives headers as user properties', async () => {
    const { handle, events, received, opened } = connect(`mqtt://${mosquitto.host}:${mosquitto.port(1883)}`);
    await opened();
    expect(events[0].data).toMatchObject({ protocolVersion: 5 });
    await handle.subscribe({ channel: 'v5/test', options: { qos: 1 } });
    await handle.publish({
      channel: 'v5/test',
      payload: 'with properties',
      headers: [
        { key: 'trace', value: 'abc', enabled: true },
        { key: 'origin', value: 'jtaak', enabled: true },
      ],
      options: { qos: 1 },
    });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({ payload: 'with properties', headers: { trace: 'abc', origin: 'jtaak' } });
    handle.close();
  });
});
