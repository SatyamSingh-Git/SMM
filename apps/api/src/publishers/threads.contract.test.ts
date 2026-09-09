import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse } from "msw";
import { metaServer } from "./meta-stub.js";
import {
  ThreadsApiError,
  fetchPostInsights,
  listMyPosts,
  publishChain,
  publishItem,
  sanitizeTopicTag,
} from "./threads.js";

const { stub, server } = metaServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  stub.reset();
});
afterAll(() => server.close());

const USER = "9876";
const TOKEN = "TH_TOKEN";

describe("publishItem — single post", () => {
  it("creates a TEXT container then publishes it, in that order", async () => {
    const out = await publishItem(USER, TOKEN, { text: "late night thoughts" });

    expect(stub.paths()).toEqual([
      `POST /${USER}/threads`,
      `GET /id_1`,
      `POST /${USER}/threads_publish`,
    ]);
    expect(stub.params(0)).toMatchObject({
      media_type: "TEXT",
      text: "late night thoughts",
      access_token: TOKEN,
    });
    // The publish step must reference the container the create step returned.
    expect(stub.params(2).creation_id).toBe("id_1");
    expect(out.id).toBe("id_3");
  });

  it("sends media_type=IMAGE with image_url", async () => {
    await publishItem(USER, TOKEN, { text: "hi", imageUrl: "https://x.test/a.jpg" });
    expect(stub.params(0)).toMatchObject({
      media_type: "IMAGE",
      image_url: "https://x.test/a.jpg",
    });
  });

  it("sends media_type=VIDEO with video_url", async () => {
    await publishItem(USER, TOKEN, { videoUrl: "https://x.test/a.mp4" });
    expect(stub.params(0)).toMatchObject({
      media_type: "VIDEO",
      video_url: "https://x.test/a.mp4",
    });
  });

  it("passes alt_text and reply_to_id when given", async () => {
    await publishItem(USER, TOKEN, {
      text: "reply",
      imageUrl: "https://x.test/a.jpg",
      altText: "a photo",
      replyToId: "parent_1",
    });
    expect(stub.params(0)).toMatchObject({
      alt_text: "a photo",
      reply_to_id: "parent_1",
    });
  });

  it("omits optional params entirely rather than sending empty strings", async () => {
    await publishItem(USER, TOKEN, { text: "bare" });
    const p = stub.params(0);
    expect(p).not.toHaveProperty("image_url");
    expect(p).not.toHaveProperty("alt_text");
    expect(p).not.toHaveProperty("reply_to_id");
    expect(p).not.toHaveProperty("topic_tag");
  });

  it("refuses a text post with no text and no media", async () => {
    await expect(publishItem(USER, TOKEN, {})).rejects.toThrow(/requires text or media/i);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("publishItem — topic tags", () => {
  it("sanitizes the tag before sending it", async () => {
    await publishItem(USER, TOKEN, { text: "x", topicTag: "#goa.trip&vibes" });
    expect(stub.params(0).topic_tag).toBe("goatripvibes");
  });

  it("drops a tag that sanitizes to nothing", async () => {
    await publishItem(USER, TOKEN, { text: "x", topicTag: "###" });
    expect(stub.params(0)).not.toHaveProperty("topic_tag");
  });
});

describe("sanitizeTopicTag", () => {
  it.each([
    ["#goa", "goa"],
    ["##double", "double"],
    ["  spaced  ", "spaced"],
    ["a.b&c", "abc"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(sanitizeTopicTag(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "#", "."])("returns null for %s", (input) => {
    expect(sanitizeTopicTag(input)).toBeNull();
  });

  it("caps at 50 characters", () => {
    expect(sanitizeTopicTag("x".repeat(80))).toHaveLength(50);
  });
});

describe("publishItem — carousel", () => {
  const item = (n: number) => ({ imageUrl: `https://x.test/${n}.jpg` });

  it("creates each child, waits on it, then the parent, then publishes", async () => {
    await publishItem(USER, TOKEN, {
      text: "carousel",
      carouselItems: [item(1), item(2)],
    });

    expect(stub.paths()).toEqual([
      `POST /${USER}/threads`, // child 1
      `GET /id_1`,
      `POST /${USER}/threads`, // child 2
      `GET /id_3`,
      `POST /${USER}/threads`, // parent
      `GET /id_5`,
      `POST /${USER}/threads_publish`,
    ]);
    expect(stub.params(0)).toMatchObject({
      is_carousel_item: "true",
      media_type: "IMAGE",
      image_url: "https://x.test/1.jpg",
    });
    // Parent carries the text + the children CSV, and no is_carousel_item.
    expect(stub.params(4)).toMatchObject({
      media_type: "CAROUSEL",
      children: "id_1,id_3",
      text: "carousel",
    });
    expect(stub.params(4)).not.toHaveProperty("is_carousel_item");
  });

  it("marks a video child with media_type=VIDEO", async () => {
    await publishItem(USER, TOKEN, {
      carouselItems: [{ videoUrl: "https://x.test/a.mp4" }, item(2)],
    });
    expect(stub.params(0)).toMatchObject({
      media_type: "VIDEO",
      video_url: "https://x.test/a.mp4",
    });
  });

  it.each([1, 21])("rejects a carousel of %i items before calling the API", async (n) => {
    await expect(
      publishItem(USER, TOKEN, {
        carouselItems: Array.from({ length: n }, (_, i) => item(i)),
      })
    ).rejects.toThrow(/2-20 items/);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects a carousel item with no media url", async () => {
    await expect(
      publishItem(USER, TOKEN, { carouselItems: [{ altText: "no url" }, item(2)] })
    ).rejects.toThrow(/missing media url/i);
  });
});

describe("container status handling", () => {
  it("keeps polling until the container reports FINISHED", async () => {
    let polls = 0;
    stub.on((call) => {
      if (call.method !== "GET" || !call.params.fields?.includes("status")) return undefined;
      polls++;
      return { status: polls < 3 ? "IN_PROGRESS" : "FINISHED" };
    });
    await publishItem(USER, TOKEN, { text: "slow", videoUrl: "https://x.test/a.mp4" });
    expect(polls).toBe(3);
    expect(stub.count("/threads_publish")).toBe(1);
  }, 20_000);

  it("throws without publishing when the container errors", async () => {
    stub.on((call) =>
      call.method === "GET" && call.params.fields?.includes("status")
        ? { status: "ERROR" }
        : undefined
    );
    await expect(publishItem(USER, TOKEN, { text: "bad" })).rejects.toThrow(
      /ended in ERROR/
    );
    expect(stub.count("/threads_publish")).toBe(0);
  });

  it("throws on an EXPIRED container", async () => {
    stub.on((call) =>
      call.method === "GET" && call.params.fields?.includes("status")
        ? { status: "EXPIRED" }
        : undefined
    );
    await expect(publishItem(USER, TOKEN, { text: "bad" })).rejects.toThrow(
      /ended in EXPIRED/
    );
  });
});

describe("error parsing", () => {
  it("surfaces status and parsed body on an API error", async () => {
    const body = {
      error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" },
    };
    stub.failOn("/threads", 401, body);

    const err = await publishItem(USER, TOKEN, { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsApiError);
    expect(err.status).toBe(401);
    expect(err.body).toEqual(body);
    expect(err.message).toContain("401");
  });

  it("does not crash on a non-JSON error body", async () => {
    stub.on((call) =>
      call.path.endsWith("/threads") && call.method === "POST"
        ? new HttpResponse("<html>502 Bad Gateway</html>", { status: 502 })
        : undefined
    );
    const err = await publishItem(USER, TOKEN, { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsApiError);
    expect(err.status).toBe(502);
    expect(err.body).toEqual({ raw: "<html>502 Bad Gateway</html>" });
  });
});

describe("publishChain", () => {
  it("replies each item to the previous one", async () => {
    const { ids } = await publishChain(USER, TOKEN, [
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);

    expect(ids).toHaveLength(3);
    const creates = stub.calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/threads")
    );
    expect(creates[0]).toBeDefined();
    expect(creates[0]!.params).not.toHaveProperty("reply_to_id");
    expect(creates[1]!.params.reply_to_id).toBe(ids[0]);
    expect(creates[2]!.params.reply_to_id).toBe(ids[1]);
  });

  it("rejects an empty chain", async () => {
    await expect(publishChain(USER, TOKEN, [])).rejects.toThrow(/chain is empty/);
  });
});

describe("read endpoints", () => {
  it("requests posts with the expected fields and a unix `since`", async () => {
    stub.on(() => ({ data: [{ id: "p1", text: "hello" }] }));
    const since = new Date("2026-06-01T00:00:00.000Z");
    const posts = await listMyPosts(USER, TOKEN, { limit: 5, since });

    const call = stub.find("/threads", "GET");
    expect(call.params.fields).toBe("id,text,timestamp,permalink");
    expect(call.params.limit).toBe("5");
    expect(call.params.since).toBe(String(since.getTime() / 1000));
    expect(posts).toHaveLength(1);
  });

  it("returns an empty list when `data` is absent", async () => {
    stub.on(() => ({}));
    expect(await listMyPosts(USER, TOKEN)).toEqual([]);
  });

  it("maps insight metrics from both total_value and values shapes", async () => {
    stub.on(() => ({
      data: [
        { name: "views", total_value: { value: 1200 } },
        { name: "likes", values: [{ value: 34 }] },
        { name: "replies", total_value: { value: 5 } },
        { name: "unknown_metric", total_value: { value: 9 } },
      ],
    }));
    const insights = await fetchPostInsights("thread_1", TOKEN);
    expect(insights.views).toBe(1200);
    expect(insights.likes).toBe(34);
    expect(insights.replies).toBe(5);
    expect(insights.reposts).toBeUndefined();
  });
});
