import { getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";

/**
 * Serves every docs page as its own markdown file at the matching path —
 * `/guides/errors.md` alongside `/guides/errors/`. This is the half of the
 * agent channel that `llms.txt` does not cover: the index says a page exists,
 * this fetches it without spending the reader's context on HTML chrome.
 *
 * Same convention Bun's docs use. The body is the original source, so code
 * fences and tables are exactly what the author wrote rather than markdown
 * reconstructed from rendered HTML.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({
    params: { slug: entry.id },
    props: { body: entry.body ?? "", title: entry.data.title },
  }));
};

export const GET: APIRoute = ({ props }) => {
  const { body, title } = props as { body: string; title: string };
  return new Response(`# ${title}\n\n${body.trim()}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
