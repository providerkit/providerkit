import type { APIRoute } from "astro";
import { KINDS } from "../lib/kinds";

/*
  The taxonomy as data. It is the most-queried fact about the package — an agent
  mid-incident wants the thirteen kinds and their flags without parsing prose —
  and the flags come from the package itself, so this cannot drift from `core`.
*/
export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify(
      {
        package: "@providerkit/core",
        docs: "https://providerkit.dev/guides/errors/",
        note: "A kind names the remedy, not the vendor or the HTTP status. `family` groups kinds that share a remedy.",
        kinds: KINDS,
      },
      null,
      2,
    )}\n`,
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
