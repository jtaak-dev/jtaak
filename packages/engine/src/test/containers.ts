import net from 'node:net';
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  type WaitStrategy,
} from 'testcontainers';

/**
 * Brokers with no in-process server (Kafka, RabbitMQ, NATS, and MQTT 5 on
 * Mosquitto) run in containers through Testcontainers, with Docker or
 * Podman. Without a container runtime their tests are skipped, saying so,
 * unless JTAAK_REQUIRE_CONTAINERS is set (CI sets it), when the missing
 * runtime fails the run instead of hiding the tests.
 */
let available: Promise<boolean> | undefined;

export function containerRuntimeAvailable(): Promise<boolean> {
  available ??= getContainerRuntimeClient().then(
    () => true,
    (error: unknown) => {
      if (process.env.JTAAK_REQUIRE_CONTAINERS) {
        throw new Error(`JTAAK_REQUIRE_CONTAINERS is set, but no container runtime is available: ${String(error)}`);
      }
      console.warn('No container runtime (Docker or Podman): skipping the container tests.');
      return false;
    },
  );
  return available;
}

/** Enough for a first pull of a broker image. */
export const CONTAINER_START_TIMEOUT = 240_000;

export interface Broker {
  container: StartedTestContainer;
  /** Always an IPv4 address: Podman forwards ports on IPv4 only, and "localhost" may resolve to ::1. */
  host: string;
  port(containerPort: number): number;
  stop(): Promise<void>;
}

/** Waits until host:port accepts a TCP connection: the container can be
 * ready before the runtime's port forwarding is (Podman on Windows). */
async function waitForPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    if (Date.now() > deadline) throw new Error(`Nothing is listening on ${host}:${port}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function startBroker(
  image: string,
  options: {
    ports: (number | { container: number; host: number })[];
    wait: WaitStrategy;
    env?: Record<string, string>;
    command?: string[];
    /** Files written into the container before it starts (certificates, config). */
    files?: { content: string; target: string }[];
  },
): Promise<Broker> {
  let builder = new GenericContainer(image).withExposedPorts(...options.ports).withWaitStrategy(options.wait);
  if (options.env) builder = builder.withEnvironment(options.env);
  if (options.command) builder = builder.withCommand(options.command);
  if (options.files) builder = builder.withCopyContentToContainer(options.files);
  const container = await builder.start();
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  for (const port of options.ports) {
    await waitForPort(host, container.getMappedPort(typeof port === 'number' ? port : port.container));
  }
  return {
    container,
    host,
    port: (containerPort) => container.getMappedPort(containerPort),
    stop: async () => {
      await container.stop();
    },
  };
}
