import { useEffect, useRef, useState } from "react";
import type { DraftScope } from "@providerkit/react";
import type { DisplayMessage, ToolPart } from "@providerkit/react/protocol";
import { ToolCall } from "@providerkit/react/ui";
import { earlierMessages, historyPageSize, pasteText } from "./samples.ts";
import { apiPath } from "./shared.ts";
import { command, demoFetch } from "./transport.ts";

export function EarlierHistory({
  scope,
  messages,
  connected,
}: {
  scope: DraftScope;
  messages: readonly DisplayMessage[];
  connected: boolean;
}) {
  const loaded = earlierMessages.filter((older) =>
    messages.some((message) => message.id === older.id),
  ).length;
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const [failNext, setFailNext] = useState(false);
  const busy = useRef(false);
  const empty = loaded === earlierMessages.length;
  const disabled = pending || empty || !connected;
  async function load() {
    if (busy.current || disabled) return;
    busy.current = true;
    setPending(true);
    setProblem("");
    setFailNext(false);
    try {
      await command(scope, "history", {
        page: String(loaded / historyPageSize + 1),
        mode: failNext ? "fail" : "normal",
      });
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Earlier messages could not load. Check the local server, then choose Retry earlier messages.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div
      className="history-controls"
      data-state={
        pending ? "loading" : problem ? "error" : empty ? "empty" : loaded ? "loaded" : "ready"
      }
    >
      <div className="actions">
        <button
          className="demo-button"
          type="button"
          aria-disabled={disabled}
          aria-busy={pending}
          onClick={() => void load()}
        >
          {pending
            ? "Loading earlier messages..."
            : problem
              ? "Retry earlier messages"
              : "Load earlier messages"}
        </button>
        <label className="remember">
          <input
            type="checkbox"
            checked={failNext}
            disabled={disabled}
            onChange={(event) => setFailNext(event.target.checked)}
          />
          Fail next history load
        </label>
      </div>
      <p role="status">
        {pending
          ? "Loading four older sample messages..."
          : problem ||
            (empty
              ? "All 8 older sample messages are loaded. No earlier messages."
              : !connected
                ? "Reconnect before loading earlier messages."
                : loaded
                  ? `${loaded} older sample messages loaded. Four more are available.`
                  : "Load four older sample messages without running a model.")}
      </p>
    </div>
  );
}

export function SampleTool({ tool }: { tool: ToolPart }) {
  const [selected, setSelected] = useState(false);
  return (
    <ToolCall
      tool={tool}
      label="Check the sample room"
      actions={
        <>
          <button
            className="demo-button"
            type="button"
            aria-pressed={selected}
            onClick={() => setSelected(!selected)}
          >
            {selected ? "Clear sample time" : "Select sample time"}
          </button>
          <p role="status">
            {selected
              ? "Sample time selected: 10:00. Nothing was booked."
              : "No sample time selected."}
          </p>
        </>
      }
    />
  );
}

/** The slot accepts only the host's fixed sample ID. It never reads a message-supplied image URL. */
export function SampleImage({ scope }: { scope: DraftScope }) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string>();
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [large, setLarge] = useState(false);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const response = await demoFetch(`${apiPath(scope)}/sample-image?mode=slow`, {
        signal: controller.signal,
      });
      if (!response.ok || response.headers.get("Content-Type") !== "image/png")
        throw new Error("image");
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    })().catch(() => {
      if (!controller.signal.aborted) setStatus("error");
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [scope, attempt]);
  useEffect(() => {
    if (!resizing) return;
    const timer = setTimeout(() => {
      setLarge((value) => !value);
      setResizing(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [resizing]);
  return (
    <figure className="sample-image" data-size={large ? "large" : "small"}>
      <figcaption>
        Generated sample image. The host approved this local drawing; it is not an uploaded file.
      </figcaption>
      <div className="actions">
        <button
          className="demo-button"
          type="button"
          aria-disabled={status === "loading" || resizing}
          aria-busy={status === "loading"}
          onClick={() => {
            if (status === "loading" || resizing) return;
            setSource(undefined);
            setStatus("loading");
            setAttempt(attempt + 1);
          }}
        >
          {status === "loading"
            ? "Loading sample image..."
            : status === "error"
              ? "Retry sample image"
              : status === "ready"
                ? "Reload image after 3 seconds"
                : "Load image after 3 seconds"}
        </button>
        <button
          className="demo-button"
          type="button"
          aria-disabled={status !== "ready" || resizing}
          aria-busy={resizing}
          onClick={() => {
            if (status === "ready" && !resizing) setResizing(true);
          }}
        >
          {resizing
            ? "Waiting to resize..."
            : large
              ? "Shrink after 3 seconds"
              : "Enlarge after 3 seconds"}
        </button>
      </div>
      <p role="status">
        {status === "error"
          ? "The generated image could not load. Check the local server, then choose Retry sample image."
          : status === "loading"
            ? "The image will load after 3 seconds. You can scroll within the conversation now."
            : resizing
              ? "The image will change size in 3 seconds. Keep reading to check your position."
              : status === "ready"
                ? `Generated image loaded at ${large ? "large" : "small"} size.`
                : "The image has not loaded yet."}
      </p>
      <div className="sample-image-frame">
        {source && status !== "error" && (
          <img
            src={source}
            width={720}
            height={480}
            alt="Generated drawing of a notebook and pencil"
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
        )}
      </div>
    </figure>
  );
}

/** This writes only fixed synthetic content. It never reads the person's existing clipboard. */
export async function copyPasteSample(scope: DraftScope): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error(
      "This browser cannot copy a text-and-image sample. Use Add a generated text file and type sample text instead.",
    );
  const image = demoFetch(`${apiPath(scope)}/sample-image`).then(async (response) => {
    if (!response.ok)
      throw new Error(
        "The generated clipboard image could not load. Check the local server and try again.",
      );
    return response.blob();
  });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([pasteText], { type: "text/plain" }),
        "image/png": image,
      }),
    ]);
  } catch {
    // A browser can reject the clipboard write before it consumes the image promise.
    await image.catch(() => undefined);
    throw new Error(
      "The sample could not be copied. Allow clipboard access and try again, or use Add a generated text file and type sample text.",
    );
  }
}
