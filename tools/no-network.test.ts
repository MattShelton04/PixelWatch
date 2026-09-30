import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { isLoopback, NetworkDisabledError } from "./lib/no-network.ts";

describe("network guard (pnpm check has no network)", () => {
  it("rejects fetch", async () => {
    await expect(fetch("https://example.com/")).rejects.toBeInstanceOf(NetworkDisabledError);
  });

  it("rejects external sockets and DNS", () => {
    expect(() => net.connect({ host: "example.com", port: 443 })).toThrow(NetworkDisabledError);
    expect(() => net.connect(443, "93.184.215.14")).toThrow(NetworkDisabledError);
    expect(() => net.createConnection({ host: "93.184.215.14", port: 80 })).toThrow(
      NetworkDisabledError,
    );
    expect(() => tls.connect({ host: "93.184.215.14", port: 443 })).toThrow(NetworkDisabledError);
    expect(() => {
      dns.lookup("example.com", () => undefined);
    }).toThrow(NetworkDisabledError);
  });

  it("allows loopback, so local fakes (07 §4) still work", async () => {
    const server = net.createServer((socket) => socket.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        resolve(data);
      });
      socket.on("error", reject);
    });
    await new Promise((resolve) => server.close(resolve));
    expect(reply).toBe("ok");
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("127.8.0.1")).toBe(true);
    expect(isLoopback("128.0.0.1")).toBe(false);
  });
});
