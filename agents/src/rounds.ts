/** One model reply, decoded by the host. Tool permissions belong in run(), not in
 * canRunConcurrently: permission to overlap is not permission to execute. */
export type ToolRound<Answer, Result> =
  | { answer: Answer }
  | {
      calls: readonly { run(): Promise<Result>; canRunConcurrently?(): boolean }[];
      record(results: readonly Result[]): void | Promise<void>;
    };

/** Drive a bounded, in-process model/tool conversation when the host already owns the
 * provider interface, streaming decoder and transcript. Pulling drives execution: returning
 * the iterator while the model is speaking closes its stream without starting any tools.
 * No journal, retry, clock or background producer. Use defineAgent for resumable runs. */
export async function* runToolRounds<Delta, Answer, Result>(
  maxToolRounds: number,
  model: (index: number, offerTools: boolean) => AsyncGenerator<Delta, ToolRound<Answer, Result>>,
): AsyncGenerator<Delta, Answer> {
  if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 0)
    throw new RangeError("maxToolRounds must be a whole number of zero or more.");
  for (let index = 0; ; index++) {
    const offerTools = index < maxToolRounds;
    const turn = yield* model(index, offerTools);
    if ("answer" in turn) return turn.answer;
    if (!offerTools || turn.calls.length === 0)
      throw new TypeError("Return an answer when no tools are offered or called.");

    const results: Result[] = [];
    for (let start = 0; start < turn.calls.length;) {
      let end = start + 1;
      if (turn.calls[start]!.canRunConcurrently?.()) {
        while (end < turn.calls.length && turn.calls[end]!.canRunConcurrently?.()) end++;
      }
      // An unsafe call is a barrier. Wait even for an admitted sibling of a failed call;
      // otherwise cleanup of the host's turn could race that sibling's effects.
      const batch = await Promise.allSettled(
        turn.calls.slice(start, end).map(async (call) => call.run()),
      );
      for (const item of batch) {
        if (item.status === "rejected") throw item.reason;
        results.push(item.value);
      }
      start = end;
    }
    await turn.record(results);
  }
}
