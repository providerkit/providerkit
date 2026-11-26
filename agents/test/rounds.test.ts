import { expect, it } from "vitest";
import { runToolRounds } from "../src/rounds.ts";

it("joins safe calls in model order, waits before a write and offers a tool-free final turn", async () => {
  const log: string[] = [];
  const rounds = runToolRounds<string, string, string>(1, async function* (i, tools) {
    yield `${i}:${tools}`;
    if (!tools) return { answer: "done" };
    const release = Promise.withResolvers<void>();
    return {
      calls: [
        {
          canRunConcurrently: () => true,
          async run() {
            await release.promise;
            log.push("a");
            return "a";
          },
        },
        {
          canRunConcurrently: () => true,
          async run() {
            log.push("b");
            release.resolve();
            return "b";
          },
        },
        {
          async run() {
            log.push("write");
            return "w";
          },
        },
      ],
      record(results) {
        log.push(results.join(""));
      },
    };
  });
  expect(await rounds.next()).toEqual({ done: false, value: "0:true" });
  expect(log).toEqual([]);
  expect(await rounds.next()).toEqual({ done: false, value: "1:false" });
  expect(log).toEqual(["b", "a", "write", "abw"]);
  expect(await rounds.next()).toEqual({ done: true, value: "done" });
});

it("closing a stream closes the model without dispatching a tool", async () => {
  let closed = false;
  const rounds = runToolRounds<string, string, never>(1, async function* () {
    try {
      yield "pre";
    } finally {
      closed = true;
    }
    throw new Error("the model should not resume");
  });
  await rounds.next();
  await rounds.return("stopped");
  expect(closed).toBe(true);
});

it("does not execute calls returned when tools were disabled", async () => {
  let ran = false;
  const rounds = runToolRounds(0, async function* () {
    yield "preamble";
    return {
      calls: [
        {
          async run() {
            ran = true;
          },
        },
      ],
      record() {},
    };
  });
  expect((await rounds.next()).value).toBe("preamble");
  await expect(rounds.next()).rejects.toThrow(/no tools/);
  expect(ran).toBe(false);
});
